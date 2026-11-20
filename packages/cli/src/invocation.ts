import type { Env } from '@ship/core/contract';
import { processEnv, shipHomeDir } from '@ship/daemon/client';
import { Context, Effect, Layer, Schema } from 'effect';
import { resolve } from 'node:path';

/** What this `ship` invocation runs with: its version, home, cwd and env. */
export class Invocation extends Context.Service<
	Invocation,
	{
		/** The CLI's version; the daemon must have the same one. */
		readonly version: string;
		/** Ship's home directory; see `shipHomeDir`. */
		readonly home: string;
		/** Sent with `run`: the run works in this directory. */
		readonly cwd: string;
		/** Sent with `run` and `resume`: checks and agents run with this env. */
		readonly env: Env;
	}
>()('@f-elix/ship/Invocation') {
	/**
	 * The current process's cwd and env, with `SHIP_HOME` or `~/.ship` as the home. A relative
	 * `SHIP_HOME` is resolved against the cwd, so the daemon, which runs elsewhere, uses the
	 * same directory.
	 */
	static readonly fromProcess = (version: string) =>
		Layer.effect(
			this,
			Effect.gen(function* () {
				const home = resolve(yield* shipHomeDir);
				return { version, home, cwd: process.cwd(), env: processEnv() };
			})
		);
}

/** The daemon process could not be spawned. */
export class DaemonSpawnFailed extends Schema.TaggedError<DaemonSpawnFailed>()(
	'DaemonSpawnFailed',
	{ detail: Schema.String }
) {}

/** Starts a daemon process in the background; the CLI then waits for it to answer. */
export class DaemonLauncher extends Context.Service<
	DaemonLauncher,
	{
		/** Spawns a detached daemon for `home` and returns without waiting for it. */
		readonly launch: (options: {
			readonly home: string;
			readonly env: Env;
		}) => Effect.Effect<void, DaemonSpawnFailed>;
	}
>()('@f-elix/ship/DaemonLauncher') {}
