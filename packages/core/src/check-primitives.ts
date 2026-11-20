/**
 * The check primitives: `baseline`, the checks on the base commit before any change, and
 * `checks`, which runs the checks on the change and has the implementer fix failing ones
 * between passes, up to the configured cap.
 */
import { Duration, Effect, Schema } from 'effect';
import { Checkpoint } from './checkpoint.ts';
import { baselinePass, Checks, checksPassed, failingChecks, filesForChecks } from './checks.ts';
import { Git } from './git.ts';
import { fixChecksCall, implementerFields } from './implementer.ts';
import { primitiveScopeFields } from './primitive-scope.ts';
import type { Primitive } from './primitive.ts';
import { AbsolutePath, NonNegativeInt } from './primitives.ts';
import { StepNotReady, StepTimeout, type StepKit } from './run-step.ts';
import { AgentSession, CheckRound } from './run.ts';

/** What both check primitives return: every pass they ran, and whether the last passed. */
export const ChecksOutput = Schema.Struct({
	passes: Schema.Array(CheckRound),
	passed: Schema.Boolean
});
export interface ChecksOutput extends Schema.Schema.Type<typeof ChecksOutput> {}

// --- baseline ---

export const BaselineInput = Schema.Struct({
	...primitiveScopeFields,
	/** The run's plan dir, which git is told to ignore so the plan never gets committed. */
	planDir: AbsolutePath
});
export interface BaselineInput extends Schema.Schema.Type<typeof BaselineInput> {}

/**
 * `baseline`: checks the run can start in place (plan dir excluded from git, clean tree,
 * `HEAD` still at the base), then runs every check once on the base commit, without fixes.
 */
export const baselinePrimitive = {
	name: 'baseline',
	input: BaselineInput,
	output: ChecksOutput,
	// Each command's limit starts once it holds its lock.
	timeoutMs: () => null,
	run: (input, kit) =>
		Effect.gen(function* () {
			const git = yield* Git;
			const checks = yield* Checks;
			yield* git.excludePath(input, input.planDir);
			if (!(yield* git.isClean(input))) {
				return yield* new StepNotReady({
					reason: 'The working tree has uncommitted changes; commit or stash them first'
				});
			}
			const head = yield* git.headSha(input);
			if (head !== input.baseSha) {
				return yield* new StepNotReady({
					reason: `HEAD moved from ${input.baseSha} to ${head} before the baseline checks`
				});
			}
			const pass = yield* checks.run(
				baselinePass({
					cwd: input.cwd,
					env: input.env,
					config: input.config,
					onEvent: kit.emit
				})
			);
			return { passes: [pass], passed: checksPassed(pass) };
		})
} satisfies Primitive<BaselineInput, ChecksOutput, unknown>;

// --- checks ---

export const ChecksInput = Schema.Struct({
	...implementerFields,
	/** The review round the passes belong to; 0 before the first review. */
	round: NonNegativeInt,
	/** The message of the commit made when the checks pass. */
	commitMessage: Schema.NonEmptyString,
	/**
	 * The checks that failed before the change: their failures neither fail a pass nor
	 * get fixed, since the change did not cause them.
	 */
	preexisting: Schema.Array(Schema.String)
});
export interface ChecksInput extends Schema.Schema.Type<typeof ChecksInput> {}

/** One pass over every check, on the files the run changed since its base. */
const runPass = (input: ChecksInput, kit: StepKit, attempt: number) =>
	Effect.gen(function* () {
		const git = yield* Git;
		const checks = yield* Checks;
		const changed = yield* git.changedFiles(input, { from: input.baseSha });
		return yield* checks.run({
			cwd: input.cwd,
			env: input.env,
			checks: input.config.checks,
			files: filesForChecks(changed),
			pass: { baseline: false, round: input.round, attempt },
			timeoutMs: input.config.timeouts.checks,
			onEvent: kit.emit
		});
	});

/**
 * The implementer fixes the checks of `pass` that fail and did not fail before the change,
 * within the `fixChecks` timeout.
 */
const fixFailing = (input: ChecksInput, kit: StepKit, pass: CheckRound) => {
	const timeoutMs = input.config.timeouts.fixChecks;
	const names = failingChecks(pass, input.preexisting);
	const failing = pass.results.filter((result) => names.includes(result.name));
	return fixChecksCall(input, kit, failing).pipe(
		Effect.map((reply) => reply.session),
		Effect.timeoutOrElse({
			duration: Duration.millis(timeoutMs),
			orElse: () => Effect.fail(new StepTimeout({ step: 'fixChecks', timeoutMs }))
		})
	);
};

/**
 * `checks`: runs the checks on the change. A pass fails when a check fails that did not
 * fail before the change (`preexisting`). While a pass fails and fewer than
 * `caps.checkFixAttempts` fixes were tried, the implementer fixes the failing checks
 * (reported as `fixChecks`) and the checks run again. A passing pass commits the work
 * with `commitMessage`.
 *
 * Each pass and each fix is checkpointed (`pass/<n>`, `fix/<n>`), so a resumed run keeps
 * its count of fixes and does not redo a finished one.
 */
export const checksPrimitive = {
	name: 'checks',
	input: ChecksInput,
	output: ChecksOutput,
	// Each command's limit starts once it holds its lock, and each fix has its own.
	timeoutMs: () => null,
	run: (input, kit) =>
		Effect.gen(function* () {
			const checkpoint = yield* Checkpoint;
			const git = yield* Git;
			const passes: Array<CheckRound> = [];
			let session = input.session;
			for (let attempt = 0; ; attempt++) {
				const pass = yield* checkpoint.once(
					`pass/${attempt}`,
					CheckRound,
					runPass(input, kit, attempt)
				);
				passes.push(pass);
				if (checksPassed(pass, input.preexisting)) {
					const sha = yield* git.commit(input, input.commitMessage);
					if (sha !== null) {
						yield* kit.report({
							_tag: 'CommitCreated',
							sha,
							message: input.commitMessage
						});
					}
					return { passes, passed: true };
				}
				if (attempt >= input.config.caps.checkFixAttempts) return { passes, passed: false };
				session = yield* checkpoint.once(
					`fix/${attempt}`,
					AgentSession,
					fixFailing({ ...input, session }, kit, pass)
				);
				// A restored fix recorded its session when it ran; record it for this call too.
				yield* kit.recordSession(session);
			}
		})
} satisfies Primitive<ChecksInput, ChecksOutput, unknown>;
