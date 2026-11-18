import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { RunEventEnvelope } from './event.ts';
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
import { RunStatus, Summary } from './run.ts';

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
	'invalid-config'
]);
export type PreconditionReason = typeof PreconditionReason.Type;

export class PreconditionFailed extends Schema.TaggedError<PreconditionFailed>()(
	'PreconditionFailed',
	{
		reason: PreconditionReason,
		/** Human-readable specifics, e.g. which plan files are missing. */
		detail: Schema.String
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

/** `stop` without `force` while runs are active. */
export class DaemonBusy extends Schema.TaggedError<DaemonBusy>()('DaemonBusy', {
	activeRuns: PositiveInt
}) {}

/** CLI and daemon versions differ; the CLI tells the user to `ship daemon restart`. */
export class VersionMismatch extends Schema.TaggedError<VersionMismatch>()('VersionMismatch', {
	clientVersion: Schema.String,
	daemonVersion: Schema.String,
	/** A restart is refused while runs are active, unless forced. */
	activeRuns: NonNegativeInt
}) {}

// --- Payloads and results ---

export const RunInfo = Schema.Struct({
	runId: RunId,
	projectKey: ProjectKey,
	cwd: AbsolutePath,
	planDir: AbsolutePath,
	branch: Schema.NonEmptyString,
	status: RunStatus,
	/** Machine state value as a dotted path, e.g. `checks.waiting`. */
	state: Schema.String,
	round: NonNegativeInt,
	prUrl: Schema.NullOr(Url),
	createdAt: Timestamp,
	updatedAt: Timestamp,
	/** `null` until the run reaches a terminal status. */
	summary: Schema.NullOr(Summary)
});
export interface RunInfo extends Schema.Schema.Type<typeof RunInfo> {}

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
	 * Shuts the daemon down after replying: active runs are interrupted (they become
	 * `interrupted`, ready for `resume`), the server closes and the socket is removed.
	 * Fails with `DaemonBusy` while runs are active, unless `force` is set.
	 */
	Rpc.make('stop', {
		payload: { force: Schema.optionalKey(Schema.Boolean) },
		error: DaemonBusy
	})
) {}
