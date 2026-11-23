import { Schema } from 'effect';
import { VerifiedFinding } from './finding.ts';
import { ReviewerName } from './reviewer.ts';
import { stepScopeFields } from './step-scope.ts';
import {
	AbsolutePath,
	CostUsd,
	GitSha,
	Millis,
	NonNegativeInt,
	PositiveInt,
	ReviewId,
	RunId,
	SessionId,
	Url
} from './values.ts';

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

/** Whether `ship resume` takes a run: an interrupted one continues, a failed one retries. */
export const isResumable = (status: RunStatus): boolean =>
	status === 'interrupted' || status === 'failed';

/** `timeout`: a step timed out after the run had already committed work. */
export const EscalationReason = Schema.Literals([
	'check-fix-cap',
	'checks-unrelated',
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
	/**
	 * The pass's number in its round: 0 for the first, then one more for each pass after a
	 * check fix or a re-run with no fix.
	 */
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
 * The machine context, persisted in snapshots. Values the run has not produced yet are
 * `null` so the context always has the same keys.
 */
export const RunState = Schema.Struct({
	...stepScopeFields,
	/**
	 * Tells a `ship run` context from a `ship review` one. Optional so that snapshots saved
	 * before review runs existed still load: an absent kind is `ship`.
	 */
	kind: Schema.optionalKey(Schema.Literal('ship')),
	planDir: AbsolutePath,
	branch: Schema.NonEmptyString,
	/** Current review round: 0 before the first review, then the round `review` runs or ran. */
	round: NonNegativeInt,
	/** The head of the latest reviewed range; the next round's routing starts there. */
	lastReviewedSha: Schema.NullOr(GitSha),
	reviewRounds: Schema.Array(ReviewRound),
	/**
	 * What the latest triage left: the must-fix findings and nits `fix` works through, and
	 * every tradeoff so far, for the PR body.
	 */
	unresolved: UnresolvedFindings,
	/** Set by `implement`; every fix step resumes this session. */
	implementerSession: Schema.NullOr(AgentSession),
	/**
	 * The subject the implementer wrote for the round-0 commit and the squashed commit.
	 * Optional, unlike the other not-yet-produced values: it stays absent when `implement`
	 * gave no valid subject, and the commit falls back to `Implement <plan name>`.
	 */
	commitSubject: Schema.optionalKey(CommitSubject),
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
	lastReviewedSha: null,
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
export const SNAPSHOT_VERSION = 4;

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
	/**
	 * The stored review, which later commands take. Absent when the run ended before
	 * storing it, and in summaries stored before reviews were.
	 */
	reviewId: Schema.optionalKey(ReviewId),
	costUsd: CostUsd,
	/** The verified findings, by severity. */
	mustFix: Schema.Array(VerifiedFinding),
	tradeoffs: Schema.Array(VerifiedFinding),
	nits: Schema.Array(VerifiedFinding),
	/** Why the run failed, when `status` is `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface ReviewSummary extends Schema.Schema.Type<typeof ReviewSummary> {}

/** What `recheck` found of one earlier finding. */
export const RecheckedFinding = Schema.Struct({
	finding: VerifiedFinding,
	status: Schema.Literals(['fixed', 'unfixed']),
	/** The verifier's evidence for `status`. */
	evidence: Schema.String
});
export interface RecheckedFinding extends Schema.Schema.Type<typeof RecheckedFinding> {}

/** The JSON `ship fix` prints on stdout when the run ends; also kept in the run store. */
export const FixSummary = Schema.Struct({
	kind: Schema.Literal('fix'),
	runId: RunId,
	/** `done`, `failed` or `cancelled`: a fix run never escalates. */
	status: TerminalRunStatus,
	/** The PR whose findings were fixed. */
	prUrl: Url,
	/** The must-fix findings and nits the fix agent was given. */
	findings: Schema.Array(VerifiedFinding),
	/** The open review threads left out because their author may not push to the repository. */
	ignoredThreads: Schema.Array(Url),
	/** The commits the run made, oldest first. */
	commits: Schema.Array(GitSha),
	/** Whether the commits were pushed to the PR's branch. */
	pushed: Schema.Boolean,
	/** Every check pass; empty with `--no-checks`. */
	checks: Schema.Array(CheckRound),
	costUsd: CostUsd,
	/** Why the run failed, when `status` is `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface FixSummary extends Schema.Schema.Type<typeof FixSummary> {}

/** The JSON `ship recheck` prints on stdout when the run ends; also kept in the run store. */
export const RecheckSummary = Schema.Struct({
	kind: Schema.Literal('recheck'),
	runId: RunId,
	/** `done`, `failed` or `cancelled`: a recheck run never escalates. */
	status: TerminalRunStatus,
	/** The PR whose findings were rechecked. */
	prUrl: Url,
	/** Each finding with its status and the verifier's evidence; empty before `recheck` ends. */
	findings: Schema.Array(RecheckedFinding),
	/** The review threads the run resolved on GitHub. */
	resolvedThreads: Schema.Array(Schema.String),
	/** The open review threads left out because their author may not push to the repository. */
	ignoredThreads: Schema.Array(Url),
	costUsd: CostUsd,
	/** Why the run failed, when `status` is `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface RecheckSummary extends Schema.Schema.Type<typeof RecheckSummary> {}

/**
 * The commands that each run one part of `ship run` on their own: `ship implement`,
 * `ship checks`, `ship pr` and `ship post`.
 */
export const PrimitiveRunKind = Schema.Literals(['implement', 'checks', 'pr', 'post']);
export type PrimitiveRunKind = typeof PrimitiveRunKind.Type;

/**
 * The JSON `ship implement`, `ship checks`, `ship pr` and `ship post` print on stdout when
 * the run ends; also kept in the run store.
 */
export const PrimitiveSummary = Schema.Struct({
	kind: PrimitiveRunKind,
	runId: RunId,
	/** `done`, `failed` or `cancelled`: these runs never escalate. */
	status: TerminalRunStatus,
	/** The commits the run made, oldest first. */
	commits: Schema.Array(GitSha),
	/** Every check pass, the baseline included. */
	checks: Schema.Array(CheckRound),
	/** The PR `ship pr` opened or updated; `null` for the other kinds. */
	prUrl: Schema.NullOr(Url),
	/** The review `ship post` posted; `null` for the other kinds, or until it is posted. */
	reviewUrl: Schema.NullOr(Url),
	costUsd: CostUsd,
	/** Why the run failed, when `status` is `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface PrimitiveSummary extends Schema.Schema.Type<typeof PrimitiveSummary> {}

/** What a run of any kind ends with. A summary without `kind` is a `ship run` one. */
export const Summary = Schema.Union([
	ReviewSummary,
	FixSummary,
	RecheckSummary,
	PrimitiveSummary,
	ShipSummary
]);
export type Summary = typeof Summary.Type;
