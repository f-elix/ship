import { shipPaths, type ShipPaths, type VersionMismatch } from '@ship/core/contract';
import { DaemonClient, daemonRunning, isListening } from '@ship/daemon/client';
import { Context, Duration, Effect, Layer, Schedule, Schema } from 'effect';
import { DaemonLauncher, Invocation } from './invocation.ts';

/** A failure the CLI reports as `ship: <message>` on stderr, exiting 1. */
export class ShipCliError extends Schema.TaggedError<ShipCliError>()('ShipCliError', {
	message: Schema.String
}) {}

export const cliError = (message: string) => new ShipCliError({ message });

export type Rpc = DaemonClient['Service'];

/** A daemon that answered the handshake. */
export interface Connection {
	readonly rpc: Rpc;
	readonly paths: ShipPaths;
	readonly daemonVersion: string;
	readonly activeRuns: number;
	/** Set when the daemon's version differs and the caller allowed it. */
	readonly mismatch: VersionMismatch | null;
}

/** How long the CLI waits on the daemon. Tests shorten them. */
export class DaemonTimeouts extends Context.Reference<{
	/** For a spawned daemon to answer its first handshake. */
	readonly start: Duration.Duration;
	/** For a listening daemon to answer a handshake. */
	readonly handshake: Duration.Duration;
	/** For a stopping daemon to finish its runs and exit. */
	readonly stop: Duration.Duration;
}>('@f-elix/ship/DaemonTimeouts', {
	defaultValue: () => ({
		start: Duration.seconds(15),
		handshake: Duration.seconds(10),
		stop: Duration.seconds(30)
	})
}) {}

const poll = Schedule.spaced('100 millis');

/** How many runs are active, and that `--force` would interrupt them. */
const activeRunsRefusal = (count: number, refused: string) =>
	`${count} ${count === 1 ? 'run is' : 'runs are'} active: ${refused} until they finish, unless you pass --force, which interrupts them (\`ship resume <id>\` continues them).`;

export const mismatchMessage = (error: VersionMismatch): string => {
	const runs =
		error.activeRuns === 0
			? 'No runs are active.'
			: activeRunsRefusal(error.activeRuns, 'the restart is refused');
	return `this ship is ${error.clientVersion} but the running daemon is ${error.daemonVersion}. Run \`ship daemon restart\` to switch the daemon to ${error.clientVersion}. ${runs}`;
};

/** Builds an RPC client of the daemon at `paths`, closed with the current scope. */
const rpcClient = (paths: ShipPaths) =>
	Effect.map(Layer.build(DaemonClient.layer(paths.socket)), (context) =>
		Context.get(context, DaemonClient)
	);

const handshake = (rpc: Rpc, paths: ShipPaths, version: string, allowMismatch: boolean) =>
	rpc.handshake({ version }).pipe(
		Effect.map((answer): Omit<Connection, 'rpc' | 'paths'> => ({
			daemonVersion: answer.version,
			activeRuns: answer.activeRuns,
			mismatch: null
		})),
		Effect.catchTag('VersionMismatch', (error) =>
			allowMismatch
				? Effect.succeed({
						daemonVersion: error.daemonVersion,
						activeRuns: error.activeRuns,
						mismatch: error
					})
				: Effect.fail(cliError(mismatchMessage(error)))
		),
		Effect.map((answer): Connection => ({ rpc, paths, ...answer }))
	);

/** Spawns a daemon and waits until it answers the handshake. */
const start = Effect.fnUntraced(function* (paths: ShipPaths, allowMismatch: boolean) {
	const invocation = yield* Invocation;
	const launcher = yield* DaemonLauncher;
	yield* launcher
		.launch({ home: invocation.home, env: invocation.env })
		.pipe(
			Effect.mapError((error) => cliError(`could not start the ship daemon: ${error.detail}`))
		);
	const timeouts = yield* DaemonTimeouts;
	const rpc = yield* rpcClient(paths);
	return yield* handshake(rpc, paths, invocation.version, allowMismatch).pipe(
		// Until it listens, the handshake fails to connect.
		Effect.retry({
			while: (error) => error._tag === 'RpcClientError',
			schedule: poll
		}),
		Effect.timeoutOrElse({
			duration: timeouts.start,
			orElse: () =>
				Effect.fail(
					cliError(
						`the ship daemon did not answer within ${Duration.format(timeouts.start)}; see ${paths.daemonLog}`
					)
				)
		}),
		// Never reached: connection errors are retried until the timeout. A daemon that crashes
		// on start is reported by the timeout too, whose message points at its log.
		Effect.catchTag('RpcClientError', Effect.die)
	);
});

export interface ConnectOptions {
	/** Accept a daemon of another version instead of failing. Default `false`. */
	readonly allowMismatch?: boolean;
}

/** Handshakes with the daemon listening on the socket. */
const attach = Effect.fnUntraced(function* (paths: ShipPaths, allowMismatch: boolean) {
	const invocation = yield* Invocation;
	const timeouts = yield* DaemonTimeouts;
	const rpc = yield* rpcClient(paths);
	return yield* handshake(rpc, paths, invocation.version, allowMismatch).pipe(
		Effect.timeoutOrElse({
			duration: timeouts.handshake,
			orElse: () =>
				Effect.fail(
					cliError(
						`the ship daemon listens on ${paths.socket} but did not answer within ${Duration.format(timeouts.handshake)}; see ${paths.daemonLog}`
					)
				)
		}),
		Effect.catchTag('RpcClientError', (error) =>
			Effect.fail(
				cliError(`the ship daemon did not answer: ${error.message}; see ${paths.daemonLog}`)
			)
		)
	);
});

/**
 * Connects to the daemon in the invocation's home and runs the version handshake, for the
 * current scope. When nothing listens on the socket, a daemon is spawned and given time to
 * answer. A daemon of another version fails with a message that says to restart it, unless
 * `allowMismatch` is set.
 */
export const connectDaemon = Effect.fnUntraced(function* (options: ConnectOptions = {}) {
	const paths = shipPaths((yield* Invocation).home);
	const allowMismatch = options.allowMismatch === true;
	return yield* (yield* isListening(paths.socket))
		? attach(paths, allowMismatch)
		: start(paths, allowMismatch);
});

/** Like {@link connectDaemon}, but `null` instead of spawning when no daemon listens. */
export const findDaemon = Effect.fnUntraced(function* (options: ConnectOptions = {}) {
	const paths = shipPaths((yield* Invocation).home);
	if (!(yield* isListening(paths.socket))) return null;
	return yield* attach(paths, options.allowMismatch === true);
});

/** Spawns a daemon, which must not be running, and waits until it answers. */
export const launchDaemon = Effect.fnUntraced(function* () {
	return yield* start(shipPaths((yield* Invocation).home), false);
});

/**
 * Asks the daemon to stop and waits until it has exited: its pid file is gone and nothing
 * listens on its socket. Refused while runs are active, unless `force`.
 */
export const stopDaemon = Effect.fnUntraced(function* (connection: Connection, force: boolean) {
	const { paths } = connection;
	const timeouts = yield* DaemonTimeouts;
	yield* connection.rpc.stop(force ? { force } : {}).pipe(
		Effect.catchTag('DaemonBusy', (error) =>
			Effect.fail(cliError(activeRunsRefusal(error.activeRuns, 'the daemon is not stopped')))
		),
		// The daemon may close the connection while it shuts down; waiting tells if it stopped.
		Effect.catchTag('RpcClientError', () => Effect.void)
	);
	yield* daemonRunning(paths).pipe(
		Effect.repeat({ while: (running) => running, schedule: poll }),
		Effect.timeoutOrElse({
			duration: timeouts.stop,
			orElse: () =>
				Effect.fail(
					cliError(
						`the ship daemon did not exit within ${Duration.format(timeouts.stop)}; see ${paths.daemonLog}`
					)
				)
		})
	);
});
