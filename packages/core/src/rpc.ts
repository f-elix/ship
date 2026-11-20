import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { CheckEvent, RunEventEnvelope } from './event.ts';
import {
	AbsolutePath,
	Env,
	NonNegativeInt,
	PositiveInt,
	ProjectKey,
	RunId,
	Timestamp,
	Url
} from './primitives.ts';
import { ReviewSummary, RunStatus, ShipSummary } from './run.ts';

// --- Errors ---

export class RunNotFound extends Schema.TaggedError<RunNotFound>()('RunNotFound', {
	runId: RunId
}) {}

export const PreconditionReason = Schema.Literals([
	'not-a-git-repo',
	'detached-head',
	'unknown-default-branch',
	'on-default-branch',
	'missing-plan-files',
	'dirty-tree',
	'unknown-project-config',
	'invalid-config',
	'pr-not-found',
	'pr-other-repo',
	'pr-not-checked-out',
	'base-fetch-failed'
]);
export type PreconditionReason = typeof PreconditionReason.Type;

export class PreconditionFailed extends Schema.TaggedError<PreconditionFailed>()(
	'PreconditionFailed',
	{
		reason: PreconditionReason,
		/** Human-readable specifics, e.g. which plan files are missing. */
		detail: Schema.String,
		/** The error the check failed with, when it failed on one, e.g. a failed fetch. */
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/** The run's status does not allow the operation, e.g. resuming a finished run. */
export class InvalidRunStatus extends Schema.TaggedError<InvalidRunStatus>()('InvalidRunStatus', {
	runId: RunId,
	status: RunStatus
}) {}

/** The run's stored snapshot cannot be restored, so the run stays `interrupted`. */
export class SnapshotNotResumable extends Schema.TaggedError<SnapshotNotResumable>()(
	'SnapshotNotResumable',
	{ runId: RunId, reason: Schema.String }
) {
	override get message(): string {
		return `Run ${this.runId} cannot be resumed: ${this.reason}`;
	}
}

/** A check command could not start, or ran past the baseline timeout; the pass stopped. */
export class ChecksAborted extends Schema.TaggedError<ChecksAborted>()('ChecksAborted', {
	/** The check that stopped the pass; `null` when it stopped before any check started. */
	check: Schema.NullOr(Schema.String),
	detail: Schema.String
}) {
	override get message(): string {
		return this.detail;
	}
}

/** `stop` without `force` while runs or check passes are active; at least one count is positive. */
export class DaemonBusy extends Schema.TaggedError<DaemonBusy>()('DaemonBusy', {
	activeRuns: NonNegativeInt,
	/** `runChecks` passes in progress, e.g. from `ship init --write`. */
	activeCheckPasses: NonNegativeInt
}) {}

/** CLI and daemon versions differ; the CLI tells the user to `ship daemon restart`. */
export class VersionMismatch extends Schema.TaggedError<VersionMismatch>()('VersionMismatch', {
	clientVersion: Schema.String,
	daemonVersion: Schema.String,
	/** A restart is refused while runs are active, unless forced. */
	activeRuns: NonNegativeInt
}) {}

// --- Payloads and results ---

const runInfoFields = {
	runId: RunId,
	projectKey: ProjectKey,
	/**
	 * The directory the run was started from, and the checkout it works in.
	 */
	cwd: AbsolutePath,
	status: RunStatus,
	/** Machine state value as a dotted path, e.g. `checks.waiting`. */
	state: Schema.String,
	round: NonNegativeInt,
	createdAt: Timestamp,
	updatedAt: Timestamp
};

/** A `ship run`: it implements a plan on a branch and opens a PR. */
export const ShipRunInfo = Schema.Struct({
	...runInfoFields,
	kind: Schema.Literal('ship'),
	planDir: AbsolutePath,
	branch: Schema.NonEmptyString,
	/** The PR the run opened; `null` until it opens one. */
	prUrl: Schema.NullOr(Url),
	/** `null` until the run reaches a terminal status. */
	summary: Schema.NullOr(ShipSummary)
});
export interface ShipRunInfo extends Schema.Schema.Type<typeof ShipRunInfo> {}

/** A `ship review` run: it reviews a PR and may post a review on it. */
export const ReviewRunInfo = Schema.Struct({
	...runInfoFields,
	kind: Schema.Literal('review'),
	/** The reviewed PR. */
	prUrl: Url,
	/** The review the run posted; `null` until it posts one. */
	reviewUrl: Schema.NullOr(Url),
	/** `null` until the run reaches a terminal status. */
	summary: Schema.NullOr(ReviewSummary)
});
export interface ReviewRunInfo extends Schema.Schema.Type<typeof ReviewRunInfo> {}

/** A run as `status` and `list` report it, by its kind. */
export const RunInfo = Schema.Union([ShipRunInfo, ReviewRunInfo]);
export type RunInfo = typeof RunInfo.Type;

const runIdPayload = { runId: RunId };

// --- Group ---

export class ShipRpcs extends RpcGroup.make(
	/** Call first on every connection. Fails with `VersionMismatch` when versions differ. */
	Rpc.make('handshake', {
		payload: { version: Schema.NonEmptyString },
		success: Schema.Struct({ version: Schema.String, activeRuns: NonNegativeInt }),
		error: VersionMismatch
	}),
	Rpc.make('run', {
		payload: { planDir: AbsolutePath, cwd: AbsolutePath, env: Env },
		success: Schema.Struct({ runId: RunId }),
		error: PreconditionFailed
	}),
	/**
	 * Starts a `ship review` run of the GitHub PR `pr` (a number or a PR URL) from `cwd`, a
	 * clone of the PR's base repository. The PR is resolved and its head fetched before the
	 * run is created, so a PR that cannot be reviewed never becomes a run. `post` posts the
	 * findings as one review on the PR.
	 */
	Rpc.make('review', {
		payload: {
			pr: Schema.NonEmptyString,
			post: Schema.Boolean,
			cwd: AbsolutePath,
			env: Env
		},
		success: Schema.Struct({ runId: RunId }),
		error: PreconditionFailed
	}),
	/**
	 * Resumes an `interrupted` run: re-enters its current state and re-runs its step. `env`
	 * is the resuming caller's environment and replaces the one the run was started with.
	 * Config is fixed when the run starts, so resuming reads no config files. Fails with
	 * `SnapshotNotResumable` when the stored snapshot cannot be restored; the run then
	 * stays `interrupted` and can only be cancelled.
	 */
	Rpc.make('resume', {
		payload: { runId: RunId, env: Env },
		error: Schema.Union([RunNotFound, InvalidRunStatus, SnapshotNotResumable])
	}),
	/**
	 * Stops a run and waits until it is finished as `cancelled`. An `interrupted` run is
	 * finished from its event log, without resuming it.
	 */
	Rpc.make('cancel', {
		payload: runIdPayload,
		error: Schema.Union([RunNotFound, InvalidRunStatus])
	}),
	Rpc.make('status', {
		payload: runIdPayload,
		success: RunInfo,
		error: RunNotFound
	}),
	/** Most recently updated first. A run's status is `waiting` while it waits for a check lock. */
	Rpc.make('list', {
		payload: {
			projectKey: Schema.optionalKey(ProjectKey),
			status: Schema.optionalKey(Schema.Array(RunStatus)),
			limit: Schema.optionalKey(PositiveInt)
		},
		success: Schema.Array(RunInfo)
	}),
	/**
	 * Replays the run's events from `fromSeq` (inclusive, default 1), then follows new
	 * events until the run reaches a terminal status or is interrupted: the last event is
	 * then the `RunFinished` or `RunInterrupted` that ended it (see `endsFollow`). With
	 * `follow: false` it ends after the replay. Interrupting the stream detaches; the run
	 * continues.
	 */
	Rpc.make('events', {
		payload: {
			runId: RunId,
			fromSeq: Schema.optionalKey(PositiveInt),
			follow: Schema.optionalKey(Schema.Boolean)
		},
		success: RunEventEnvelope,
		error: RunNotFound,
		stream: true
	}),
	/**
	 * Runs the project's checks once in `cwd` with `env`, as the baseline does: no fix
	 * commands, checks using `{files}` skipped, the baseline timeout per command, and the
	 * daemon's lock permits shared with every run. Streams the pass's events. Reads the
	 * project config now, so `ship init --write` checks the config it just saved. Fails with
	 * `PreconditionFailed` when `cwd` is not in a git repo or the project config is missing
	 * or invalid, and `ChecksAborted` when a command cannot start or times out.
	 */
	Rpc.make('runChecks', {
		payload: { cwd: AbsolutePath, env: Env },
		success: CheckEvent,
		error: Schema.Union([PreconditionFailed, ChecksAborted]),
		stream: true
	}),
	/**
	 * Shuts the daemon down after replying: active runs are interrupted (they become
	 * `interrupted`, ready for `resume`), check passes in progress are interrupted, the
	 * server closes and the socket is removed. Fails with `DaemonBusy` while runs or
	 * `runChecks` passes are active, unless `force` is set.
	 */
	Rpc.make('stop', {
		payload: { force: Schema.optionalKey(Schema.Boolean) },
		error: DaemonBusy
	})
) {}
