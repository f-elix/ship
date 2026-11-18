import { createEffectActor, type RequirementsFrom } from '@xstate/effect';
import {
	Cause,
	Data,
	DateTime,
	Deferred,
	Effect,
	Exit,
	Predicate,
	Queue,
	Schema,
	Scope
} from 'effect';
import type { RunEvent } from './event.ts';
import { describeDefect, pipelineMachine, stepInput, type PipelineMachine } from './pipeline.ts';
import { RunId, type Env } from './primitives.ts';
import type { InvalidRunStatus, RunNotFound } from './rpc.ts';
import {
	RunJournal,
	SnapshotLoad,
	type AppendableEvent,
	type PersistedRunSnapshot
} from './run-journal.ts';
import { RunReporter } from './run-step.ts';
import { buildSummary } from './run-summary.ts';
import type { RunState, Summary, TerminalRunStatus } from './run.ts';
import { statePath } from './state-path.ts';

// --- Public types ---

export interface RunHandle {
	readonly runId: RunId;
	/** The machine's current state as a dotted path, e.g. `checks.waiting`. */
	readonly state: Effect.Effect<string>;
	/**
	 * Stops the run: the machine moves to `cancelled`, which interrupts the step in flight
	 * and kills its agent or check processes. Does nothing once the run ended.
	 */
	readonly cancel: Effect.Effect<void>;
	/** Waits for the run to end and returns the summary it was finished with. */
	readonly await: Effect.Effect<Summary, RunNotFound | InvalidRunStatus>;
}

/** The services the pipeline's steps use; the driver adds `RunReporter` itself. */
export type PipelineServices = Exclude<RequirementsFrom<PipelineMachine>, RunReporter>;

/** The run's stored snapshot cannot be restored, so the run stays `interrupted`. */
export class SnapshotNotResumable extends Schema.TaggedError<SnapshotNotResumable>()(
	'SnapshotNotResumable',
	{ runId: RunId, reason: Schema.String }
) {
	override get message(): string {
		return `Run ${this.runId} cannot be resumed: ${this.reason}`;
	}
}

// --- Driver ---

/** A new run from its initial state, or an interrupted one from its last snapshot. */
type RunStart = Data.TaggedEnum<{
	New: { readonly state: RunState };
	Restore: { readonly snapshot: PersistedRunSnapshot };
}>;
const RunStart = Data.taggedEnum<RunStart>();

interface RunEnd {
	readonly status: TerminalRunStatus;
	readonly error: string | null;
}

interface SnapshotItem {
	readonly _tag: 'Snapshot';
	readonly path: string;
	readonly persisted: PersistedRunSnapshot;
	/** Set once the machine stopped: its final state, or an error. */
	readonly end: RunEnd | null;
}

type Item = { readonly _tag: 'Event'; readonly event: AppendableEvent } | SnapshotItem;

const FINAL: Readonly<Record<string, TerminalRunStatus>> = {
	done: 'done',
	escalated: 'escalated',
	failed: 'failed',
	cancelled: 'cancelled'
};

const isKnown = (event: RunEvent | { readonly _tag: 'UnknownEvent' }): event is RunEvent =>
	event._tag !== 'UnknownEvent';

/** How a machine that reached a final state ended. */
const finalEnd = (path: string, context: RunState): RunEnd => ({
	status: FINAL[path] ?? 'failed',
	error: context.error
});

/** Builds the summary from the run's event log and finishes the run with it. */
const finishFromLog = Effect.fnUntraced(function* (runId: RunId, end: RunEnd) {
	const journal = yield* RunJournal;
	const events = (yield* journal.events(runId)).map((envelope) => envelope.event).filter(isKnown);
	const summary = buildSummary({ runId, status: end.status, events, error: end.error });
	yield* journal.finish(summary);
	return summary;
});

/**
 * Starts a new run from its initial state. See {@link runMachine}; an interrupted run
 * continues through {@link resumeRun}.
 */
export const startRun = Effect.fn('startRun')(function* (state: RunState) {
	return yield* runMachine(RunStart.New({ state }));
});

/**
 * Runs the pipeline machine for one run until it ends. Every state change saves the
 * snapshot together with the events since the last save, `StateChanged` last; events
 * reported mid-step are saved as they come. At the end it builds the summary from the
 * event log and finishes the run in the journal.
 *
 * The run lives in the caller's scope: closing it interrupts the run without finishing
 * it, which is how a stopping daemon leaves runs to be marked `interrupted`.
 */
const runMachine = Effect.fnUntraced(function* (start: RunStart) {
	const journal = yield* RunJournal;
	const items = yield* Queue.unbounded<Item>();
	const reporter = RunReporter.of({
		report: (event) => Effect.asVoid(Queue.offer(items, { _tag: 'Event', event }))
	});

	const actorScope = yield* Scope.fork(yield* Effect.scope);
	const actor = yield* createEffectActor(
		pipelineMachine,
		start._tag === 'New' ? { input: start.state } : { snapshot: restorable(start.snapshot) }
	).pipe(Effect.provideService(RunReporter, reporter), Scope.provide(actorScope));
	const runId = actor.getSnapshot().context.runId;

	const toItem = (): SnapshotItem => {
		const snapshot = actor.getSnapshot();
		const path = statePath(snapshot.value);
		const end =
			snapshot.status === 'error'
				? { status: 'failed' as const, error: describeDefect(snapshot.error) }
				: snapshot.status === 'done'
					? finalEnd(path, snapshot.context)
					: null;
		const persisted: PersistedRunSnapshot = {
			...actor.getPersistedSnapshot(),
			value: snapshot.value,
			context: snapshot.context
		};
		return { _tag: 'Snapshot', path, persisted, end };
	};
	// Subscribe before yielding, so no transition is missed.
	actor.subscribe({
		next: () => void Queue.offerUnsafe(items, toItem()),
		error: () => void Queue.offerUnsafe(items, toItem())
	});
	const initial = toItem();

	let path = initial.path;
	let persisted = initial.persisted;
	let pending: Array<AppendableEvent> = [];
	const save = Effect.fnUntraced(function* () {
		yield* journal.saveSnapshot(persisted, pending);
		pending = [];
	});
	const process = Effect.fnUntraced(function* (batch: ReadonlyArray<Item>) {
		let end: RunEnd | null = null;
		for (const item of batch) {
			if (item._tag === 'Event') {
				pending.push(item.event);
				continue;
			}
			persisted = item.persisted;
			end = end ?? item.end;
			if (item.path !== path) {
				pending.push({
					_tag: 'StateChanged',
					at: yield* DateTime.now,
					from: path,
					to: item.path
				});
				path = item.path;
				yield* save();
			}
		}
		if (pending.length > 0) yield* save();
		return end;
	});
	// Only the wait is interruptible: a batch taken off the queue is always saved whole.
	const next = Effect.uninterruptibleMask((restore) =>
		Effect.flatMap(restore(Queue.takeAll(items)), process)
	);

	const drive = Effect.gen(function* () {
		// The first save stores the initial (or restored) snapshot without a transition.
		yield* Effect.uninterruptible(save());
		let end = initial.end;
		while (end === null) end = yield* next;
		// Closing the actor's scope waits for the interrupted step to report how it ended.
		yield* Scope.close(actorScope, Exit.void);
		yield* process(yield* Queue.clear(items));
		return yield* finishFromLog(runId, end);
	}).pipe(
		// Interrupted without finishing (the daemon stops): keep what the run got to, so it
		// resumes from its latest state, then the events of the step shutting down. The
		// stopped actor's own snapshots are left out: the run resumes as it was before.
		Effect.onInterrupt(() =>
			Effect.gen(function* () {
				yield* process(yield* Queue.clear(items));
				yield* Scope.close(actorScope, Exit.void);
				const rest = yield* Queue.clear(items);
				yield* process(rest.filter((item) => item._tag === 'Event'));
			}).pipe(Effect.ignore({ log: true }))
		),
		// The journal failed: stop the machine too, so no step runs without being saved.
		Effect.onError((cause) =>
			Cause.hasInterruptsOnly(cause) ? Effect.void : Scope.close(actorScope, Exit.void)
		)
	);

	const done = yield* Deferred.make<Summary, RunNotFound | InvalidRunStatus>();
	yield* drive.pipe(
		Effect.exit,
		Effect.flatMap((exit) => Deferred.done(done, exit)),
		Effect.forkScoped
	);

	return {
		runId,
		state: Effect.sync(() => statePath(actor.getSnapshot().value)),
		cancel: Effect.sync(() => {
			if (actor.getSnapshot().status === 'active') actor.send({ type: 'cancel' });
		}),
		await: Deferred.await(done)
	} satisfies RunHandle;
});

/**
 * The stored snapshot as XState restores it. Only runs that were still active get
 * stored for resuming, so the status is `active`; the rest of the snapshot is passed
 * through as XState persisted it, except for finished children (below).
 */
const restorable = (snapshot: PersistedRunSnapshot) => ({
	...snapshot,
	status: 'active' as const,
	output: undefined,
	error: undefined,
	children: rerunFinishedChildren(snapshot)
});

/**
 * A step actor can finish and be saved before the machine takes its result, when the
 * run stops between the two. The machine never moved on, so that step is still in
 * flight: it restarts with the run's context as its input, which is what every state's
 * `invoke` passes it.
 */
const rerunFinishedChildren = (snapshot: PersistedRunSnapshot): unknown => {
	const children = snapshot['children'];
	if (!Predicate.isObject(children)) return children;
	return Object.fromEntries(
		Object.entries(children).map(([id, child]) =>
			Predicate.isObject(child) &&
			Predicate.isObject(child['snapshot']) &&
			child['snapshot']['status'] !== 'active'
				? [id, { ...child, snapshot: { status: 'active', input: stepInput(snapshot) } }]
				: [id, child]
		)
	);
};

const describeLoad = (load: SnapshotLoad): string =>
	SnapshotLoad.$match(load, {
		Found: () => 'found',
		Missing: () => 'it never saved a snapshot',
		IncompatibleVersion: ({ storedVersion, currentVersion }) =>
			`its snapshot has format version ${storedVersion}, this ship reads version ${currentVersion}`,
		Corrupt: ({ error }) => `its snapshot is unreadable: ${error}`
	});

/**
 * Resumes an interrupted run from its last snapshot with the caller's fresh `env`. The
 * step that was in flight runs again. The run is marked resumed only once its snapshot
 * loaded, so a run that cannot be restored stays `interrupted`. A run that stopped after
 * its machine reached a final state, but before it was finished, is finished now.
 */
export const resumeRun = Effect.fn('resumeRun')(function* (runId: RunId, env: Env) {
	const journal = yield* RunJournal;
	const load = yield* journal.loadSnapshot(runId, env);
	if (load._tag !== 'Found') {
		return yield* new SnapshotNotResumable({ runId, reason: describeLoad(load) });
	}
	const { snapshot } = load;
	if (snapshot['status'] === 'done') {
		const path = statePath(snapshot.value);
		yield* journal.markResumed(runId);
		const summary = yield* finishFromLog(runId, finalEnd(path, snapshot.context));
		return {
			runId,
			state: Effect.succeed(path),
			cancel: Effect.void,
			await: Effect.succeed(summary)
		} satisfies RunHandle;
	}
	if (snapshot['status'] !== 'active') {
		return yield* new SnapshotNotResumable({
			runId,
			reason: 'its snapshot is of a stopped machine'
		});
	}
	yield* journal.markResumed(runId);
	return yield* runMachine(RunStart.Restore({ snapshot }));
});
