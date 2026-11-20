import { Schema } from 'effect';
import type { FindingId, VerifiedFinding } from './finding.ts';
import { primitiveScopeFields } from './primitive-scope.ts';
import { CostUsd, GitSha, PositiveInt, Url } from './primitives.ts';
import { ofTag, type SummaryInput } from './run-summary.ts';
import { ReviewRound, type ReviewSummary } from './run.ts';

/** The pull request a `ship review` run reviews, as it was when the run was created. */
export const ReviewedPr = Schema.Struct({
	number: PositiveInt,
	url: Url,
	title: Schema.String,
	body: Schema.String,
	/** The merge base of the PR's base branch and its head; the run's `baseSha`. */
	baseSha: GitSha,
	/** The PR's head, fetched and pinned when the run was created; resuming never refetches. */
	headSha: GitSha
});
export interface ReviewedPr extends Schema.Schema.Type<typeof ReviewedPr> {}

/**
 * The context of a `ship review` run, persisted in snapshots like `RunState`. `cwd` is
 * the caller's checkout, at `pr.headSha` when the run started; `baseSha` is `pr.baseSha`.
 */
export const ReviewRunState = Schema.Struct({
	...primitiveScopeFields,
	kind: Schema.Literal('review'),
	pr: ReviewedPr,
	/** Whether the run posts its findings as a review on the PR. */
	post: Schema.Boolean,
	/** The review's round with its verified findings; `null` until `review` ends. */
	review: Schema.NullOr(ReviewRound),
	/** Running cost for display while the run is live; the summary sums `AgentCost` events. */
	costUsd: CostUsd,
	/** The posted review; `null` until `post` posts one. */
	reviewUrl: Schema.NullOr(Url),
	/** Why the run failed; set only when it ends `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface ReviewRunState extends Schema.Schema.Type<typeof ReviewRunState> {}

/** What a review run starts from; {@link initialReviewRunState} fills in the rest. */
export type NewReviewRunState = Pick<
	ReviewRunState,
	'runId' | 'projectKey' | 'cwd' | 'env' | 'config' | 'pr' | 'post'
>;

/** The context of a review run that has not taken a step yet. */
export const initialReviewRunState = (start: NewReviewRunState): ReviewRunState => ({
	...start,
	kind: 'review',
	baseSha: start.pr.baseSha,
	review: null,
	costUsd: 0,
	reviewUrl: null,
	error: null
});

/**
 * A review run's summary, built from its event log: the latest verified findings by
 * severity, the PR from `ReviewRunCreated`, the stored review from `ReviewStored` and the
 * posted one from `PrReviewPosted`.
 */
export const buildReviewSummary = (input: SummaryInput): ReviewSummary => {
	const { events } = input;
	const verified = new Map<FindingId, VerifiedFinding>(
		ofTag(events, 'FindingsVerified').flatMap((event) =>
			event.verified.map((finding) => [finding.id, finding] as const)
		)
	);
	const findings = [...verified.values()];
	const bySeverity = (severity: VerifiedFinding['severity']) =>
		findings.filter((finding) => finding.severity === severity);
	const stored = ofTag(events, 'ReviewStored').at(-1);
	return {
		kind: 'review',
		runId: input.runId,
		status: input.status,
		prUrl: ofTag(events, 'ReviewRunCreated')[0]?.prUrl ?? '',
		reviewUrl: ofTag(events, 'PrReviewPosted').at(-1)?.url ?? null,
		...(stored === undefined ? {} : { reviewId: stored.reviewId }),
		costUsd: ofTag(events, 'AgentCost').reduce((total, event) => total + event.costUsd, 0),
		mustFix: bySeverity('must-fix'),
		tradeoffs: bySeverity('tradeoff'),
		nits: bySeverity('nit'),
		error: input.status === 'failed' ? input.error : null
	};
};
