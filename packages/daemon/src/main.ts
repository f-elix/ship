import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Agent, Gh, shipPaths } from '@ship/core';
import { Effect, FileSystem, Layer, Logger } from 'effect';
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
			// Another failure is reported by `runMain` on stdout, which the CLI, like stderr,
			// points at the same log file.
			yield* serveDaemon({ home, version, services: productionServices }).pipe(
				// Two commands auto-started a daemon at once and the other one won: not an error.
				Effect.catchTag('DaemonAlreadyRunning', (error) => Effect.logInfo(error.message)),
				Effect.provide(logger)
			);
		}).pipe(Effect.provide(NodeServices.layer))
	);
