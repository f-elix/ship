/**
 * The inbox: the daemon's runs as deliverables, live, and the actions the developer takes
 * on them. Every call goes to the daemon; the inbox keeps no state but the archive marks
 * and the PR states it reads from GitHub.
 */
import type { RunId, RunInfo } from '@ship/core/contract';
import type { PrState } from '@ship/core/gh';
import { Git } from '@ship/core/git';
import { DaemonClient, processEnv } from '@ship/daemon/client';
import { Context, Effect, Layer, Queue, Schema, Stream } from 'effect';
import type { RpcClientError } from 'effect/rpc';
import { Archive, type ArchiveError } from './archive.ts';
import {
	deliverablesOf,
	groupingOf,
	offersOf,
	stageOf,
	summarize,
	withRun,
	type ActionKind,
	type ArchiveMark,
	type ArchiveMarks,
	type Deliverable,
	type DeliverableId,
	type DeliverableSummary,
	type KnownPrStates,
	type Offer,
	type RunWithEvents
} from './deliverables.ts';
import { changeRange, detailOf, type DeliverableDetail } from './detail.ts';
import { PrStates, type PrToRead } from './pr-states.ts';

/** The daemon cannot be reached, or stopped; the UI says so and keeps reconnecting. */
export class DaemonUnreachable extends Schema.TaggedError<DaemonUnreachable>()(
	'DaemonUnreachable',
	{ detail: Schema.String, cause: Schema.optionalKey(Schema.Defect()) }
) {
	override get message(): string {
		return `The ship daemon is unreachable: ${this.detail}`;
	}
}

/** No run makes up a deliverable with this id. */
export class DeliverableNotFound extends Schema.TaggedError<DeliverableNotFound>()(
	'DeliverableNotFound',
	{ id: Schema.String }
) {
	override get message(): string {
		return `No deliverable ${this.id}`;
	}
}

/**
 * How an action went. A refusal is expected, a value the UI shows: the daemon's own
 * refusals, plus a deliverable that is gone or does not offer the action any more.
 */
export type ActResult =
	| { readonly ok: true; readonly runId: RunId | null }
	| {
			readonly ok: false;
			readonly _tag:
				| 'PreconditionFailed'
				| 'InvalidRunStatus'
				| 'SnapshotNotResumable'
				| 'RunNotFound'
				| 'DeliverableNotFound'
				| 'ActionUnavailable';
			readonly detail: string;
	  };

export interface InboxApi {
	/**
	 * Every deliverable, newest activity first, re-emitted on every change. Fails when the
	 * daemon is lost, including when it stops.
	 */
	readonly deliverables: Stream.Stream<ReadonlyArray<DeliverableSummary>, DaemonUnreachable>;
	/** One deliverable with its findings, changed files, commits and runs. */
	readonly deliverable: (
		id: DeliverableId
	) => Effect.Effect<DeliverableDetail, DeliverableNotFound | DaemonUnreachable>;
	/** Starts `action` on the deliverable. An expected refusal is a value, not a failure. */
	readonly act: (
		id: DeliverableId,
		action: ActionKind
	) => Effect.Effect<ActResult, DaemonUnreachable | ArchiveError>;
}

/** How long the list waits for a burst of run updates to end before it re-emits. */
const SETTLE = '50 millis';

/** How often the PR states are read again. */
const PR_STATES_EVERY = '60 seconds';

/**
 * How long the PR states wait for a burst of run updates to end before they are read: a
 * run that ends usually changes its PR, and sends several updates as it ends.
 */
const PR_STATES_SETTLE = '2 seconds';

/** Lists each deliverable's PR, with the checkout of its latest run to run `gh` in. */
const prsOf = (deliverables: ReadonlyArray<Deliverable>): ReadonlyArray<PrToRead> =>
	deliverables.flatMap((deliverable) =>
		deliverable.prUrl === null
			? []
			: [{ prUrl: deliverable.prUrl, cwd: deliverable.runs[0]!.cwd }]
	);

const unreachable = (error: RpcClientError.RpcClientError) =>
	new DaemonUnreachable({ detail: error.message, cause: error });

const refused = (_tag: Extract<ActResult, { ok: false }>['_tag'], detail: string): ActResult => ({
	ok: false,
	_tag,
	detail
});

/** The inbox over the `DaemonClient`, `Git`, `Archive` and `PrStates` in context. */
export const make = Effect.gen(function* () {
	const rpc = yield* DaemonClient;
	const git = yield* Git;
	const archive = yield* Archive;
	const prStates = yield* PrStates;

	/** A run of a deliverable with a PR changed: its PR state may have too. */
	const prRunChanged = yield* Queue.sliding<void>(1);

	/**
	 * Reads the PR states when the inbox starts, then every {@link PR_STATES_EVERY}, and
	 * soon after a run of a deliverable with a PR changes. A lost daemon skips one read:
	 * the list says so already.
	 */
	const readPrStates = rpc.list({}).pipe(
		Effect.flatMap((runs) => prStates.refresh(prsOf(deliverablesOf(runs)))),
		Effect.catchTag('RpcClientError', (error) =>
			Effect.logDebug('Cannot list the runs to read their PR states', error)
		)
	);
	yield* Stream.merge(
		Stream.tick(PR_STATES_EVERY),
		Stream.fromQueue(prRunChanged).pipe(Stream.debounce(PR_STATES_SETTLE))
	).pipe(
		Stream.runForEach(() => readPrStates),
		Effect.forkScoped
	);

	/** The runs grouped: the list's, then again after each update the daemon sends. */
	const groupings = Stream.unwrap(
		Effect.map(rpc.list({}), (initial) =>
			rpc.watch({}).pipe(
				Stream.scanEffect(
					() => groupingOf(initial),
					(grouping, run) => {
						const next = withRun(grouping, run);
						const id = next.deliverableOfRun.get(run.runId);
						const owner = next.deliverables.find(
							(deliverable) => deliverable.id === id
						);
						return owner?.prUrl == null
							? Effect.succeed(next)
							: Effect.as(Queue.offer(prRunChanged, undefined), next);
					}
				),
				// `watch` ends when the daemon shuts down.
				Stream.concat(Stream.fail(new DaemonUnreachable({ detail: 'the daemon stopped' })))
			)
		)
	).pipe(Stream.catchTag('RpcClientError', (error) => Stream.fail(unreachable(error))));

	/**
	 * Summaries by deliverable, with the archive mark and PR state each was made with.
	 * {@link withRun} keeps every deliverable a run update does not touch, and the archive
	 * and the PR states keep every value they do not change, so only what changed is
	 * summarized again.
	 */
	const summaries = new WeakMap<
		Deliverable,
		{
			readonly mark: ArchiveMark | undefined;
			readonly prState: PrState | undefined;
			readonly summary: DeliverableSummary;
		}
	>();
	const summaryOf = (
		deliverable: Deliverable,
		marks: ArchiveMarks,
		states: KnownPrStates
	): DeliverableSummary => {
		const mark = marks.get(deliverable.id);
		const prState = deliverable.prUrl === null ? undefined : states.get(deliverable.prUrl);
		const cached = summaries.get(deliverable);
		if (cached !== undefined && cached.mark === mark && cached.prState === prState) {
			return cached.summary;
		}
		const summary = summarize(deliverable, marks, states);
		summaries.set(deliverable, { mark, prState, summary });
		return summary;
	};

	/**
	 * Every open tab subscribes to the same watch, so a run update is grouped and summarized
	 * once, however many tabs are open. The latest list is replayed to a tab that joins, and
	 * a slow tab skips to it. The watch stops with its last subscriber; a tab that reconnects
	 * after the daemon was lost starts a new one.
	 *
	 * Each update re-sends the whole list: a live query keeps only the latest value for a tab
	 * that falls behind, so a list of changes could be dropped.
	 */
	const deliverables = yield* Stream.zipLatestAll(
		Stream.debounce(groupings, SETTLE),
		archive.marks,
		prStates.states
	).pipe(
		Stream.map(([grouping, marks, states]) =>
			grouping.deliverables.map((deliverable) => summaryOf(deliverable, marks, states))
		),
		Stream.share({ capacity: 1, strategy: 'sliding', replay: 1 })
	);

	const find = Effect.fn('Inbox.find')(function* (id: DeliverableId) {
		const all = yield* rpc
			.list({})
			.pipe(Effect.catchTag('RpcClientError', (error) => Effect.fail(unreachable(error))));
		const deliverable = deliverablesOf(all).find((candidate) => candidate.id === id);
		if (deliverable === undefined) return yield* new DeliverableNotFound({ id });
		return deliverable;
	});

	const withEvents = (info: RunInfo) =>
		rpc.events({ runId: info.runId, follow: false }).pipe(
			Stream.map((envelope) => envelope.event),
			Stream.runCollect,
			Effect.map((events): RunWithEvents => ({ info, events })),
			Effect.catchTags({
				RpcClientError: (error) => Effect.fail(unreachable(error)),
				// Runs are never deleted, so a listed run is always found.
				RunNotFound: Effect.die
			})
		);

	/**
	 * The files the deliverable's change touches. `null` when its runs recorded no base
	 * commit to diff from, or when git cannot tell, e.g. for a moved checkout.
	 */
	const changedFiles = (deliverable: Deliverable, runs: ReadonlyArray<RunWithEvents>) => {
		const range = changeRange(runs);
		if (range === null) return Effect.succeed(null);
		return git.changedFiles({ cwd: deliverable.runs[0]!.cwd, env: processEnv() }, range).pipe(
			Effect.tapError((error) => Effect.logWarning('Cannot list the changed files', error)),
			Effect.orElseSucceed(() => null)
		);
	};

	const deliverable = Effect.fn('Inbox.deliverable')(function* (id: DeliverableId) {
		const found = yield* find(id);
		const runs = yield* Effect.forEach(found.runs, withEvents, { concurrency: 4 });
		const files = yield* changedFiles(found, runs);
		return detailOf(found, runs, yield* archive.current, yield* prStates.current, files);
	});

	/** Starts the action `deliverable` offers on it. */
	const start = (deliverable: Deliverable, offer: Offer) => {
		const latest = deliverable.runs[0]!;
		const started = ({ runId }: { readonly runId: RunId }): ActResult => ({ ok: true, runId });
		const checkout = { cwd: latest.cwd, env: processEnv() };
		switch (offer.action) {
			case 'fix':
				return Effect.map(
					rpc.fix({ source: offer.source, local: false, checks: true, ...checkout }),
					started
				);
			case 'recheck':
				return Effect.map(
					rpc.recheck({ source: offer.source, local: false, ...checkout }),
					started
				);
			case 'post':
				return Effect.map(rpc.post({ review: offer.review, ...checkout }), started);
			case 'resume':
				return Effect.as(
					rpc.resume({ runId: latest.runId, env: checkout.env }),
					started(latest)
				);
			case 'cancel':
				return Effect.as(rpc.cancel({ runId: latest.runId }), started(latest));
			case 'archive':
				return Effect.as(archive.archive(deliverable.id), {
					ok: true,
					runId: null
				} as const);
			case 'unarchive':
				return Effect.as(archive.unarchive(deliverable.id), {
					ok: true,
					runId: null
				} as const);
		}
	};

	const act = (id: DeliverableId, action: ActionKind) =>
		Effect.gen(function* () {
			const found = yield* find(id);
			const stage = stageOf(found, yield* archive.current, yield* prStates.current);
			const offer = offersOf(found, stage).find((candidate) => candidate.action === action);
			if (offer === undefined) {
				return refused('ActionUnavailable', `Cannot ${action} it now: it is ${stage}.`);
			}
			return yield* start(found, offer);
		}).pipe(
			Effect.catchTags({
				RpcClientError: (error) => Effect.fail(unreachable(error)),
				DeliverableNotFound: (error) => Effect.succeed(refused(error._tag, error.message)),
				PreconditionFailed: (error) => Effect.succeed(refused(error._tag, error.detail)),
				InvalidRunStatus: (error) =>
					Effect.succeed(refused(error._tag, `The run is ${error.status} now.`)),
				SnapshotNotResumable: (error) => Effect.succeed(refused(error._tag, error.message)),
				RunNotFound: (error) =>
					Effect.succeed(refused(error._tag, `No run ${error.runId}.`))
			}),
			Effect.withSpan('Inbox.act')
		);

	return { deliverables, deliverable, act } satisfies InboxApi;
});

/** The deliverables of the daemon `DaemonClient` reaches. */
export class Inbox extends Context.Service<Inbox, InboxApi>()('@ship/ui/Inbox') {
	/**
	 * With real git, the archive file and PR states read with `gh`. It still needs the
	 * `DaemonClient`, connected to the daemon `runtime.ts` finds, and the platform services.
	 */
	static readonly layer = Layer.effect(this, make).pipe(
		Layer.provide([Git.layer, Archive.layer, PrStates.layer])
	);
}
