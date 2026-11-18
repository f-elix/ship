import { Context, Data, type Effect } from 'effect';
import type { RunEvent, RunEventEnvelope } from './event.ts';
import type { Env, RunId } from './primitives.ts';
import type { InvalidRunStatus, RunNotFound } from './rpc.ts';
import type { RunState, Summary } from './run.ts';

/**
 * A persisted machine snapshot, as XState's `getPersistedSnapshot()` returns it, around a
 * `RunState` context. Keys other than `value` and `context` are stored as they are.
 *
 * The caller's env is recognized by its key: anything that carries it, such as an invoked
 * actor's input, must hold it in a property named `env`, never spread or renamed.
 */
export type PersistedRunSnapshot = {
	readonly value: unknown;
	readonly context: RunState;
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
			'RunCreated' | 'RunFinished' | 'RunCancelled' | 'RunInterrupted' | 'RunResumed';
	}
>;

/** What `loadSnapshot` found. Only `Found` can be resumed. */
export type SnapshotLoad = Data.TaggedEnum<{
	Found: { readonly snapshot: PersistedRunSnapshot };
	/** The run has not saved a snapshot yet. */
	Missing: {};
	/** Saved under another `SNAPSHOT_VERSION`; restoring it is unsafe. */
	IncompatibleVersion: { readonly storedVersion: number; readonly currentVersion: number };
	/** The stored snapshot does not parse or its context is not a valid `RunState`. */
	Corrupt: { readonly error: string };
}>;
export const SnapshotLoad = Data.taggedEnum<SnapshotLoad>();

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
	/** Loads the run's snapshot, putting `env` back wherever `saveSnapshot` removed it. */
	readonly loadSnapshot: (runId: RunId, env: Env) => Effect.Effect<SnapshotLoad, RunNotFound>;
	/**
	 * Sets an `interrupted` run back to `running` and appends `RunResumed`. Fails with
	 * `InvalidRunStatus` for any other status. Call it only once `loadSnapshot` returned
	 * `Found`, so a run that cannot be restored stays `interrupted`.
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
