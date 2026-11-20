import { Schema } from 'effect';
import { ResolvedConfig } from './config.ts';
import { Finding, VerifiedFinding } from './finding.ts';
import {
	AbsolutePath,
	CostUsd,
	Env,
	GitSha,
	Millis,
	NonNegativeInt,
	PositiveInt,
	ProjectKey,
	RunId,
	SessionId,
	Url
} from './primitives.ts';
import { ReviewerName } from './reviewer.ts';

/** `waiting` means the run is blocked on a check lock. */
export const RunStatus = Schema.Literals([
	'running',
	'waiting',
	'done',
	'escalated',
	'failed',
	'cancelled',
	'interrupted'
]);
export type RunStatus = typeof RunStatus.Type;

/** Statuses a run never leaves. `interrupted` is not one: `ship resume` continues it. */
export const TerminalRunStatus = RunStatus.pick(['done', 'escalated', 'failed', 'cancelled']);
export type TerminalRunStatus = typeof TerminalRunStatus.Type;

/** `timeout`: a step timed out after the run had already committed work. */
export const EscalationReason = Schema.Literals([
	'check-fix-cap',
	'review-cap',
	'stall',
	'timeout'
]);
export type EscalationReason = typeof EscalationReason.Type;

export const CheckResult = Schema.Struct({
	name: Schema.NonEmptyString,
	exitCode: Schema.Int,
	durationMs: Millis,
	/** Trimmed tail of the output; kept only when the check failed. */
	outputTail: Schema.optionalKey(Schema.String)
});
export interface CheckResult extends Schema.Schema.Type<typeof CheckResult> {}

/** One pass over all checks: the baseline, a round's first run, or a run after a check-fix. */
export const CheckRound = Schema.Struct({
	baseline: Schema.Boolean,
	/** Review round the pass belongs to; 0 before the first review. */
	round: NonNegativeInt,
	/** Check-fix attempts made in this round before the pass; 0 for the first pass. */
	attempt: NonNegativeInt,
	results: Schema.Array(CheckResult)
});
export interface CheckRound extends Schema.Schema.Type<typeof CheckRound> {}

export const ReviewRound = Schema.Struct({
	round: PositiveInt,
	/** The reviewed range is `fromSha..toSha`. */
	fromSha: GitSha,
	toSha: GitSha,
	reviewers: Schema.Array(ReviewerName),
	findings: Schema.Array(VerifiedFinding)
});
export interface ReviewRound extends Schema.Schema.Type<typeof ReviewRound> {}

export const UnresolvedFindings = Schema.Struct({
	mustFix: Schema.Array(VerifiedFinding),
	tradeoffs: Schema.Array(VerifiedFinding),
	nits: Schema.Array(VerifiedFinding)
});
export interface UnresolvedFindings extends Schema.Schema.Type<typeof UnresolvedFindings> {}

/**
 * The review round in progress, from `route` until `verify` turns it into a
 * {@link ReviewRound}: what `review` runs and what `verify` checks.
 */
export const ReviewInProgress = Schema.Struct({
	round: PositiveInt,
	/** The reviewed range is `fromSha..toSha`: always the whole branch, from `baseSha`. */
	fromSha: GitSha,
	toSha: GitSha,
	/**
	 * Where the range routing looked at starts: `baseSha` in round 1, then
	 * `lastReviewedSha`, so routing sees only the fix commits.
	 */
	routedFromSha: GitSha,
	reviewers: Schema.Array(ReviewerName),
	/** What the reviewers reported; empty until `review` ends. */
	findings: Schema.Array(Finding)
});
export interface ReviewInProgress extends Schema.Schema.Type<typeof ReviewInProgress> {}

/**
 * A session the next call can resume, with the session's running cost total so the next
 * call's own cost can be told apart. Persisted whole as the implementer session.
 */
export const AgentSession = Schema.Struct({
	sessionId: SessionId,
	/** The session's `total_cost_usd` after its latest call. */
	cumulativeCostUsd: CostUsd
});
export interface AgentSession extends Schema.Schema.Type<typeof AgentSession> {}

/**
 * The subject line of the run's commit: imperative mood, at most 72 characters, no
 * trailing period. The implementer writes it.
 */
export const CommitSubject = Schema.NonEmptyString.check(
	Schema.isTrimmed(),
	Schema.isMaxLength(72),
	Schema.isPattern(/^[^\n]*[^.\n]$/u, { expected: 'one line without a trailing period' })
);
export type CommitSubject = typeof CommitSubject.Type;

/**
 * The fields of a run's context that a review round reads and writes. A `ship run` and a
 * `ship review` run both hold them, so the round's steps and reducers serve both machines.
 */
export const reviewRoundFields = {
	runId: RunId,
	projectKey: ProjectKey,
	/** Where agents and git run: the user's checkout for `ship run`, a worktree for `ship review`. */
	cwd: AbsolutePath,
	env: Env,
	/** Where the reviewed range starts. */
	baseSha: GitSha,
	/** Resolved when the run is created; later config edits do not change it. */
	config: ResolvedConfig,
	/** Current review round: a `ship run` is at 0 before its first review, a `ship review` run is at 1 from the start. */
	round: NonNegativeInt,
	lastReviewedSha: Schema.NullOr(GitSha),
	review: Schema.NullOr(ReviewInProgress),
	reviewRounds: Schema.Array(ReviewRound),
	unresolved: UnresolvedFindings
};

/** The slice of a run's context that the review round reads and writes. */
export const ReviewRoundState = Schema.Struct(reviewRoundFields);
export interface ReviewRoundState extends Schema.Schema.Type<typeof ReviewRoundState> {}

/**
 * The machine context, persisted in snapshots. Values the run has not produced yet are
 * `null` so the context always has the same keys.
 */
export const RunState = Schema.Struct({
	...reviewRoundFields,
	/**
	 * Tells a `ship run` context from a `ship review` one. Optional so that snapshots saved
	 * before review runs existed still load: an absent kind is `ship`.
	 */
	kind: Schema.optionalKey(Schema.Literal('ship')),
	planDir: AbsolutePath,
	branch: Schema.NonEmptyString,
	/** Set by `implement`; every fix step resumes this session. */
	implementerSession: Schema.NullOr(AgentSession),
	/**
	 * The subject the implementer wrote for the round-0 commit and the squashed commit.
	 * Optional, unlike the other not-yet-produced values: it stays absent when `implement`
	 * gave no valid subject, and the commit falls back to `Implement <plan name>`.
	 */
	commitSubject: Schema.optionalKey(CommitSubject),
	/** Check-fix attempts in the current round. */
	checkFixAttempts: NonNegativeInt,
	checks: Schema.Array(CheckRound),
	/**
	 * Running cost for display while the run is live. The summary sums the `AgentCost`
	 * events instead, which also count a step's spending before a resume re-ran it.
	 */
	costUsd: CostUsd,
	prUrl: Schema.NullOr(Url),
	escalationReason: Schema.NullOr(EscalationReason),
	/** Why the run failed; set only when it ends `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface RunState extends Schema.Schema.Type<typeof RunState> {}

/** What a run starts from; {@link initialRunState} fills in the rest. */
export type NewRunState = Pick<
	RunState,
	'runId' | 'projectKey' | 'cwd' | 'env' | 'planDir' | 'branch' | 'baseSha' | 'config'
>;

/** The context of a run that has not taken a step yet. */
export const initialRunState = (start: NewRunState): RunState => ({
	...start,
	kind: 'ship',
	implementerSession: null,
	round: 0,
	checkFixAttempts: 0,
	lastReviewedSha: null,
	review: null,
	reviewRounds: [],
	unresolved: { mustFix: [], tradeoffs: [], nits: [] },
	checks: [],
	costUsd: 0,
	prUrl: null,
	escalationReason: null,
	error: null
});

/**
 * Format version of persisted run snapshots (the machine snapshot around `RunState`).
 * Bump it when a change to `RunState` or the machine's states makes older snapshots
 * unsafe to restore; runs saved under another version can no longer be resumed.
 */
export const SNAPSHOT_VERSION = 3;

/** The JSON `ship run` prints on stdout when the run ends; also kept in the run store. */
export const ShipSummary = Schema.Struct({
	/** Absent in summaries stored before review runs existed. */
	kind: Schema.optionalKey(Schema.Literal('ship')),
	runId: RunId,
	status: TerminalRunStatus,
	prUrl: Schema.NullOr(Url),
	rounds: NonNegativeInt,
	/** Every check pass; a failing baseline keeps its output tail here. */
	checks: Schema.Array(CheckRound),
	costUsd: CostUsd,
	unresolvedMustFix: Schema.Array(VerifiedFinding),
	/** Every tradeoff the reviews kept, as the PR body lists them. */
	tradeoffs: Schema.Array(VerifiedFinding),
	/** Nits the last review round left unresolved; empty when the run is done. */
	nits: Schema.Array(VerifiedFinding),
	escalationReason: Schema.NullOr(EscalationReason),
	/** Why the run failed, when `status` is `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface ShipSummary extends Schema.Schema.Type<typeof ShipSummary> {}

/** The JSON `ship review` prints on stdout when the run ends; also kept in the run store. */
export const ReviewSummary = Schema.Struct({
	kind: Schema.Literal('review'),
	runId: RunId,
	/** `done`, `failed` or `cancelled`: a review run never escalates. */
	status: TerminalRunStatus,
	/** The reviewed PR. */
	prUrl: Url,
	/** The review posted on the PR; `null` without `--post` or when there was nothing to post. */
	reviewUrl: Schema.NullOr(Url),
	costUsd: CostUsd,
	/** The verified findings, by severity. */
	mustFix: Schema.Array(VerifiedFinding),
	tradeoffs: Schema.Array(VerifiedFinding),
	nits: Schema.Array(VerifiedFinding),
	/** Why the run failed, when `status` is `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface ReviewSummary extends Schema.Schema.Type<typeof ReviewSummary> {}

/** What a run of either kind ends with. A summary without `kind` is a `ship run` one. */
export const Summary = Schema.Union([ReviewSummary, ShipSummary]);
export type Summary = typeof Summary.Type;
