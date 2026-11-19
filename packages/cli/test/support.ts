import { NodeServices } from '@effect/platform-node';
import { DAEMON_PROCESS_SCRIPT, VERSION } from '@ship/daemon/testing';
import { Console, Duration, Effect, Layer, Terminal } from 'effect';
import { spawn, type ChildProcess } from 'node:child_process';
import { DaemonTimeouts } from '../src/connection.ts';
import { DaemonLauncher, Invocation } from '../src/invocation.ts';
import { runCli } from '../src/main.ts';

export interface CliResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Output lines as a command writes them, so a test can watch a command still running. */
export interface Captured {
	readonly stdout: Array<string>;
	readonly stderr: Array<string>;
}

export interface CliOptions {
	readonly home: string;
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	/** Default: the test daemons' version. */
	readonly version?: string;
	/** Default: a launcher that fails the test, so no real daemon is ever spawned. */
	readonly launcher?: DaemonLauncher['Service'];
	/** Default: fresh arrays. */
	readonly captured?: Captured;
	/** Default: {@link testTimeouts}. */
	readonly timeouts?: (typeof DaemonTimeouts)['Service'];
	/** Default: the process's terminal. Prompts read from it. */
	readonly terminal?: Terminal.Terminal;
}

const noLauncher: DaemonLauncher['Service'] = {
	launch: () => Effect.die(new Error('this test expects a running daemon'))
};

/** Shorter waits than the defaults, so a daemon that never answers fails a test sooner. */
export const testTimeouts = {
	start: Duration.seconds(10),
	handshake: Duration.seconds(5),
	stop: Duration.seconds(15)
};

/** A Console whose `log` (stdout) and `error` (stderr) lines go to `captured`. */
const capturingConsole = (captured: Captured): Console.Console => ({
	...globalThis.console,
	log: (...args: ReadonlyArray<unknown>) => captured.stdout.push(args.map(String).join(' ')),
	error: (...args: ReadonlyArray<unknown>) => captured.stderr.push(args.map(String).join(' '))
});

/** Runs `ship <args>` in this process and returns its exit code and output. */
export const cli = (args: ReadonlyArray<string>, options: CliOptions) => {
	const captured = options.captured ?? { stdout: [], stderr: [] };
	return runCli(args).pipe(
		Effect.map((code): CliResult => ({
			code,
			stdout: captured.stdout.join('\n'),
			stderr: captured.stderr.join('\n')
		})),
		Effect.provideService(Console.Console, capturingConsole(captured)),
		Effect.provideService(DaemonTimeouts, options.timeouts ?? testTimeouts),
		options.terminal === undefined
			? (effect) => effect
			: Effect.provideService(Terminal.Terminal, options.terminal),
		Effect.provide(
			Layer.mergeAll(
				NodeServices.layer,
				Layer.succeed(DaemonLauncher, options.launcher ?? noLauncher),
				Layer.succeed(Invocation, {
					version: options.version ?? VERSION,
					home: options.home,
					cwd: options.cwd ?? process.cwd(),
					env: options.env ?? {}
				})
			)
		)
	);
};

/**
 * A launcher that spawns the daemon on fakes from `@ship/daemon/testing` (its implementer
 * never ends) instead of `ship daemon serve`. Every daemon it spawned is killed when the
 * scope closes; `launched` counts them.
 */
export const fakeDaemonLauncher = (version = VERSION) =>
	Effect.gen(function* () {
		const children: Array<ChildProcess> = [];
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				for (const child of children) child.kill('SIGKILL');
			})
		);
		const launcher: DaemonLauncher['Service'] = {
			launch: ({ home }) =>
				Effect.sync(() => {
					children.push(
						spawn(process.execPath, [DAEMON_PROCESS_SCRIPT, version], {
							env: { ...process.env, SHIP_HOME: home },
							stdio: 'ignore'
						})
					);
				})
		};
		return { launcher, launched: () => children.length };
	});
