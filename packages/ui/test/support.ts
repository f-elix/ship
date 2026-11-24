/**
 * Fixture runs, and the inbox over a fake daemon: real `ShipRpcs` handlers over
 * in-memory runs, reached through `RpcTest`'s in-memory client, plus fake git, an
 * in-memory archive and a fake GitHub.
 */
import { Archive } from '#lib/server/archive.ts';
import { type ArchiveMarks, DeliverableId } from '#lib/server/deliverables.ts';
import { Inbox, make as makeInbox } from '#lib/server/inbox.ts';
import { make as makePrStates, PrStates } from '#lib/server/pr-states.ts';
import {
	type FixRunInfo,
	GitSha,
	InvalidRunStatus,
	PreconditionFailed,
	type PrimitiveRunInfo,
	ProjectKey,
	type RecheckRunInfo,
	type ReviewRunInfo,
	type RunEvent,
	RunId,
	type RunInfo,
	RunNotFound,
	ShipRpcs,
	type ShipRunInfo,
	type ShipSummary,
	SnapshotNotResumable
} from '@ship/core/contract';
import { FindingId, type Severity, type VerifiedFinding } from '@ship/core/finding';
import { type FakeGitState, GhFake, GitFake } from '@ship/core/testing';
import { DaemonClient } from '@ship/daemon/client';
import { Context, DateTime, Effect, Layer, PubSub, Ref, Stream } from 'effect';
import { RpcTest } from 'effect/rpc';

// --- Fixture runs ---

export const PROJECT = ProjectKey.make('github.com/f-elix/example');
export const PR_URL = 'https://github.com/f-elix/example/pull/7';
/** The deliverable of the fixture runs on branch `feature`, with or without {@link PR_URL}. */
export const FEATURE_ID = DeliverableId.make(`branch:${PROJECT}#feature`);

/** The `minute`th minute of a fixed day: runs made later sort newer. */
export const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 12, minute));

export const sha = (n: number) => GitSha.make(n.toString(16).padStart(40, '0'));

/** The fields every run has; `n` names the run and sets when it was made. */
const common = (n: number) => ({
	runId: RunId.make(`run-${n}`),
	projectKey: PROJECT,
	cwd: '/repo',
	status: 'done' as const,
	state: 'done',
	round: 0,
	createdAt: at(n),
	updatedAt: at(n)
});

export const shipRun = (n: number, fields: Partial<ShipRunInfo> = {}): ShipRunInfo => ({
	...common(n),
	kind: 'ship',
	planDir: '/plans/feature',
	branch: 'feature',
	prUrl: null,
	summary: null,
	...fields
});

export const reviewRun = (n: number, fields: Partial<ReviewRunInfo> = {}): ReviewRunInfo => ({
	...common(n),
	kind: 'review',
	prUrl: PR_URL,
	reviewUrl: null,
	summary: null,
	...fields
});

export const fixRun = (n: number, fields: Partial<FixRunInfo> = {}): FixRunInfo => ({
	...common(n),
	kind: 'fix',
	prUrl: PR_URL,
	summary: null,
	...fields
});

export const recheckRun = (n: number, fields: Partial<RecheckRunInfo> = {}): RecheckRunInfo => ({
	...common(n),
	kind: 'recheck',
	prUrl: PR_URL,
	summary: null,
	...fields
});

export const primitiveRun = (
	n: number,
	kind: PrimitiveRunInfo['kind'],
	fields: Partial<PrimitiveRunInfo> = {}
): PrimitiveRunInfo => ({
	...common(n),
	kind,
	planDir: null,
	branch: kind === 'post' ? null : 'feature',
	review: null,
	url: null,
	summary: null,
	...fields
});

export const finding = (id: string, severity: Severity): VerifiedFinding => ({
	reviewer: 'correctness',
	file: 'src/feature.ts',
	line: 3,
	severity,
	claim: `Claim ${id}`,
	evidence: `Evidence ${id}`,
	id: FindingId.make(id),
	round: 1,
	alsoReportedBy: []
});

export const shipSummary = (run: ShipRunInfo, fields: Partial<ShipSummary> = {}): ShipSummary => ({
	kind: 'ship',
	runId: run.runId,
	status: 'done',
	prUrl: run.prUrl,
	rounds: 1,
	checks: [],
	costUsd: 0,
	unresolvedMustFix: [],
	tradeoffs: [],
	nits: [],
	escalationReason: null,
	error: null,
	...fields
});

// --- Fake daemon ---

/** An RPC the inbox called, with its payload. */
export interface DaemonCall {
	readonly rpc: string;
	readonly payload: unknown;
}

/** What each action RPC may answer with instead of starting or changing a run. */
interface Refusals {
	readonly fix?: PreconditionFailed;
	readonly recheck?: PreconditionFailed;
	readonly post?: PreconditionFailed;
	readonly resume?: RunNotFound | InvalidRunStatus | SnapshotNotResumable;
	readonly cancel?: RunNotFound | InvalidRunStatus;
}

interface DaemonFakeState {
	readonly runs: ReadonlyMap<RunId, RunInfo>;
	readonly events: ReadonlyMap<RunId, ReadonlyArray<RunEvent>>;
	readonly calls: ReadonlyArray<DaemonCall>;
	/** The refusal each action RPC answers with. */
	readonly refusals: Refusals;
}

export interface DaemonFakeApi {
	/** Adds or updates a run, with its events when given; `watch` streams it. */
	readonly put: (run: RunInfo, events?: ReadonlyArray<RunEvent>) => Effect.Effect<void>;
	/** Shuts the daemon down: every `watch` stream ends. */
	readonly stop: Effect.Effect<void>;
	readonly calls: Effect.Effect<ReadonlyArray<DaemonCall>>;
	/** Makes every later call of `rpc` answer with `error`. */
	readonly refuse: <K extends keyof Refusals>(
		rpc: K,
		error: NonNullable<Refusals[K]>
	) => Effect.Effect<void>;
}

export class DaemonFake extends Context.Service<DaemonFake, DaemonFakeApi>()(
	'@ship/ui/DaemonFake'
) {}

const NEW_RUN = RunId.make('run-new');

/** `ShipRpcs` handlers over the fake's runs. The RPCs the inbox never calls die. */
const daemonFake = Layer.unwrap(
	Effect.gen(function* () {
		const state = yield* Ref.make<DaemonFakeState>({
			runs: new Map(),
			events: new Map(),
			calls: [],
			refusals: {}
		});
		/** Each run as it changes; `null` when the daemon stops. */
		const updates = yield* PubSub.unbounded<RunInfo | null>();

		const record = (rpc: string, payload: unknown) =>
			Ref.update(state, (s) => ({ ...s, calls: [...s.calls, { rpc, payload }] }));
		/** Records the call, then answers with the refusal set for `rpc`, if any. */
		const action = <K extends keyof Refusals, A>(rpc: K, payload: unknown, success: A) =>
			Effect.gen(function* () {
				yield* record(rpc, payload);
				const refusal: Refusals[K] = (yield* Ref.get(state)).refusals[rpc];
				return refusal === undefined
					? success
					: yield* Effect.fail(refusal as NonNullable<Refusals[K]>);
			});
		const sortedRuns = Effect.map(Ref.get(state), (s) =>
			[...s.runs.values()].toSorted(
				(a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt)
			)
		);
		const unused = (rpc: string) => () => Effect.die(`the inbox does not call ${rpc}`);

		const fake: DaemonFakeApi = {
			put: (run, events) =>
				Ref.update(state, (s) => ({
					...s,
					runs: new Map(s.runs).set(run.runId, run),
					events:
						events === undefined ? s.events : new Map(s.events).set(run.runId, events)
				})).pipe(Effect.andThen(PubSub.publish(updates, run))),
			stop: Effect.asVoid(PubSub.publish(updates, null)),
			calls: Effect.map(Ref.get(state), (s) => s.calls),
			refuse: (rpc, error) =>
				Ref.update(state, (s) => ({ ...s, refusals: { ...s.refusals, [rpc]: error } }))
		};

		const handlers = ShipRpcs.toLayer({
			handshake: unused('handshake'),
			run: unused('run'),
			review: unused('review'),
			implement: unused('implement'),
			checks: unused('checks'),
			pr: unused('pr'),
			runChecks: unused('runChecks'),
			stop: unused('stop'),
			status: unused('status'),
			fix: (payload) => action('fix', payload, { runId: NEW_RUN }),
			recheck: (payload) => action('recheck', payload, { runId: NEW_RUN }),
			post: (payload) => action('post', payload, { runId: NEW_RUN }),
			resume: (payload) => action('resume', payload, undefined),
			cancel: (payload) => action('cancel', payload, undefined),
			list: () => sortedRuns,
			events: ({ runId }) =>
				Stream.unwrap(
					Effect.map(Ref.get(state), (s) => {
						const events = s.events.get(runId);
						return events === undefined
							? Stream.fail(new RunNotFound({ runId }))
							: Stream.fromIterable(
									events.map((event, i) => ({ runId, seq: i + 1, event }))
								);
					})
				),
			// Subscribes before it lists, like the daemon, so no change falls in between.
			watch: (payload) =>
				Stream.unwrap(
					Effect.gen(function* () {
						yield* record('watch', payload);
						const subscription = yield* PubSub.subscribe(updates);
						const runs = yield* sortedRuns;
						return Stream.fromIterable<RunInfo | null>(runs).pipe(
							Stream.concat(Stream.fromSubscription(subscription)),
							Stream.takeWhile((run) => run !== null),
							Stream.filter((run) => run !== null)
						);
					})
				)
		});

		const client = Layer.effect(DaemonClient, RpcTest.makeClient(ShipRpcs)).pipe(
			Layer.provide(handlers)
		);
		return Layer.merge(client, Layer.succeed(DaemonFake, fake));
	})
);

// --- The inbox ---

/**
 * The fakes the inbox runs over: the fake daemon, fake git, in-memory archive marks, and
 * the real `PrStates` over the fake GitHub. Each fake stays in context, for tests to drive
 * and inspect.
 */
export const inboxFakes = (
	options: { readonly marks?: ArchiveMarks; readonly git?: Partial<FakeGitState> } = {}
) =>
	Layer.mergeAll(
		daemonFake,
		GitFake.layer(options.git),
		Archive.layerTest(options.marks),
		Layer.effect(PrStates, makePrStates).pipe(Layer.provideMerge(GhFake.layer))
	);

/** The inbox's real `make` over {@link inboxFakes}, which stay in context. */
export const inboxTest = (options?: Parameters<typeof inboxFakes>[0]) =>
	Layer.effect(Inbox, makeInbox).pipe(Layer.provideMerge(inboxFakes(options)));

/** Provides {@link inboxTest} to `effect`. */
export const withInboxTest =
	(options?: Parameters<typeof inboxTest>[0]) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.provide(effect, inboxTest(options));
