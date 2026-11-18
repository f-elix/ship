import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Agent, Gh, shipPaths } from '@ship/core';
import { Cause, Effect, FileSystem, Layer, Logger } from 'effect';
import { serveDaemon } from './daemon.ts';
import { shipHomeDir } from './home.ts';

/** The real Agent SDK and `gh`. */
export const productionServices: Layer.Layer<Agent | Gh> = Layer.mergeAll(
	Agent.layer,
	Gh.layer
).pipe(Layer.provide(NodeServices.layer));

/**
 * The daemon process: serves on `<home>/daemon.sock` and logs to `<home>/daemon.log` until
 * a `stop` request, SIGTERM or SIGINT, each of which shuts it down the same way. The CLI
 * spawns it detached.
 */
export const runDaemon = (version: string): void =>
	NodeRuntime.runMain(
		Effect.gen(function* () {
			const home = yield* shipHomeDir;
			const fs = yield* FileSystem.FileSystem;
			yield* fs.makeDirectory(home, { recursive: true });
			const logger = Logger.layer([
				Logger.toFile(Logger.formatLogFmt, shipPaths(home).daemonLog)
			]);
			yield* serveDaemon({ home, version, services: productionServices }).pipe(
				// A daemon that fails to start says why in its log too: it has no terminal.
				Effect.tapCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.void
						: Effect.logError('ship daemon failed', cause)
				),
				Effect.provide(logger)
			);
		}).pipe(Effect.provide(NodeServices.layer))
	);
