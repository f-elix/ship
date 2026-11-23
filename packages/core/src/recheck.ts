/**
 * The `recheck` step: asks the verifier whether earlier findings are fixed in the
 * code as it is now. It is the verifier `review` uses, given the findings to check again
 * and no new ones.
 */
import { Duration, Effect, Schema } from 'effect';
import { agentContext } from './agent-context.ts';
import { Checkpoint } from './checkpoint.ts';
import { VerifiedFinding } from './finding.ts';
import { Git } from './git.ts';
import { reviewSubject } from './review-step.ts';
import { ChangeIntent, Reviewers } from './reviewers.ts';
import { StepTimeout } from './run-step.ts';
import { RecheckedFinding } from './run.ts';
import { stepScopeFields } from './step-scope.ts';
import type { Step } from './step.ts';

export const RecheckInput = Schema.Struct({
	...stepScopeFields,
	/** What the change sets out to do; the verifier reads the findings against it. */
	intent: ChangeIntent,
	/** The findings to check again. */
	findings: Schema.Array(VerifiedFinding)
});
export interface RecheckInput extends Schema.Schema.Type<typeof RecheckInput> {}

/**
 * `recheck`: the verifier checks each of `findings` against `baseSha..HEAD` and says
 * whether it is fixed, with evidence. Returns one entry per finding, in order, and reports
 * `FindingsRechecked`. A finding the verifier gives no status counts as unfixed.
 *
 * The verdicts are checkpointed (`verify`), so a resumed recheck does not ask again. The
 * verifier call has its own timeout, so the step has none.
 */
export const recheckStep = {
	name: 'recheck',
	input: RecheckInput,
	output: Schema.Array(RecheckedFinding),
	timeoutMs: () => null,
	run: (input, kit) =>
		Effect.gen(function* () {
			const checkpoint = yield* Checkpoint;
			const reviewers = yield* Reviewers;
			const timeoutMs = input.config.timeouts.verify;
			return yield* checkpoint.once(
				'verify',
				Schema.Array(RecheckedFinding),
				Effect.gen(function* () {
					const head = yield* (yield* Git).headSha(input);
					const subject = yield* reviewSubject(input, input.intent, {
						from: input.baseSha,
						to: head
					});
					const result = yield* reviewers.verify({
						...subject,
						// Nothing to lower: a recheck verifies no new finding.
						scope: input,
						// Past every finding's round, so nothing the verifier keeps reuses an id.
						round: Math.max(0, ...input.findings.map((finding) => finding.round)) + 1,
						findings: [],
						previous: input.findings,
						knownTradeoffs: [],
						model: input.config.models.verify,
						timeoutMs,
						context: yield* agentContext(input)
					});
					if (result.cost !== null) yield* kit.recordCost(result.cost);
					const statuses = new Map(result.previous.map((entry) => [entry.id, entry]));
					const rechecked = input.findings.map((finding): RecheckedFinding => ({
						finding,
						status: statuses.get(finding.id)?.status ?? 'unfixed',
						evidence: statuses.get(finding.id)?.evidence ?? ''
					}));
					yield* kit.report({ _tag: 'FindingsRechecked', findings: rechecked });
					return rechecked;
				}).pipe(
					Effect.timeoutOrElse({
						duration: Duration.millis(timeoutMs),
						orElse: () => Effect.fail(new StepTimeout({ step: 'verify', timeoutMs }))
					})
				)
			);
		})
} satisfies Step<RecheckInput, ReadonlyArray<RecheckedFinding>, unknown>;
