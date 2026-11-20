/**
 * Triage, the `ship run` step between a review and what follows it: sorts the round's
 * verified findings and picks fix, pr or escalate. It is pure, so it is a pipeline step
 * rather than a primitive.
 */
import { Data, Effect } from 'effect';
import type { VerifiedFinding } from './finding.ts';
import { runStep } from './run-step.ts';
import type { EscalationReason, RunState, UnresolvedFindings } from './run.ts';

export type TriageNext = Data.TaggedEnum<{
	pr: {};
	fix: {};
	escalate: { readonly reason: EscalationReason };
}>;
export const TriageNext = Data.taggedEnum<TriageNext>();

export interface TriageResult {
	readonly unresolved: UnresolvedFindings;
	readonly next: TriageNext;
}

const mergeById = (
	earlier: ReadonlyArray<VerifiedFinding>,
	later: ReadonlyArray<VerifiedFinding>
): ReadonlyArray<VerifiedFinding> => {
	const ids = new Set(earlier.map((finding) => finding.id));
	return [...earlier, ...later.filter((finding) => !ids.has(finding.id))];
};

/**
 * Sorts the latest round's verified findings and picks what comes next. This round's
 * must-fix findings and nits loop: a round with neither opens the PR. Tradeoffs never
 * loop; they pile up for the PR body. A must-fix finding that repeats an earlier round's
 * must-fix is a stall, which escalates at once; a repeated nit just loops. The review cap
 * applies after that.
 */
export const triage = (state: RunState): TriageResult => {
	const verified = state.reviewRounds.at(-1)?.findings ?? [];
	const bySeverity = (severity: VerifiedFinding['severity']) =>
		verified.filter((finding) => finding.severity === severity);
	const mustFix = bySeverity('must-fix');
	const nits = bySeverity('nit');
	const unresolved: UnresolvedFindings = {
		mustFix,
		tradeoffs: mergeById(state.unresolved.tradeoffs, bySeverity('tradeoff')),
		nits
	};
	const earlierMustFix = new Set(
		state.reviewRounds
			.slice(0, -1)
			.flatMap((round) => round.findings)
			.filter((finding) => finding.severity === 'must-fix')
			.map((finding) => finding.id)
	);
	const next =
		mustFix.length === 0 && nits.length === 0
			? TriageNext.pr()
			: mustFix.some(
						(finding) =>
							finding.repeats !== undefined && earlierMustFix.has(finding.repeats)
				  )
				? TriageNext.escalate({ reason: 'stall' })
				: state.round >= state.config.caps.reviewRounds
					? TriageNext.escalate({ reason: 'review-cap' })
					: TriageNext.fix();
	return { unresolved, next };
};

export const triageStep = (state: RunState) =>
	runStep('triage', state, { timeoutMs: null }, (kit) =>
		Effect.gen(function* () {
			const result = triage(state);
			const ids = (findings: ReadonlyArray<VerifiedFinding>) => findings.map((f) => f.id);
			yield* kit.report({
				_tag: 'FindingsTriaged',
				round: state.round,
				mustFix: ids(result.unresolved.mustFix),
				tradeoffs: ids(result.unresolved.tradeoffs),
				nits: ids(result.unresolved.nits)
			});
			return result;
		})
	);
