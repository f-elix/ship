import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import {
	Checks,
	ConfigLoader,
	Git,
	Locks,
	Pr,
	Reviewers,
	ShipHome,
	shipPaths,
	ShipRpcs,
	type Agent,
	type Gh,
	type ShipPaths
} from '@ship/core';
import { RunStore } from '@ship/store';
import { Context, Deferred, Effect, FileSystem, Layer, Schedule, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { HttpRouter } from 'effect/http';
import { RpcSerialization, RpcServer } from 'effect/rpc';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { DaemonControl, handlers } from './handlers.ts';
import { RPC_PATH } from './protocol.ts';
import { RunHost } from './run-host.ts';

export interface DaemonOptions {
	/** Ship's home directory; see `shipHomeDir`. */
	readonly home: string;
	/** The daemon's version; a client with another version fails the handshake. */
	readonly version: string;
	/**
	 * The services that reach outside the machine. Production passes the real Agent SDK and
	 * `gh` layers ({@link productionServices}); tests pass fakes.
	 */
	readonly services: Layer.Layer<Agent | Gh>;
}

/** Another daemon is listening on the socket. */
export class DaemonAlreadyRunning extends Schema.TaggedError<DaemonAlreadyRunning>()(
	'DaemonAlreadyRunning',
	{ socket: Schema.String }
) {
	override get message(): string {
		return `A ship daemon is already listening on ${this.socket}`;
	}
}

export interface DaemonHandle {
	readonly paths: ShipPaths;
	/** Completes when a `stop` request asks the daemon to shut down. */
	readonly stopRequested: Effect.Effect<void>;
}

/** Whether something accepts connections on the unix socket at `path`. */
const isListening = (path: string) =>
	Effect.callback<boolean>((resume) => {
		const socket = connect(path);
		socket.once('connect', () => {
			socket.destroy();
			resume(Effect.succeed(true));
		});
		socket.once('error', () => resume(Effect.succeed(false)));
		return Effect.sync(() => socket.destroy());
	});

/** Whether something listens on the socket within a few seconds. */
const listensSoon = (path: string) =>
	isListening(path).pipe(
		Effect.filterOrFail(
			(listening) => listening,
			() => 'not listening' as const
		),
		Effect.retry({ schedule: Schedule.spaced('50 millis'), times: 100 }),
		Effect.orElseSucceed(() => false)
	);

/** Whether a process with this id exists (`EPERM`: it does, under another user). */
const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && 'code' in error && error.code === 'EPERM';
	}
};

/** The pid in a pid file, or `null` when it holds none. */
const pidIn = (text: string): number | null => {
	const pid = Number(text.trim());
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Makes this process the owner of ship's home, before it touches the run store or the
 * socket. The pid file is the lock. It is written to a file of this process's own, then
 * hard-linked into place, which is atomic and fails when the file exists, so of two daemons
 * starting at once only one gets it, and it never holds a partial pid. A pid file whose
 * process is gone, or never listens on the socket, was left by a daemon that died: it is
 * moved aside (atomic too) and replaced.
 * The pid file is removed when the scope closes, if it is still this process's.
 */
const claimHome = Effect.fnUntraced(function* (paths: ShipPaths) {
	const fs = yield* FileSystem.FileSystem;
	const running = new DaemonAlreadyRunning({ socket: paths.socket });
	const content = `${process.pid}\n`;
	const mine = `${paths.pidFile}.${process.pid}`;
	const aside = `${paths.pidFile}.${process.pid}.stale`;
	/** Whether `effect` succeeded, `false` when it failed with `tag`. */
	const succeeds = (
		effect: Effect.Effect<unknown, PlatformError>,
		tag: 'AlreadyExists' | 'NotFound'
	) =>
		effect.pipe(
			Effect.as(true),
			Effect.catchTag('PlatformError', (error) =>
				error.reason._tag === tag ? Effect.succeed(false) : Effect.fail(error)
			)
		);
	/** The file's content, or `null` when it is gone. */
	const read = (path: string) =>
		fs.readFileString(path).pipe(
			Effect.map((text): string | null => text),
			Effect.catchTag('PlatformError', (error) =>
				error.reason._tag === 'NotFound' ? Effect.succeed(null) : Effect.fail(error)
			)
		);

	yield* fs.writeFileString(mine, content);
	const linked = yield* Effect.ensuring(
		Effect.gen(function* () {
			for (let attempt = 0; attempt < 3; attempt++) {
				if (yield* succeeds(fs.link(mine, paths.pidFile), 'AlreadyExists')) return true;
				const owner = yield* read(paths.pidFile);
				if (owner === null) continue;
				const pid = pidIn(owner);
				// Pids are reused (after a reboot, say), so a live process is taken for the
				// owner only if the socket listens, given time to start listening.
				if (pid !== null && isAlive(pid) && (yield* listensSoon(paths.socket))) {
					return false;
				}
				// Taken over only if no other daemon replaced it since it was read.
				if (!(yield* succeeds(fs.rename(paths.pidFile, aside), 'NotFound'))) continue;
				const moved = yield* read(aside);
				if (moved !== owner) {
					// Another daemon's fresh claim: put it back.
					yield* fs.link(aside, paths.pidFile).pipe(Effect.ignore);
					yield* fs.remove(aside, { force: true });
					return false;
				}
				yield* Effect.logInfo(`Removed the stale pid file ${paths.pidFile}`);
				yield* fs.remove(aside, { force: true });
			}
			return false;
		}),
		fs.remove(mine, { force: true }).pipe(Effect.ignore({ log: true }))
	);
	if (!linked) return yield* running;
	yield* Effect.addFinalizer(() =>
		read(paths.pidFile).pipe(
			Effect.flatMap((owner) =>
				owner === content ? fs.remove(paths.pidFile, { force: true }) : Effect.void
			),
			Effect.ignore({ log: true })
		)
	);

	// Only the owner touches the socket. One still listening belongs to a daemon whose pid
	// file was deleted; one nobody listens on was left behind.
	if (yield* fs.exists(paths.socket)) {
		if (yield* isListening(paths.socket)) return yield* running;
		yield* Effect.logInfo(`Removing the stale socket ${paths.socket}`);
		yield* fs.remove(paths.socket, { force: true });
	}
});

/** Everything the handlers and the runs use, built once per daemon. */
const daemonServices = (options: DaemonOptions, paths: ShipPaths) => {
	const platform = NodeServices.layer;
	const config = ConfigLoader.layer(options.home).pipe(Layer.provide(platform));
	// Permits are read once, at start; `ship daemon restart` applies config edits.
	const locks = Layer.unwrap(
		Effect.gen(function* () {
			const loader = yield* ConfigLoader;
			return Locks.layer((yield* loader.loadGlobal).locks);
		})
	).pipe(Layer.provide(config));
	const store = RunStore.layerFile(paths.db);
	const external = options.services;
	const git = Git.layer.pipe(Layer.provide(platform));
	const pipeline = Layer.mergeAll(
		git,
		locks,
		external,
		ShipHome.layer(options.home),
		Checks.layer.pipe(Layer.provide([locks, platform])),
		Reviewers.layer.pipe(Layer.provide([git, external, platform])),
		Pr.layer.pipe(Layer.provide(external)),
		RunStore.journal.pipe(Layer.provide(store))
	);
	const host = RunHost.layer.pipe(Layer.provide([pipeline, store]));
	return Layer.mergeAll(platform, config, store, pipeline, host);
};

/** The RPC server on the daemon's socket: Effect RPC over HTTP, ndjson-encoded. */
const rpcServer = (socket: string) =>
	HttpRouter.serve(
		RpcServer.layer(ShipRpcs).pipe(
			Layer.provide(handlers),
			Layer.provide(RpcServer.layerProtocolHttp({ path: RPC_PATH })),
			Layer.provide(RpcSerialization.layerNdjson)
		),
		{ disableLogger: true }
	).pipe(
		Layer.provide(
			NodeHttpServer.layer(createServer, {
				path: socket,
				gracefulShutdownTimeout: '2 seconds'
			})
		)
	);

/**
 * Starts the daemon in the caller's scope and returns once it listens. Closing the scope
 * shuts it down, as a forced `stop` does: active runs are interrupted and marked
 * `interrupted`, the server closes, then the socket and pid files are removed. Fails with
 * `DaemonAlreadyRunning` when another daemon owns the home.
 *
 * On start, runs a previous daemon left `running` are marked `interrupted`; they are never
 * resumed on their own.
 */
export const startDaemon = Effect.fn('startDaemon')(function* (options: DaemonOptions) {
	const paths = shipPaths(options.home);
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(paths.runs, { recursive: true });
	yield* claimHome(paths);

	const services = yield* Layer.build(daemonServices(options, paths));
	const store = Context.get(services, RunStore);
	const host = Context.get(services, RunHost);
	const interrupted = yield* store.markInterrupted;
	if (interrupted.length > 0) {
		yield* Effect.logInfo(`Marked ${interrupted.length} unfinished runs interrupted`);
	}

	const shutdown = yield* Deferred.make<void>();
	const control = Layer.succeed(DaemonControl, { version: options.version, shutdown });
	yield* Layer.build(
		rpcServer(paths.socket).pipe(Layer.provide([control, Layer.succeedContext(services)]))
	);
	// Added once this daemon listens, so one that failed to never removes another's socket.
	yield* Effect.addFinalizer(() =>
		fs.remove(paths.socket, { force: true }).pipe(Effect.ignore({ log: true }))
	);
	// Runs before the server closes, so event streams end with `RunInterrupted`.
	yield* Effect.addFinalizer(() =>
		Effect.andThen(host.shutdown, store.markInterrupted).pipe(
			Effect.tap((ids) =>
				ids.length > 0 ? Effect.logInfo(`Interrupted ${ids.length} runs`) : Effect.void
			)
		)
	);
	yield* Effect.logInfo(`ship daemon ${options.version} listening on ${paths.socket}`);

	return { paths, stopRequested: Deferred.await(shutdown) } satisfies DaemonHandle;
});

/** Runs the daemon until a `stop` request, or until interrupted (e.g. by SIGTERM). */
export const serveDaemon = (options: DaemonOptions) =>
	Effect.scoped(Effect.flatMap(startDaemon(options), (daemon) => daemon.stopRequested));
