import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { shipPaths } from '@ship/core';
import { readDaemonPid } from '@ship/daemon';
import { client, daemonProcess, eventually, fixture, tempDir } from '@ship/daemon/testing';
import { Effect } from 'effect';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const TIMEOUT = 60_000;
const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

/** `ship <args>` in a child process; resolves when it exits. Killed when the scope closes. */
const shipProcess = (
	args: ReadonlyArray<string>,
	options: { cwd: string; env: NodeJS.ProcessEnv }
) =>
	Effect.gen(function* () {
		const child = yield* Effect.acquireRelease(
			Effect.sync(() =>
				spawn(process.execPath, [BIN, ...args], {
					cwd: options.cwd,
					env: options.env,
					stdio: ['ignore', 'pipe', 'pipe']
				})
			),
			(child) => Effect.sync(() => child.kill('SIGKILL'))
		);
		const output = { stdout: '', stderr: '' };
		child.stdout.on('data', (chunk: Buffer) => (output.stdout += chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => (output.stderr += chunk.toString()));
		const exited = Effect.callback<number | null>((resume) => {
			if (child.exitCode !== null) resume(Effect.succeed(child.exitCode));
			child.once('close', (code) => resume(Effect.succeed(code)));
		});
		return { child, output, exited };
	});

describe('the ship process', () => {
	it.live(
		'Ctrl-C detaches from the run with exit code 130 and leaves it running',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				// Its version matches the CLI's, so the CLI uses it instead of spawning one.
				yield* daemonProcess(fx.home, pkg.version);
				const ship = yield* shipProcess(['run', fx.planDir], {
					cwd: fx.work,
					env: { ...fx.env, SHIP_HOME: fx.home }
				});
				const rpc = yield* client(fx.home);
				yield* eventually(
					Effect.map(rpc.list({}), (runs) => runs[0]?.state === 'implement')
				);
				yield* eventually(Effect.sync(() => ship.output.stderr.includes(' started')));

				ship.child.kill('SIGINT');

				expect(yield* ship.exited).toBe(130);
				expect(ship.output.stdout).toBe('');
				const [run] = yield* rpc.list({});
				expect(run?.status).toBe('running');
				expect(ship.output.stderr).toContain(
					`ship: detached from run ${run?.runId}; it keeps running.\n`
				);
				expect(ship.output.stderr).toContain(`cancel it: ship cancel ${run?.runId}\n`);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'spawns `ship daemon serve` when no daemon runs, then stops it',
		() =>
			Effect.gen(function* () {
				const home = join(yield* tempDir, 'home');
				const paths = shipPaths(home);
				const env = { ...process.env, SHIP_HOME: home };
				// The daemon is detached: kill it if the test fails before stopping it.
				yield* Effect.addFinalizer(() =>
					readDaemonPid(paths).pipe(
						Effect.flatMap((pid) =>
							Effect.try(() => {
								if (pid !== null) process.kill(pid, 'SIGKILL');
							})
						),
						Effect.ignore,
						Effect.provide(NodeServices.layer)
					)
				);

				const status = yield* shipProcess(['daemon', 'status'], {
					cwd: process.cwd(),
					env
				});
				expect(yield* status.exited).toBe(0);
				expect(status.output.stdout).toContain(`ship daemon ${pkg.version} (pid `);
				expect(existsSync(paths.pidFile)).toBe(true);

				const stop = yield* shipProcess(['daemon', 'stop'], { cwd: process.cwd(), env });
				expect(yield* stop.exited).toBe(0);
				expect(stop.output.stderr).toBe('ship: daemon stopped\n');
				expect(existsSync(paths.pidFile)).toBe(false);
				expect(existsSync(paths.socket)).toBe(false);
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});
