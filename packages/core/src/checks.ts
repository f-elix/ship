import { Clock, Context, DateTime, Effect, Layer, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import type { Check } from './config.ts';
import type { RunEvent } from './event.ts';
import type { ChangedFile } from './git.ts';
import { LockEvent, Locks, type UnknownLockResource } from './locks.ts';
import type { Env } from './primitives.ts';
import { DEFAULT_OUTPUT_TAIL, execTail, type OutputTailLimits } from './process.ts';
import type { CheckResult, CheckRound } from './run.ts';

// --- Public types ---

/** The events a check pass produces, ready to append to the run's log. */
export type CheckEvent = Extract<
	RunEvent,
	{
		readonly _tag:
			'CheckStarted' | 'CheckFinished' | 'LockWaiting' | 'LockAcquired' | 'LockReleased';
	}
>;

/** Which pass this is; copied into every event and the returned `CheckRound`. */
export interface CheckPass {
	readonly baseline: boolean;
	readonly round: number;
	readonly attempt: number;
}

export interface RunChecksInput {
	readonly cwd: string;
	/** The caller's environment; the daemon's is never used. */
	readonly env: Env;
	readonly checks: ReadonlyArray<Check>;
	/** Repo-relative changed files for `{files}`; see {@link filesForChecks}. */
	readonly files: ReadonlyArray<string>;
	/** Each check's `fix` command runs just before it, except on the baseline pass. */
	readonly pass: CheckPass;
	readonly onEvent?: (event: CheckEvent) => Effect.Effect<void>;
}

export interface FormatInput {
	readonly cwd: string;
	readonly env: Env;
	/** The project's `format` command. */
	readonly command: string;
	readonly files: ReadonlyArray<string>;
}

export interface CommandResult {
	readonly commandLine: string;
	readonly exitCode: number;
	readonly durationMs: number;
	readonly outputTail: string;
}

/** A shell command could not be started, e.g. because `cwd` does not exist. */
export class CheckSpawnError extends Schema.TaggedError<CheckSpawnError>()('CheckSpawnError', {
	commandLine: Schema.String,
	cwd: Schema.String,
	detail: Schema.String
}) {}

export interface ChecksShape {
	/**
	 * Runs the checks one after another, in config order, each holding a permit of its lock
	 * resource only while its commands run. Every check runs even after one fails, so the
	 * fixer sees all failures. A check whose command uses `{files}` is skipped when no
	 * files changed and is left out of the result.
	 */
	readonly run: (
		input: RunChecksInput
	) => Effect.Effect<CheckRound, CheckSpawnError | UnknownLockResource>;
	/**
	 * Runs the project's `format` command, without a lock. Returns `null` when the command
	 * uses `{files}` and no files changed.
	 */
	readonly format: (input: FormatInput) => Effect.Effect<CommandResult | null, CheckSpawnError>;
}

/** One shell command as the checks runner starts it. */
export interface ShellCommand {
	readonly commandLine: string;
	readonly cwd: string;
	readonly env: Env;
	/** The check it belongs to; `null` for the format command. */
	readonly check: string | null;
	readonly kind: 'run' | 'fix' | 'format';
}

/** Runs a shell command and returns its exit code and output tail. */
export type ShellExecutor = (
	command: ShellCommand
) => Effect.Effect<{ readonly exitCode: number; readonly outputTail: string }, CheckSpawnError>;

// --- Helpers ---

const FILES_PLACEHOLDER = '{files}';

/** Quotes `word` for a POSIX shell. */
export const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Replaces every `{files}` in `command` with the shell-quoted files. Returns `null` when
 * the command uses `{files}` and there are none, meaning the command should be skipped.
 * A file starting with `-` gets a `./` prefix so it is never read as an option.
 */
export const expandFiles = (command: string, files: ReadonlyArray<string>): string | null => {
	if (!command.includes(FILES_PLACEHOLDER)) return command;
	if (files.length === 0) return null;
	const quoted = files
		.map((file) => shellQuote(file.startsWith('-') ? `./${file}` : file))
		.join(' ');
	return command.replaceAll(FILES_PLACEHOLDER, quoted);
};

/** The changed files a `{files}` command can be given: every one that still exists. */
export const filesForChecks = (changed: ReadonlyArray<ChangedFile>): ReadonlyArray<string> =>
	changed.filter((file) => file.status !== 'deleted').map((file) => file.path);

// --- Implementation ---

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const start = yield* Clock.currentTimeMillis;
		const value = yield* effect;
		return { value, durationMs: (yield* Clock.currentTimeMillis) - start };
	});

/** The checks runner over `execute`; the real layer spawns shells, fakes script results. */
export const makeChecks = (execute: ShellExecutor) =>
	Effect.gen(function* () {
		const locks = yield* Locks;

		const runOne = Effect.fnUntraced(function* (
			input: RunChecksInput,
			check: Check,
			emit: (event: CheckEvent) => Effect.Effect<void>
		) {
			const commandLine = expandFiles(check.run, input.files);
			if (commandLine === null) return null;
			const fixLine =
				!input.pass.baseline && check.fix !== undefined
					? expandFiles(check.fix, input.files)
					: null;
			const labels = {
				check: check.name,
				baseline: input.pass.baseline,
				round: input.pass.round,
				attempt: input.pass.attempt
			};

			const runCommand = Effect.fnUntraced(function* (kind: 'run' | 'fix', line: string) {
				yield* emit({
					_tag: 'CheckStarted',
					at: yield* DateTime.now,
					...labels,
					command: kind,
					commandLine: line
				});
				const { value, durationMs } = yield* timed(
					execute({
						commandLine: line,
						cwd: input.cwd,
						env: input.env,
						check: check.name,
						kind
					})
				);
				yield* emit({
					_tag: 'CheckFinished',
					at: yield* DateTime.now,
					...labels,
					command: kind,
					exitCode: value.exitCode,
					durationMs,
					outputTail: value.outputTail
				});
				return { ...value, durationMs };
			});

			const onLockEvent = (event: LockEvent): Effect.Effect<void> =>
				Effect.flatMap(DateTime.now, (at) =>
					emit(
						LockEvent.$match(event, {
							Waiting: ({ resource, position }) => ({
								_tag: 'LockWaiting' as const,
								at,
								resource,
								check: check.name,
								position
							}),
							Acquired: ({ resource, waitedMs }) => ({
								_tag: 'LockAcquired' as const,
								at,
								resource,
								check: check.name,
								waitedMs
							}),
							Released: ({ resource }) => ({
								_tag: 'LockReleased' as const,
								at,
								resource,
								check: check.name
							})
						})
					)
				);

			const outcome = yield* locks.withPermit(
				check.lock,
				Effect.gen(function* () {
					if (fixLine !== null) yield* runCommand('fix', fixLine);
					return yield* runCommand('run', commandLine);
				}),
				{ onEvent: onLockEvent }
			);
			const result: CheckResult = {
				name: check.name,
				exitCode: outcome.exitCode,
				durationMs: outcome.durationMs,
				...(outcome.exitCode === 0 ? {} : { outputTail: outcome.outputTail })
			};
			return result;
		});

		const run = Effect.fn('Checks.run')(function* (input: RunChecksInput) {
			const emit = input.onEvent ?? (() => Effect.void);
			const results = yield* Effect.forEach(input.checks, (check) =>
				runOne(input, check, emit)
			);
			return {
				...input.pass,
				results: results.filter((result) => result !== null)
			} satisfies CheckRound;
		});

		const format = Effect.fn('Checks.format')(function* (input: FormatInput) {
			const commandLine = expandFiles(input.command, input.files);
			if (commandLine === null) return null;
			const { value, durationMs } = yield* timed(
				execute({
					commandLine,
					cwd: input.cwd,
					env: input.env,
					check: null,
					kind: 'format'
				})
			);
			return { commandLine, ...value, durationMs } satisfies CommandResult;
		});

		return Checks.of({ run, format });
	});

const makeShellExecutor = (limits: OutputTailLimits) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const execute: ShellExecutor = (command) =>
			execTail(
				ChildProcess.make('/bin/sh', ['-c', command.commandLine], {
					cwd: command.cwd,
					env: command.env,
					extendEnv: false,
					stdin: 'ignore',
					forceKillAfter: '3 seconds'
				}),
				limits
			).pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
				Effect.mapError(
					(error) =>
						new CheckSpawnError({
							commandLine: command.commandLine,
							cwd: command.cwd,
							detail: error.message
						})
				)
			);
		return execute;
	});

/** Runs project checks and the format command as shell commands. */
export class Checks extends Context.Service<Checks, ChecksShape>()('@ship/core/Checks') {
	/** Shell commands via `/bin/sh -c`, keeping `outputTail` lines and bytes of output. */
	static readonly layerWith = (options: { readonly outputTail?: OutputTailLimits } = {}) =>
		Layer.effect(
			this,
			Effect.flatMap(makeShellExecutor(options.outputTail ?? DEFAULT_OUTPUT_TAIL), makeChecks)
		);

	static readonly layer = this.layerWith();
}
