import { Schema } from 'effect';
import { LockResource } from './config.ts';
import { DisprovedFinding, Finding, FindingId, VerifiedFinding } from './finding.ts';
import {
	AbsolutePath,
	CostUsd,
	GitSha,
	Millis,
	ModelId,
	NonNegativeInt,
	PositiveInt,
	ProjectKey,
	RunId,
	SessionId,
	Step,
	Timestamp,
	Url
} from './primitives.ts';
import { ReviewerName } from './reviewer.ts';
import { EscalationReason, Summary } from './run.ts';

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
	/** Machine state values as dotted paths, e.g. `checks.waiting`. */
	StateChanged: { ...at, from: Schema.String, to: Schema.String },
	StepStarted: { ...at, step: Step },
	StepEnded: {
		...at,
		step: Step,
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
		step: Step,
		model: ModelId,
		sessionId: SessionId,
		costUsd: CostUsd
	},
	CommitCreated: { ...at, sha: GitSha, message: Schema.String },
	PrOpened: { ...at, url: Url, draft: Schema.Boolean },
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
