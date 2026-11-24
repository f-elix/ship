/**
 * The publishing steps: `pr` opens or updates the pull request for the run's branch,
 * and `escalate` commits unfinished work and publishes it as a draft that says why the
 * run stopped.
 */
import { Effect, Schema } from 'effect';
import { agentContext } from './agent-context.ts';
import { Git } from './git.ts';
import { planIntent } from './implementer.ts';
import { Pr } from './pr.ts';
import { StepNotReady, type StepKit } from './run-step.ts';
import { CheckRound, EscalationReason, UnresolvedFindings } from './run.ts';
import { stepScopeFields } from './step-scope.ts';
import type { Step } from './step.ts';
import { AbsolutePath, Url, type StepName } from './values.ts';

export const PrInput = Schema.Struct({
	...stepScopeFields,
	/** The plan the change implements, whose spec and plan the PR agent reads; `null` without one. */
	planDir: Schema.NullOr(AbsolutePath),
	branch: Schema.NonEmptyString,
	/**
	 * The message of the single commit a squash leaves, when `pr.squash` is on. `null`
	 * never squashes: the branch's commits are not all ship's to rewrite.
	 */
	squashMessage: Schema.NullOr(Schema.NonEmptyString),
	/** Every check pass, for the body's evidence. */
	checks: Schema.Array(CheckRound),
	unresolved: UnresolvedFindings
});
export interface PrInput extends Schema.Schema.Type<typeof PrInput> {}

/** Squashes when configured and allowed, pushes, then opens or updates the PR. Returns its URL. */
const publish = (
	step: Extract<StepName, 'pr' | 'escalate'>,
	input: PrInput,
	kit: StepKit,
	escalation: EscalationReason | null
) =>
	Effect.gen(function* () {
		const git = yield* Git;
		const pr = yield* Pr;
		const { squashMessage } = input;
		if (
			input.config.pr.squash &&
			squashMessage !== null &&
			(yield* git.headSha(input)) !== input.baseSha
		) {
			yield* git.squash(input, { base: input.baseSha, message: squashMessage });
		}
		yield* git.push(input, input.branch);
		const base = yield* git.baseBranch(input);
		const context = yield* agentContext(input);
		const result = yield* pr.open({
			repo: { cwd: input.cwd, env: input.env },
			branch: input.branch,
			base,
			headSha: yield* git.headSha(input),
			plan: input.planDir === null ? null : planIntent(input.planDir),
			checks: input.checks,
			unresolved: input.unresolved,
			escalation,
			draft: input.config.pr.draft,
			model: input.config.models.pr,
			timeoutMs: input.config.timeouts[step],
			transcript: context.transcript
		});
		yield* kit.recordCost(result.cost);
		yield* kit.report({ _tag: 'PrOpened', url: result.url, draft: result.draft });
		return result.url;
	});

/** `pr`: squashes when configured, pushes the branch and opens or updates its PR. */
export const prStep = {
	name: 'pr',
	input: PrInput,
	output: Url,
	timeoutMs: (config) => config.timeouts.pr,
	run: (input, kit) => publish('pr', input, kit, null)
} satisfies Step<PrInput, string, unknown>;

export const EscalateInput = Schema.Struct({
	...PrInput.fields,
	/** Why the run stopped; `null` is refused, since the draft must say why. */
	reason: Schema.NullOr(EscalationReason)
});
export interface EscalateInput extends Schema.Schema.Type<typeof EscalateInput> {}

/**
 * `escalate`: commits any unfinished work, then publishes a draft PR that says why the run
 * stopped and lists what is unresolved.
 */
export const escalateStep = {
	name: 'escalate',
	input: EscalateInput,
	output: Url,
	timeoutMs: (config) => config.timeouts.escalate,
	run: (input, kit) =>
		Effect.gen(function* () {
			const { reason } = input;
			if (reason === null) {
				return yield* new StepNotReady({ reason: 'Escalating without a reason' });
			}
			const git = yield* Git;
			yield* kit.report({ _tag: 'Escalated', reason });
			const message = `WIP: unfinished work (ship escalated: ${reason})`;
			const sha = yield* git.commit(input, message);
			if (sha !== null) yield* kit.report({ _tag: 'CommitCreated', sha, message });
			return yield* publish('escalate', input, kit, reason);
		})
} satisfies Step<EscalateInput, string, unknown>;
