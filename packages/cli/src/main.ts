import { NodeServices } from '@effect/platform-node';
import { shipPaths } from '@ship/core/contract';
import { Cause, Console, Effect, Exit, Layer, Ref } from 'effect';
import { CliConfig, CliError, CliOutput, Command, GlobalFlag } from 'effect/cli';
import { ship } from './commands.ts';
import { ExitCode } from './exit-code.ts';
import { Invocation } from './invocation.ts';
import { DETACHED_EXIT_CODE } from './render.ts';
import { spawnDaemonLayer } from './spawn-daemon.ts';

/**
 * Help and parse errors as effect/cli prints them, but `--version` prints the bare version,
 * and the only global flags are `--help` and `--version`.
 */
const cliOutput = Layer.mergeAll(
	CliOutput.layer({
		...CliOutput.defaultFormatter({ colors: process.stdout.isTTY === true }),
		formatVersion: (_name, version) => version
	}),
	CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] })
);

/**
 * Runs `ship` with `args` (without the node and script paths) and returns the exit code.
 * Failures are reported on stderr here: `ship: <message>`. Interrupting it (Ctrl-C) is not
 * caught: `ship run` detaches, and {@link main} exits with {@link DETACHED_EXIT_CODE}.
 */
export const runCli = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const invocation = yield* Invocation;
		const exitCode = yield* Ref.make(0);
		return yield* Command.runWith(ship, { version: invocation.version })(args).pipe(
			Effect.provideService(ExitCode, exitCode),
			Effect.andThen(Ref.get(exitCode)),
			Effect.catch((error) => {
				// effect/cli already printed help and the parse errors.
				if (CliError.isCliError(error)) return Effect.succeed(1);
				const message =
					error._tag === 'ShipCliError'
						? error.message
						: error._tag === 'RpcClientError'
							? `lost the connection to the ship daemon (${error.message}); see ${shipPaths(invocation.home).daemonLog}`
							: String(error);
				return Effect.as(Console.error(`ship: ${message}`), 1);
			}),
			Effect.catchDefect((defect) =>
				Effect.as(
					Console.error(`ship: unexpected error\n${Cause.pretty(Cause.die(defect))}`),
					1
				)
			)
		);
	}).pipe(Effect.provide(cliOutput));

export interface MainOptions {
	readonly version: string;
	/** The script this process runs, which `ship daemon serve` is spawned from. */
	readonly binPath: string;
	readonly args: ReadonlyArray<string>;
}

/**
 * The CLI process. SIGINT and SIGTERM interrupt the command, which for `ship run` and
 * `ship resume` detaches from the run. The exit code is set rather than forced, so output
 * still buffered for a pipe is written before the process exits.
 */
export const main = (options: MainOptions): void => {
	const layer = Layer.mergeAll(
		NodeServices.layer,
		Invocation.fromProcess(options.version),
		spawnDaemonLayer(options.binPath)
	);
	const fiber = Effect.runFork(runCli(options.args).pipe(Effect.provide(layer)));
	const onSignal = () => fiber.interruptUnsafe(fiber.id);
	process.once('SIGINT', onSignal);
	process.once('SIGTERM', onSignal);
	fiber.addObserver((exit) => {
		process.removeListener('SIGINT', onSignal);
		process.removeListener('SIGTERM', onSignal);
		if (Exit.isSuccess(exit)) {
			process.exitCode = exit.value;
		} else if (Cause.hasInterruptsOnly(exit.cause)) {
			process.exitCode = DETACHED_EXIT_CODE;
		} else {
			process.stderr.write(`ship: unexpected error\n${Cause.pretty(exit.cause)}\n`);
			process.exitCode = 1;
		}
	});
};
