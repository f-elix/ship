import { shipPaths } from '@ship/core/contract';
import { Effect, Layer } from 'effect';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { DaemonLauncher, DaemonSpawnFailed } from './invocation.ts';

/**
 * Launches `ship daemon serve` from the entry this CLI runs (`binPath`, e.g. the installed
 * `dist/bin.mjs`) with this Node binary, so the daemon is always the same build as the CLI.
 * It runs detached in its own process group, with stdout and stderr appended to
 * `daemon.log`, so it outlives the CLI and Ctrl-C in the terminal never reaches it.
 */
export const spawnDaemonLayer = (binPath: string) =>
	Layer.succeed(DaemonLauncher, {
		launch: ({ home, env }) =>
			Effect.try({
				try: () => {
					const paths = shipPaths(home);
					mkdirSync(home, { recursive: true });
					const log = openSync(paths.daemonLog, 'a');
					try {
						const child = spawn(process.execPath, [binPath, 'daemon', 'serve'], {
							detached: true,
							// Not the cwd of the command that started it, which it would hold on to.
							cwd: home,
							stdio: ['ignore', log, log],
							env: { ...env, SHIP_HOME: home }
						});
						// A spawn that fails later never answers the handshake, which reports it.
						child.on('error', () => {});
						child.unref();
					} finally {
						closeSync(log);
					}
				},
				catch: (cause) =>
					new DaemonSpawnFailed({
						detail: cause instanceof Error ? cause.message : String(cause)
					})
			})
	});
