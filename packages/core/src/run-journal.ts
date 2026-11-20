import { Context, Data, type Effect, type Option } from 'effect';
import type { RunEvent, RunEventEnvelope } from './event.ts';
import type { FixRunState, RecheckRunState } from './pr-run.ts';
import type { PrimitiveRunState } from './primitive-run.ts';
import type { ReviewRunState } from './review-run.ts';
import type { InvalidRunStatus, RunNotFound } from './rpc.ts';
import type { RunState, Summary } from './run.ts';
import type { Env, RunId } from './values.ts';

/**
 * A persisted machine snapshot, as XState's `getPersistedSnapshot()` returns it, around a
 * `RunState` context, or the context of another kind of run: `ReviewRunState`,
 * `FixRunState`, `RecheckRunState` or `PrimitiveRunState`. Keys other than `value` and `context` are stored as they are.
 *
 * The caller's env is recognized by its key: anything that carries it, such as an invoked
 * actor's input, must hold it in a property named `env`, never spread or renamed.
 */
export type PersistedRunSnapshot = {
	readonly value: unknown;
	readonly context: RunState | ReviewRunState | FixRunState | RecheckRunState | PrimitiveRunState;
	readonly [key: string]: unknown;
};

/**
 * Events a caller appends directly. The others go through the method that also changes the
 * run's status, so the log and the run record agree: creating the run, `finish` (which
 * appends `RunCancelled` for a cancelled run), marking it interrupted and `markResumed`.
 */
export type AppendableEvent = Exclude<
	RunEvent,
	{
		readonly _tag:
			| 'RunCreated'
			| 'ReviewRunCreated'
			| 'PrRunCreated'
			| 'PrimitiveRunCreated'
			| 'RunFinished'
			| 'RunCancelled'
			| 'RunInterrupted'
			| 'RunResumed';
	}
>;

/** What `loadSnapshot` found. Only `Found` can be resumed. */
export type SnapshotLoad = Data.TaggedEnum<{
	Found: { readonly snapshot: PersistedRunSnapshot };
	/** The run has not saved a snapshot yet. */
	Missing: {};
	/** Saved under another `SNAPSHOT_VERSION`; restoring it is unsafe. */
	IncompatibleVersion: { readonly storedVersion: number; readonly currentVersion: number };
	/** The stored snapshot does not parse or its context is not a valid run state of any kind. */
	Corrupt: { readonly error: string };
}>;
export const SnapshotLoad = Data.taggedEnum<SnapshotLoad>();

/** A checkpoint value as the journal keeps it: the encoded JSON value under its full key. */
export interface StoredCheckpoint {
	readonly runId: RunId;
	readonly key: string;
	readonly value: unknown;
}

/** The part of the run store a run driver needs; the store package provides it. */
export interface RunJournalShape {
	/**
	 * Replaces the run's snapshot (the run is `snapshot.context.runId`) and updates the
	 * run's state, round and PR URL from it; save one on every state change. Every `env`
	 * property is removed before storing.
	 *
	 * `events` (e.g. the transition's `StateChanged`) are appended in the same transaction,
	 * so the log and the snapshot never disagree after a crash. Fails with
	 * `InvalidRunStatus` when there are events and the run finished.
	 */
	readonly saveSnapshot: (
		snapshot: PersistedRunSnapshot,
		events?: ReadonlyArray<AppendableEvent>
	) => Effect.Effect<ReadonlyArray<RunEventEnvelope>, RunNotFound | InvalidRunStatus>;
	/**
	 * Stores a checkpoint value, replacing any under the same key, and appends `events` in
	 * the same transaction: the events a step reported before the checkpoint, so a
	 * restored value never stands for events the log lacks. Fails with `InvalidRunStatus`
	 * when the run finished.
	 */
	readonly saveCheckpoint: (
		checkpoint: StoredCheckpoint,
		events?: ReadonlyArray<AppendableEvent>
	) => Effect.Effect<ReadonlyArray<RunEventEnvelope>, RunNotFound | InvalidRunStatus>;
	/** The checkpoint value stored under `key` for the run, if any. */
	readonly loadCheckpoint: (
		runId: RunId,
		key: string
	) => Effect.Effect<Option.Option<unknown>, RunNotFound>;
	/** Loads the run's snapshot, putting `env` back wherever `saveSnapshot` removed it. */
	readonly loadSnapshot: (runId: RunId, env: Env) => Effect.Effect<SnapshotLoad, RunNotFound>;
	/**
	 * Sets an `interrupted` or `failed` run back to `running`, clears a failed run's summary
	 * and appends `RunResumed`. Fails with `InvalidRunStatus` for any other status. Call it
	 * only once `loadSnapshot` returned `Found`, so a run that cannot be restored keeps its
	 * status.
	 */
	readonly markResumed: (
		runId: RunId
	) => Effect.Effect<RunEventEnvelope, RunNotFound | InvalidRunStatus>;
	/** The run's events from `fromSeq` (inclusive, default 1), in seq order. */
	readonly events: (
		runId: RunId,
		fromSeq?: number
	) => Effect.Effect<ReadonlyArray<RunEventEnvelope>, RunNotFound>;
	/**
	 * Stores the summary, sets the run's status to `summary.status` and appends `RunFinished`,
	 * preceded by `RunCancelled` for a cancelled run. Returns the `RunFinished` envelope.
	 * Fails with `InvalidRunStatus` when the run already finished.
	 */
	readonly finish: (
		summary: Summary
	) => Effect.Effect<RunEventEnvelope, RunNotFound | InvalidRunStatus>;
}

/** Where a run's snapshots and events are kept. */
export class RunJournal extends Context.Service<RunJournal, RunJournalShape>()(
	'@ship/core/RunJournal'
) {}
