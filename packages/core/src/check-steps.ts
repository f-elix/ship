/**
 * The check steps: `baseline`, the checks on the base commit before any change, and
 * `checks`, which runs the checks on the change and has the implementer fix failing ones
 * between passes, up to the configured cap, unless Clef rates every failure unrelated to
 * the change.
 */
import { Duration, Effect, Schema } from 'effect';
import { Checkpoint } from './checkpoint.ts';
import { baselinePass, Checks, checksPassed, failingChecks, filesForChecks } from './checks.ts';
import { changeState, Clef, type ChoiceQuestion } from './clef.ts';
import { withDefault } from './defaults.ts';
import { Git } from './git.ts';
import { fixChecksCall, implementerFields } from './implementer.ts';
import { StepNotReady, StepTimeout, type StepKit } from './run-step.ts';
import { AgentSession, CheckRound } from './run.ts';
import { stepScopeFields } from './step-scope.ts';
import type { Step } from './step.ts';
import { AbsolutePath, NonNegativeInt } from './values.ts';

/** What both check steps return: every pass they ran, and whether the last passed. */
export const ChecksOutput = Schema.Struct({
	passes: Schema.Array(CheckRound),
	passed: Schema.Boolean,
	/**
	 * The last pass failed after Clef rated every failure unrelated to the change and a
	 * re-run with no fix failed again. Absent from outputs stored before Clef rated them.
	 */
	unrelated: Schema.Boolean.pipe(withDefault(false))
});
export interface ChecksOutput extends Schema.Schema.Type<typeof ChecksOutput> {}

/** Why a run fails when the checks step ends with `failing` checks still failing. */
export const checksFailedText = (output: ChecksOutput, failing: ReadonlyArray<string>): string =>
	output.unrelated
		? `Checks still fail when run again, and look unrelated to the change: ${failing.join(', ')}`
		: `Checks still fail after the check fixes: ${failing.join(', ')}`;

// --- baseline ---

export const BaselineInput = Schema.Struct({
	...stepScopeFields,
	/** The run's plan dir, which git is told to ignore so the plan never gets committed. */
	planDir: AbsolutePath
});
export interface BaselineInput extends Schema.Schema.Type<typeof BaselineInput> {}

/**
 * `baseline`: checks the run can start in place (plan dir excluded from git, clean tree,
 * `HEAD` still at the base), then runs every check once on the base commit, without fixes.
 */
export const baselineStep = {
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
			return { passes: [pass], passed: checksPassed(pass), unrelated: false };
		})
} satisfies Step<BaselineInput, ChecksOutput, unknown>;

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

/** One pass over every check, on the files the run changed since its base: the `attempt`th of the step. */
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

/** Clef rates a failing check unrelated to the change at this probability or above. */
export const UNRELATED_THRESHOLD = 0.7;

const UNRELATED_DECISION = 'Fixing failing checks without re-running them';

const causeQuestion = (index: number, name: string): ChoiceQuestion<'change' | 'unrelated'> => ({
	type: 'choice',
	instructions: `Did the code change make check ${index} (${name}) fail?`,
	criteria: {
		change: 'the change caused the failure: the output points at code, tests or files the change touched, or at what they do',
		unrelated:
			'the failure has nothing to do with the change: a flaky test, the network, the machine, or code the change did not touch'
	}
});

/**
 * Whether Clef rates every check that fails in `pass` and did not fail before the change
 * unrelated to the change; `false` without its answer or when the change cannot be read.
 */
const failuresUnrelated = (input: ChecksInput, pass: CheckRound) =>
	Effect.gen(function* () {
		const git = yield* Git;
		const names = failingChecks(pass, input.preexisting);
		const failing = pass.results.filter((result) => names.includes(result.name));
		const range = { from: input.baseSha };
		const change = yield* Effect.all([
			git.changedFiles(input, range),
			git.diff(input, range)
		]).pipe(
			Effect.catchTag('GitError', (error) =>
				Effect.as(Effect.logWarning(`${UNRELATED_DECISION} without Clef`, error), null)
			)
		);
		if (change === null) return false;
		const [files, diff] = change;
		const checks = failing.map((result, index) =>
			[
				`Check ${index}: ${result.name}`,
				`Command: ${input.config.checks.find((check) => check.name === result.name)?.run ?? 'unknown'}`,
				`Exit code: ${result.exitCode}`,
				'Output (tail):',
				result.outputTail ?? '(none)'
			].join('\n')
		);
		const answers = yield* (yield* Clef).ask(input, {
			decision: UNRELATED_DECISION,
			state: ['Failing checks:', '', ...checks, '', changeState(files, diff)].join('\n'),
			questions: Object.fromEntries(
				failing.map((result, index) => [
					`check.${index}`,
					causeQuestion(index, result.name)
				])
			)
		});
		if (answers === null) return false;
		const ps = failing.map(
			(_, index) => answers[`check.${index}`]?.probabilities.unrelated ?? 0
		);
		for (const [index, result] of failing.entries()) {
			yield* Effect.logInfo(
				`Check ${result.name} failure unrelated to the change (clef: p=${(ps[index] ?? 0).toFixed(2)})`
			);
		}
		return ps.every((p) => p >= UNRELATED_THRESHOLD);
	});

/**
 * `checks`: runs the checks on the change. A pass fails when a check fails that did not
 * fail before the change (`preexisting`). While a pass fails and fewer than
 * `caps.checkFixAttempts` fixes were tried, the implementer fixes the failing checks
 * (reported as `fixChecks`) and the checks run again. A passing pass commits the work
 * with `commitMessage`.
 *
 * Before a fix, Clef rates each failure: when it rates every one unrelated to the change,
 * the checks run again with no fix instead, once per step. If that re-run fails too, the
 * step ends with `unrelated`, for the run to escalate rather than fix what the change
 * did not break.
 *
 * Each pass, Clef rating and fix is checkpointed (`pass/<n>`, `cause/<n>`, `fix/<n>`, by
 * the pass they follow), so a resumed run keeps its count of fixes and does not redo a
 * finished one or ask Clef again.
 */
export const checksStep = {
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
			let fixes = 0;
			let rerunning = false;
			for (let index = 0; ; index++) {
				const pass = yield* checkpoint.once(
					`pass/${index}`,
					CheckRound,
					runPass(input, kit, index)
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
					return { passes, passed: true, unrelated: false };
				}
				if (rerunning) return { passes, passed: false, unrelated: true };
				if (fixes >= input.config.caps.checkFixAttempts) {
					return { passes, passed: false, unrelated: false };
				}
				// A failing re-run ended the step above, so the checks re-run at most once.
				rerunning = yield* checkpoint.once(
					`cause/${index}`,
					Schema.Boolean,
					failuresUnrelated(input, pass)
				);
				if (rerunning) continue;
				session = yield* checkpoint.once(
					`fix/${index}`,
					AgentSession,
					fixFailing({ ...input, session }, kit, pass)
				);
				fixes += 1;
				// A restored fix recorded its session when it ran; record it for this call too.
				yield* kit.recordSession(session);
			}
		})
} satisfies Step<ChecksInput, ChecksOutput, unknown>;
