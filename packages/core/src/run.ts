import { Schema } from 'effect';
import { ResolvedConfig } from './config.ts';
import { VerifiedFinding } from './finding.ts';
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

export const EscalationReason = Schema.Literals(['check-fix-cap', 'review-cap', 'stall']);
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
 * The machine context, persisted in snapshots. Values the run has not produced yet are
 * `null` so the context always has the same keys.
 */
export const RunState = Schema.Struct({
	runId: RunId,
	projectKey: ProjectKey,
	cwd: AbsolutePath,
	env: Env,
	planDir: AbsolutePath,
	branch: Schema.NonEmptyString,
	baseSha: GitSha,
	/** Resolved when the run is created; later config edits do not change it. */
	config: ResolvedConfig,
	/** Set by `implement`; every fix step resumes this session. */
	implementerSession: Schema.NullOr(AgentSession),
	/** Current review round; 0 before the first review. */
	round: NonNegativeInt,
	/** Check-fix attempts in the current round. */
	checkFixAttempts: NonNegativeInt,
	lastReviewedSha: Schema.NullOr(GitSha),
	reviewRounds: Schema.Array(ReviewRound),
	unresolved: UnresolvedFindings,
	checks: Schema.Array(CheckRound),
	costUsd: CostUsd,
	prUrl: Schema.NullOr(Url),
	escalationReason: Schema.NullOr(EscalationReason)
});
export interface RunState extends Schema.Schema.Type<typeof RunState> {}

/**
 * Format version of persisted run snapshots (the machine snapshot around `RunState`).
 * Bump it when a change to `RunState` or the machine's states makes older snapshots
 * unsafe to restore; runs saved under another version can no longer be resumed.
 */
export const SNAPSHOT_VERSION = 1;

/** The JSON `ship run` prints on stdout when the run ends; also kept in the run store. */
export const Summary = Schema.Struct({
	runId: RunId,
	status: TerminalRunStatus,
	prUrl: Schema.NullOr(Url),
	rounds: NonNegativeInt,
	/** Every check pass; a failing baseline keeps its output tail here. */
	checks: Schema.Array(CheckRound),
	costUsd: CostUsd,
	unresolvedMustFix: Schema.Array(VerifiedFinding),
	tradeoffs: Schema.Array(VerifiedFinding),
	nits: Schema.Array(VerifiedFinding),
	escalationReason: Schema.NullOr(EscalationReason),
	/** Why the run failed, when `status` is `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface Summary extends Schema.Schema.Type<typeof Summary> {}
