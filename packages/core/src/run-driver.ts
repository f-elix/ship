import { createEffectActor, type RequirementsFrom } from '@xstate/effect';
import { Cause, Data, DateTime, Deferred, Effect, Exit, Predicate, Queue, Scope } from 'effect';
import type { StateValue } from 'xstate';
import { Checkpoint, makeCheckpoint } from './checkpoint.ts';
import type { RunEvent } from './event.ts';
import { fixMachine, type FixMachine } from './fix-pipeline.ts';
import type { Git } from './git.ts';
import { describeDefect, stepInput } from './machine-kit.ts';
import { pipelineMachine, type PipelineMachine } from './pipeline.ts';
import {
	buildFixSummary,
	buildRecheckSummary,
	type FixRunState,
	type RecheckRunState
} from './pr-run.ts';
import { primitiveMachine, type PrimitiveMachine } from './primitive-pipeline.ts';
import { buildPrimitiveSummary, type PrimitiveRunState } from './primitive-run.ts';
import { recheckMachine, type RecheckMachine } from './recheck-pipeline.ts';
import { reviewMachine, type ReviewMachine } from './review-pipeline.ts';
import { buildReviewSummary, type ReviewRunState } from './review-run.ts';
import { SnapshotNotResumable, type InvalidRunStatus, type RunNotFound } from './rpc.ts';
import {
	RunJournal,
	SnapshotLoad,
	type AppendableEvent,
	type PersistedRunSnapshot,
	type StoredCheckpoint
} from './run-journal.ts';
import { RunReporter } from './run-step.ts';
import { buildSummary, type SummaryInput } from './run-summary.ts';
import type {
	FixSummary,
	PrimitiveSummary,
	RecheckSummary,
	ReviewSummary,
	RunState,
	ShipSummary,
	Summary,
	TerminalRunStatus
} from './run.ts';
import type { ShipHome } from './ship-paths.ts';
import { statePath } from './state-path.ts';
import type { Env, RunId } from './values.ts';

// --- Public types ---

export interface RunHandle<S extends Summary = Summary> {
	readonly runId: RunId;
	/** The machine's current state as a dotted path, e.g. `checks.waiting`. */
	readonly state: Effect.Effect<string>;
	/**
	 * Stops the run: the machine moves to `cancelled`, which interrupts the step in flight
	 * and kills its agent or check processes. Does nothing once the run ended.
	 */
	readonly cancel: Effect.Effect<void>;
	/** Waits for the run to end and returns the summary it was finished with. */
	readonly await: Effect.Effect<S, RunNotFound | InvalidRunStatus>;
}

/**
 * The services every machine's steps use; the driver adds `RunReporter` and `Checkpoint`
 * itself, per run.
 */
export type PipelineServices =
	| Exclude<
			| RequirementsFrom<PipelineMachine>
			| RequirementsFrom<ReviewMachine>
			| RequirementsFrom<FixMachine>
			| RequirementsFrom<RecheckMachine>
			| RequirementsFrom<PrimitiveMachine>,
			RunReporter | Checkpoint
	  >
	| Git
	| ShipHome;

// --- Run kinds ---

/** A machine's context: a `ship run`, `ship review`, `ship fix`, `ship recheck` or primitive run's. */
type KindContext = PersistedRunSnapshot['context'];

/**
 * What the driver uses of a running actor, whatever its machine. Each kind creates its
 * own actor with its machine's full types; the driver sees only this.
 */
interface RunActor<C extends KindContext> {
	readonly getSnapshot: () => {
		readonly value: StateValue;
		readonly status: string;
		readonly context: C;
		readonly error: unknown;
	};
	readonly getPersistedSnapshot: () => object;
	readonly subscribe: (observer: {
		readonly next: () => void;
		readonly error: () => void;
	}) => unknown;
	readonly send: (event: { readonly type: 'cancel' }) => void;
}

/**
 * A kind of run: `ship run`, `ship review`, `ship fix`, `ship recheck` or a primitive run.
 * The driver picks one by the run's context when it starts or resumes it, and by its log
 * when it cancels a run with no machine.
 */
interface RunKind<C extends KindContext, S extends Summary> {
	/** Creates the actor, from its input for a new run or from a stored snapshot. */
	readonly spawn: (
		start: { readonly input: C } | { readonly snapshot: ReturnType<typeof restorable> }
	) => Effect.Effect<
		RunActor<C>,
		never,
		PipelineServices | RunReporter | Checkpoint | Scope.Scope
	>;
	/** Throws when `value` names states the machine does not have. */
	readonly resolve: (value: StateValue, context: C) => void;
	readonly summarize: (input: SummaryInput) => S;
}

const shipKind: RunKind<RunState, ShipSummary> = {
	spawn: (start) => createEffectActor(pipelineMachine, start),
	resolve: (value, context) => void pipelineMachine.resolveState({ value, context }),
	summarize: buildSummary
};

const reviewKind: RunKind<ReviewRunState, ReviewSummary> = {
	spawn: (start) => createEffectActor(reviewMachine, start),
	resolve: (value, context) => void reviewMachine.resolveState({ value, context }),
	summarize: buildReviewSummary
};

const fixKind: RunKind<FixRunState, FixSummary> = {
	spawn: (start) => createEffectActor(fixMachine, start),
	resolve: (value, context) => void fixMachine.resolveState({ value, context }),
	summarize: buildFixSummary
};

const recheckKind: RunKind<RecheckRunState, RecheckSummary> = {
	spawn: (start) => createEffectActor(recheckMachine, start),
	resolve: (value, context) => void recheckMachine.resolveState({ value, context }),
	summarize: buildRecheckSummary
};

/** `ship implement`, `ship checks`, `ship pr` and `ship post`, which share a machine. */
const primitiveKind: RunKind<PrimitiveRunState, PrimitiveSummary> = {
	spawn: (start) => createEffectActor(primitiveMachine, start),
	resolve: (value, context) => void primitiveMachine.resolveState({ value, context }),
	summarize: buildPrimitiveSummary
};

/**
 * The kind of a run whose log is `events`, by its creation event: `ReviewRunCreated`,
 * `PrRunCreated` with its kind, or `PrimitiveRunCreated`; any other log is a `ship run`'s.
 */
const kindOfLog = (events: ReadonlyArray<RunEvent>): LogFinisher<Summary> => {
	for (const event of events) {
		if (event._tag === 'ReviewRunCreated') return reviewKind;
		if (event._tag === 'PrRunCreated') return event.kind === 'fix' ? fixKind : recheckKind;
		if (event._tag === 'PrimitiveRunCreated') return primitiveKind;
	}
	return shipKind;
};

// --- Driver ---

/** A new run from its initial state, or an interrupted one from its last snapshot. */
type RunStart<C> = Data.TaggedEnum<{
	New: { readonly state: C };
	Restore: { readonly snapshot: PersistedRunSnapshot };
}>;

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

/** A checkpoint to save once the events before it are; `saved` completes when it is. */
interface CheckpointItem {
	readonly _tag: 'Checkpoint';
	readonly checkpoint: StoredCheckpoint;
	readonly saved: Deferred.Deferred<void>;
}

type Item =
	{ readonly _tag: 'Event'; readonly event: AppendableEvent } | SnapshotItem | CheckpointItem;

const FINAL: Readonly<Record<string, TerminalRunStatus>> = {
	done: 'done',
	escalated: 'escalated',
	failed: 'failed',
	cancelled: 'cancelled'
};

const isKnown = (event: RunEvent | { readonly _tag: 'UnknownEvent' }): event is RunEvent =>
	event._tag !== 'UnknownEvent';

/** How a machine that reached a final state ended. */
const finalEnd = (path: string, context: KindContext): RunEnd => ({
	status: FINAL[path] ?? 'failed',
	error: context.error
});

const readLog = Effect.fnUntraced(function* (runId: RunId) {
	const journal = yield* RunJournal;
	return (yield* journal.events(runId)).map((envelope) => envelope.event).filter(isKnown);
});

/** What finishing a run from its log uses of its kind, whatever its machine's context. */
type LogFinisher<S extends Summary> = Pick<RunKind<KindContext, S>, 'summarize'>;

/** Builds the summary from the run's event log and finishes the run with it. */
const finishFromLog = Effect.fnUntraced(function* <S extends Summary>(
	kind: LogFinisher<S>,
	runId: RunId,
	end: RunEnd
) {
	const journal = yield* RunJournal;
	const events = yield* readLog(runId);
	const summary = kind.summarize({ runId, status: end.status, events, error: end.error });
	yield* journal.finish(summary);
	return summary;
});

/**
 * Finishes a run that has no machine running, such as an `interrupted` one, as
 * `cancelled`. The summary comes from the event log, so no snapshot is needed.
 */
export const cancelFromLog = Effect.fn('cancelFromLog')(function* (runId: RunId) {
	const kind: LogFinisher<Summary> = kindOfLog(yield* readLog(runId));
	return yield* finishFromLog(kind, runId, { status: 'cancelled', error: null });
});

/**
 * Starts a new `ship run` from its initial state. See {@link runMachine}; an interrupted
 * run continues through {@link resumeRun}.
 */
export const startRun = Effect.fn('startRun')(function* (state: RunState) {
	return yield* runMachine(shipKind, { _tag: 'New', state });
});

/** Starts a new `ship review` run from its initial state, like {@link startRun}. */
export const startReview = Effect.fn('startReview')(function* (state: ReviewRunState) {
	return yield* runMachine(reviewKind, { _tag: 'New', state });
});

/** Starts a new `ship fix` run from its initial state, like {@link startRun}. */
export const startFix = Effect.fn('startFix')(function* (state: FixRunState) {
	return yield* runMachine(fixKind, { _tag: 'New', state });
});

/** Starts a new `ship recheck` run from its initial state, like {@link startRun}. */
export const startRecheck = Effect.fn('startRecheck')(function* (state: RecheckRunState) {
	return yield* runMachine(recheckKind, { _tag: 'New', state });
});

/**
 * Starts a new `ship implement`, `ship checks`, `ship pr` or `ship post` run from its
 * initial state, like {@link startRun}.
 */
export const startPrimitiveRun = Effect.fn('startPrimitiveRun')(function* (
	state: PrimitiveRunState
) {
	return yield* runMachine(primitiveKind, { _tag: 'New', state });
});

/**
 * Runs the kind's machine for one run until it ends. Every state change saves the
 * snapshot together with the events since the last save, `StateChanged` last; events
 * reported mid-step are saved as they come. A checkpoint is saved in order with the
 * events, together with the ones before it, and its step waits until it is. At the end
 * it builds the summary from the event log and finishes the run in the journal.
 *
 * The run lives in the caller's scope: closing it interrupts the run without finishing
 * it, which is how a stopping daemon leaves runs to be marked `interrupted`.
 */
const runMachine = Effect.fnUntraced(function* <C extends KindContext, S extends Summary>(
	kind: RunKind<C, S>,
	start: RunStart<C>
) {
	const journal = yield* RunJournal;
	const items = yield* Queue.unbounded<Item>();
	const reporter = RunReporter.of({
		report: (event) => Effect.asVoid(Queue.offer(items, { _tag: 'Event', event }))
	});
	const runId = start._tag === 'New' ? start.state.runId : start.snapshot.context.runId;
	const checkpoint = makeCheckpoint({
		load: (key) => Effect.orDie(journal.loadCheckpoint(runId, key)),
		save: (key, value) =>
			Effect.gen(function* () {
				const saved = yield* Deferred.make<void>();
				yield* Queue.offer(items, {
					_tag: 'Checkpoint',
					checkpoint: { runId, key, value },
					saved
				});
				yield* Deferred.await(saved);
			})
	});

	const actorScope = yield* Scope.fork(yield* Effect.scope);
	const actor = yield* kind
		.spawn(
			start._tag === 'New' ? { input: start.state } : { snapshot: restorable(start.snapshot) }
		)
		.pipe(
			Effect.provideService(RunReporter, reporter),
			Effect.provideService(Checkpoint, checkpoint),
			Scope.provide(actorScope)
		);

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
			if (item._tag === 'Checkpoint') {
				yield* journal.saveCheckpoint(item.checkpoint, pending);
				pending = [];
				yield* Deferred.succeed(item.saved, undefined);
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
		return yield* finishFromLog(kind, runId, end);
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

	const done = yield* Deferred.make<S, RunNotFound | InvalidRunStatus>();
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
	} satisfies RunHandle<S>;
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

/** Whether `value` is shaped like a state value: a state name, or nested state names. */
const isStateValue = (value: unknown): value is StateValue =>
	typeof value === 'string' ||
	(Predicate.isObject(value) &&
		!Array.isArray(value) &&
		Object.values(value).every((child) => child === undefined || isStateValue(child)));

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
 * loaded and fits the machine, so a run that cannot be restored stays `interrupted`. A
 * run that stopped after its machine reached a final state, but before it was finished,
 * is finished now.
 */
export const resumeRun = Effect.fn('resumeRun')(function* (runId: RunId, env: Env) {
	const journal = yield* RunJournal;
	const load = yield* journal.loadSnapshot(runId, env);
	if (load._tag !== 'Found') {
		return yield* new SnapshotNotResumable({ runId, reason: describeLoad(load) });
	}
	const { snapshot } = load;
	const { context } = snapshot;
	let handle: RunHandle;
	switch (context.kind) {
		case 'review':
			handle = yield* resumeKind(reviewKind, snapshot, context);
			break;
		case 'fix':
			handle = yield* resumeKind(fixKind, snapshot, context);
			break;
		case 'recheck':
			handle = yield* resumeKind(recheckKind, snapshot, context);
			break;
		case 'implement':
		case 'checks':
		case 'pr':
		case 'post':
			handle = yield* resumeKind(primitiveKind, snapshot, context);
			break;
		default:
			handle = yield* resumeKind(shipKind, snapshot, context);
	}
	return handle;
});

/** Resumes a loaded snapshot whose context is `context`, of `kind`. */
const resumeKind = Effect.fnUntraced(function* <C extends KindContext, S extends Summary>(
	kind: RunKind<C, S>,
	snapshot: PersistedRunSnapshot,
	context: C
) {
	const journal = yield* RunJournal;
	const runId = context.runId;
	// A snapshot that loads can still name states this machine does not have.
	yield* Effect.try({
		try: () => {
			if (!isStateValue(snapshot.value)) throw new Error('it has no state value');
			kind.resolve(snapshot.value, context);
		},
		catch: (error) =>
			new SnapshotNotResumable({
				runId,
				reason: `its snapshot does not fit this ship's pipeline: ${describeDefect(error)}`
			})
	});
	if (snapshot['status'] === 'done') {
		const path = statePath(snapshot.value);
		yield* journal.markResumed(runId);
		const summary = yield* finishFromLog(kind, runId, finalEnd(path, context));
		return {
			runId,
			state: Effect.succeed(path),
			cancel: Effect.void,
			await: Effect.succeed(summary)
		} satisfies RunHandle<S>;
	}
	if (snapshot['status'] !== 'active') {
		return yield* new SnapshotNotResumable({
			runId,
			reason: 'its snapshot is of a stopped machine'
		});
	}
	yield* journal.markResumed(runId);
	return yield* runMachine(kind, { _tag: 'Restore', snapshot });
});
