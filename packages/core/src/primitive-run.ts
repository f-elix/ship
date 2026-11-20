/**
 * The run context and summary of `ship implement`, `ship checks`, `ship pr` and
 * `ship post`: runs that each do one part of `ship run` on their own, in the caller's
 * checkout.
 */
import { Schema } from 'effect';
import { primitiveScopeFields } from './primitive-scope.ts';
import { AbsolutePath, CostUsd, ReviewId, Url } from './primitives.ts';
import { checkRounds, ofTag, type SummaryInput } from './run-summary.ts';
import {
	AgentSession,
	CheckRound,
	CommitSubject,
	PrimitiveRunKind,
	type PrimitiveSummary
} from './run.ts';

/**
 * The context of a primitive run, persisted in snapshots like `RunState`. `kind` is the
 * command, which picks the machine's first state. `baseSha` is `HEAD` when the run was
 * created for `implement`, the merge base with the default branch for `checks` and `pr`,
 * and the reviewed base for `post`.
 */
export const PrimitiveRunState = Schema.Struct({
	...primitiveScopeFields,
	kind: PrimitiveRunKind,
	/** The plan `implement` works through, and `pr` may describe; `null` without one. */
	planDir: Schema.NullOr(AbsolutePath),
	/** The checked-out branch; `null` for `post`, which works on a PR's head. */
	branch: Schema.NullOr(Schema.NonEmptyString),
	/** `false` with `implement --no-checks`: the work is committed without the checks. */
	runChecks: Schema.Boolean,
	/** The stored review `post` posts; `null` for the other kinds. */
	review: Schema.NullOr(ReviewId),
	/** Started by `implement` or the first check fix; later check fixes resume it. */
	implementerSession: Schema.NullOr(AgentSession),
	/** The subject `implement` wrote for its commit; absent when it gave no valid one. */
	commitSubject: Schema.optionalKey(CommitSubject),
	checks: Schema.Array(CheckRound),
	/** Running cost for display while the run is live; the summary sums `AgentCost` events. */
	costUsd: CostUsd,
	/** The PR `pr` opened, or the review `post` posted; `null` until then. */
	url: Schema.NullOr(Url),
	/** Why the run failed; set only when it ends `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface PrimitiveRunState extends Schema.Schema.Type<typeof PrimitiveRunState> {}

/** What a primitive run starts from; {@link initialPrimitiveRunState} fills in the rest. */
export type NewPrimitiveRunState = Pick<
	PrimitiveRunState,
	| 'runId'
	| 'projectKey'
	| 'cwd'
	| 'env'
	| 'config'
	| 'baseSha'
	| 'kind'
	| 'planDir'
	| 'branch'
	| 'runChecks'
	| 'review'
>;

/** The context of a primitive run that has not taken a step yet. */
export const initialPrimitiveRunState = (start: NewPrimitiveRunState): PrimitiveRunState => ({
	...start,
	implementerSession: null,
	checks: [],
	costUsd: 0,
	url: null,
	error: null
});

/**
 * A primitive run's summary, built from its event log: the kind from
 * `PrimitiveRunCreated`, the commits from `CommitCreated`, the PR from `PrOpened` and the
 * posted review from `PrReviewPosted`.
 */
export const buildPrimitiveSummary = (input: SummaryInput): PrimitiveSummary => {
	const { events } = input;
	return {
		kind: ofTag(events, 'PrimitiveRunCreated')[0]?.kind ?? 'implement',
		runId: input.runId,
		status: input.status,
		commits: [...new Set(ofTag(events, 'CommitCreated').map((event) => event.sha))],
		checks: checkRounds(events),
		prUrl: ofTag(events, 'PrOpened').at(-1)?.url ?? null,
		reviewUrl: ofTag(events, 'PrReviewPosted').at(-1)?.url ?? null,
		costUsd: ofTag(events, 'AgentCost').reduce((total, event) => total + event.costUsd, 0),
		error: input.status === 'failed' ? input.error : null
	};
};
