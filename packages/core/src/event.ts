import { Schema } from 'effect';
import { LockResource } from './config.ts';
import { DisprovedFinding, Finding, FindingId, VerifiedFinding } from './finding.ts';
import { FindingsSource } from './findings-source.ts';
import { ReviewerName } from './reviewer.ts';
import { EscalationReason, PrimitiveRunKind, RecheckedFinding, Summary } from './run.ts';
import {
	AbsolutePath,
	CostUsd,
	GitSha,
	Millis,
	ModelId,
	NonNegativeInt,
	PositiveInt,
	ProjectKey,
	ReviewId,
	RunId,
	SessionId,
	StepName,
	Timestamp,
	Url
} from './values.ts';

const at = { at: Timestamp };

/** `run` is the check's command; `fix` is its fix command, run just before `run`. */
const CheckCommand = Schema.Literals(['run', 'fix']);

const checkFields = {
	check: Schema.NonEmptyString,
	command: CheckCommand,
	baseline: Schema.Boolean,
	/** Same meaning as in `CheckRound`. */
	round: NonNegativeInt,
	attempt: NonNegativeInt
};

const lockFields = { resource: LockResource, check: Schema.NonEmptyString };

/**
 * Everything that happens in a run. The event log is the source of truth; CLI output,
 * the summary and the UI are views of it. Events are appended without a sequence number;
 * the store wraps each in a {@link RunEventEnvelope}.
 */
export const RunEvent = Schema.TaggedUnion({
	RunCreated: {
		...at,
		projectKey: ProjectKey,
		cwd: AbsolutePath,
		planDir: AbsolutePath,
		branch: Schema.NonEmptyString,
		baseSha: GitSha
	},
	/**
	 * A `ship review` run was created for a pull request: `repoDir` is the checkout it runs
	 * in, at the PR's head, and the run reviews `baseSha..headSha`, pinned at creation.
	 * `baseSha` is the merge base of the PR's base branch and its head.
	 */
	ReviewRunCreated: {
		...at,
		projectKey: ProjectKey,
		repoDir: AbsolutePath,
		prUrl: Url,
		prNumber: PositiveInt,
		baseSha: GitSha,
		headSha: GitSha
	},
	/**
	 * A `ship fix` or `ship recheck` run was created for a pull request's findings, read
	 * from `source`. `repoDir` is the caller's checkout, at `headSha`, the PR's head pinned
	 * at creation; `baseSha` is where the run's range starts.
	 */
	PrRunCreated: {
		...at,
		kind: Schema.Literals(['fix', 'recheck']),
		projectKey: ProjectKey,
		repoDir: AbsolutePath,
		prUrl: Url,
		prNumber: PositiveInt,
		baseSha: GitSha,
		headSha: GitSha,
		source: FindingsSource,
		/** The must-fix findings and nits the run fixes or rechecks. */
		findings: Schema.Array(VerifiedFinding),
		/** The open review threads left out because their author may not push to the repository. */
		ignoredThreads: Schema.Array(Url)
	},
	/**
	 * A `ship implement`, `ship checks`, `ship pr` or `ship post` run was created, by `kind`.
	 * `repoDir` is the caller's checkout and `baseSha` where the run's range starts. The
	 * branch and plan are `null` where the command has none; `review` is the review `post`
	 * posts.
	 */
	PrimitiveRunCreated: {
		...at,
		kind: PrimitiveRunKind,
		projectKey: ProjectKey,
		repoDir: AbsolutePath,
		baseSha: GitSha,
		branch: Schema.NullOr(Schema.NonEmptyString),
		planDir: Schema.NullOr(AbsolutePath),
		review: Schema.NullOr(ReviewId)
	},
	/** Machine state values as dotted paths, e.g. `checks.waiting`. */
	StateChanged: { ...at, from: Schema.String, to: Schema.String },
	StepStarted: { ...at, step: StepName },
	StepEnded: {
		...at,
		step: StepName,
		outcome: Schema.Literals(['ok', 'failed', 'timed-out', 'interrupted']),
		durationMs: Millis,
		error: Schema.optionalKey(Schema.String)
	},
	CheckStarted: { ...at, ...checkFields, commandLine: Schema.String },
	CheckFinished: {
		...at,
		...checkFields,
		exitCode: Schema.Int,
		durationMs: Millis,
		/** Trimmed tail of the combined output. */
		outputTail: Schema.String
	},
	LockWaiting: {
		...at,
		...lockFields,
		/** 1-based place in the resource's queue when the wait began. */
		position: Schema.optionalKey(PositiveInt)
	},
	LockAcquired: { ...at, ...lockFields, waitedMs: Millis },
	LockReleased: { ...at, ...lockFields },
	/** Reviewers routed for the round and the range they review, `fromSha..toSha`. */
	ReviewStarted: {
		...at,
		round: PositiveInt,
		fromSha: GitSha,
		toSha: GitSha,
		reviewers: Schema.Array(ReviewerName)
	},
	FindingsReported: {
		...at,
		round: PositiveInt,
		reviewer: ReviewerName,
		findings: Schema.Array(Finding)
	},
	FindingsVerified: {
		...at,
		round: PositiveInt,
		verified: Schema.Array(VerifiedFinding),
		disproved: Schema.Array(DisprovedFinding)
	},
	/** Verified findings still unresolved after triage, by id. */
	FindingsTriaged: {
		...at,
		round: PositiveInt,
		mustFix: Schema.Array(FindingId),
		tradeoffs: Schema.Array(FindingId),
		nits: Schema.Array(FindingId)
	},
	Escalated: { ...at, reason: EscalationReason },
	/** Cost of one agent call. */
	AgentCost: {
		...at,
		step: StepName,
		model: ModelId,
		sessionId: SessionId,
		costUsd: CostUsd
	},
	CommitCreated: { ...at, sha: GitSha, message: Schema.String },
	PrOpened: { ...at, url: Url, draft: Schema.Boolean },
	/** The run stored its review, which later commands find by `reviewId`. */
	ReviewStored: { ...at, reviewId: ReviewId },
	/**
	 * `ship review --post` posted its review: `inline` findings as comments on diff lines,
	 * `inBody` findings listed in the review body.
	 */
	PrReviewPosted: {
		...at,
		url: Url,
		event: Schema.Literals(['COMMENT', 'REQUEST_CHANGES']),
		inline: NonNegativeInt,
		inBody: NonNegativeInt
	},
	/** `recheck` checked earlier findings against the code: each one's status and evidence. */
	FindingsRechecked: { ...at, findings: Schema.Array(RecheckedFinding) },
	/** A fixed finding's review thread was resolved on GitHub. */
	ThreadResolved: { ...at, findingId: FindingId, threadId: Schema.String },
	/** HEAD was pushed to branch `ref` of `remote`, a remote name or URL. */
	BranchPushed: { ...at, sha: GitSha, remote: Schema.String, ref: Schema.String },
	RunFinished: { ...at, summary: Summary },
	/** The daemon stopped while the run was active; `ship resume` continues it. */
	RunInterrupted: { ...at },
	RunResumed: { ...at },
	RunCancelled: { ...at }
});
export type RunEvent = typeof RunEvent.Type;

/**
 * A stored event this build cannot decode, e.g. one written by a newer ship. Reading the
 * log never fails on such an event; it comes back as this entry instead.
 */
export const UnknownEvent = Schema.TaggedStruct('UnknownEvent', {
	/** The stored event's `_tag`. */
	type: Schema.String,
	/** The stored event as JSON text. */
	json: Schema.String,
	/** Why decoding failed. */
	error: Schema.String
});
export interface UnknownEvent extends Schema.Schema.Type<typeof UnknownEvent> {}

/**
 * Whether a followed event stream ends after this event: the run has nothing more to say
 * until it is resumed. The stream's last event is the one that ended it.
 */
export const endsFollow = (
	event: RunEvent | UnknownEvent
): event is Extract<RunEvent, { _tag: 'RunFinished' | 'RunInterrupted' }> =>
	event._tag === 'RunFinished' || event._tag === 'RunInterrupted';

/** The events of one pass of checks: what `Checks.run` emits and `runChecks` streams. */
export const CheckEvent = Schema.Union([
	RunEvent.cases.CheckStarted,
	RunEvent.cases.CheckFinished,
	RunEvent.cases.LockWaiting,
	RunEvent.cases.LockAcquired,
	RunEvent.cases.LockReleased
]);
export type CheckEvent = typeof CheckEvent.Type;

/** A stored event: its run and its 1-based position in that run's log. */
export const RunEventEnvelope = Schema.Struct({
	runId: RunId,
	seq: PositiveInt,
	event: Schema.Union([RunEvent, UnknownEvent])
});
export interface RunEventEnvelope extends Schema.Schema.Type<typeof RunEventEnvelope> {}
