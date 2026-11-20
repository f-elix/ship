import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node';
import { assert, describe, expect, it } from '@effect/vitest';
import {
	ChangeIntent,
	configParseOptions,
	GitSha,
	GlobalConfig,
	initialReviewRunState,
	ProjectConfig,
	ProjectKey,
	resolveConfig,
	RunEvent,
	RunId,
	SNAPSHOT_VERSION,
	StoredReview,
	type PersistedRunSnapshot,
	type RunState,
	type Summary
} from '@ship/core';
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from 'effect';
import { SqlClient } from 'effect/sql';
import { TestClock } from 'effect/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../src/index.ts';
import { migrations } from '../src/migrations.ts';

/** A database file path in a temp dir that is deleted when the scope closes. */
const tempDbFile = Effect.map(
	Effect.acquireRelease(
		Effect.promise(() => mkdtemp(join(tmpdir(), 'ship-store-'))),
		(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
	),
	(dir) => join(dir, 'ship.db')
);

/** A fresh database file per test. */
const TempDb = Layer.unwrap(Effect.map(tempDbFile, (filename) => SqliteClient.layer({ filename })));

/** The store plus raw SQL access, for checks the store's API cannot express. */
const TestLayer = RunStore.layer.pipe(Layer.provideMerge(TempDb));

const decodeGlobalConfigSync = Schema.decodeUnknownSync(GlobalConfig, configParseOptions);
const decodeProjectConfigSync = Schema.decodeUnknownSync(ProjectConfig, configParseOptions);

const projectKey = ProjectKey.make('github.com/f-elix/ship');
const baseSha = GitSha.make('a'.repeat(40));
const newRun = { projectKey, cwd: '/repo', planDir: '/plans/feature', branch: 'feature', baseSha };
const secretEnv = { PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_secret-value' };

const runState = (runId: RunId): RunState => ({
	runId,
	projectKey,
	cwd: '/repo',
	env: secretEnv,
	planDir: '/plans/feature',
	branch: 'feature',
	baseSha,
	config: resolveConfig(decodeGlobalConfigSync({}), decodeProjectConfigSync({})),
	implementerSession: null,
	round: 1,
	lastReviewedSha: null,
	reviewRounds: [],
	unresolved: { mustFix: [], tradeoffs: [], nits: [] },
	checks: [],
	costUsd: 0.5,
	prUrl: null,
	escalationReason: null,
	error: null
});

/** Shaped like XState's persisted snapshot, with an invoked actor that got the env as input. */
const snapshotOf = (runId: RunId): PersistedRunSnapshot => ({
	status: 'active',
	value: { checks: 'waiting' },
	historyValue: {},
	context: runState(runId),
	children: {
		'ship.checks:0': {
			src: 'checks',
			snapshot: { status: 'active', input: { cwd: '/repo', env: secretEnv } }
		}
	}
});

const summaryOf = (runId: RunId, status: Summary['status'] = 'done'): Summary => ({
	runId,
	status,
	prUrl: 'https://github.com/f-elix/ship/pull/3',
	rounds: 1,
	checks: [],
	costUsd: 1.5,
	unresolvedMustFix: [],
	tradeoffs: [],
	nits: [],
	escalationReason: null,
	error: null
});

const at = DateTime.makeUnsafe('2026-11-17T12:00:00.000Z');
const stateChanged = (to: string) =>
	RunEvent.cases.StateChanged.make({ at, from: 'implement', to });

const seqsOf = (envelopes: ReadonlyArray<{ readonly seq: number }>) => envelopes.map((e) => e.seq);
const tagsOf = (envelopes: ReadonlyArray<{ readonly event: { readonly _tag: string } }>) =>
	envelopes.map((e) => e.event._tag);
const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A stored review of PR 7 with one must-fix finding. */
const reviewPrUrl = 'https://github.com/f-elix/ship/pull/7';
const reviewOf = (id: string, runId: RunId, url: string | null = reviewPrUrl) =>
	Schema.decodeUnknownSync(StoredReview)({
		id,
		runId,
		subject: {
			projectKey,
			prUrl: url,
			baseSha,
			headSha: 'b'.repeat(40),
			intent: ChangeIntent.cases.Description.make({ title: 'T', body: '' })
		},
		findings: [
			{
				reviewer: 'standards',
				file: 'src/a.ts',
				line: 3,
				severity: 'must-fix',
				claim: 'Wrong',
				evidence: 'x',
				id: 'f1',
				round: 1,
				alsoReportedBy: []
			}
		],
		postedUrl: null
	});

describe('RunStore', () => {
	it.effect('creates a running run whose log starts with RunCreated', () =>
		Effect.gen(function* () {
			const store = yield* RunStore;
			const run = yield* store.create(newRun);
			expect(run).toMatchObject({
				status: 'running',
				state: '',
				round: 0,
				summary: null,
				branch: 'feature'
			});
			expect(run.runId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/u);
			const events = yield* store.events(run.runId);
			expect(seqsOf(events)).toEqual([1]);
			expect(events[0]?.event).toMatchObject({
				_tag: 'RunCreated',
				baseSha,
				planDir: '/plans/feature'
			});
		}).pipe(Effect.provide(TestLayer))
	);

	it.effect('assigns gapless seqs in order under concurrent appends to one run', () =>
		Effect.gen(function* () {
			const store = yield* RunStore;
			const { runId } = yield* store.create(newRun);
			const appended = yield* Effect.forEach(
				range(1, 50),
				(i) => store.append(runId, stateChanged(`s${i}`)),
				{ concurrency: 'unbounded' }
			);
			expect(new Set(seqsOf(appended)).size).toBe(50);
			const events = yield* store.events(runId);
			expect(seqsOf(events)).toEqual(range(1, 51));
			// Each envelope `append` returned is the event stored at that seq.
			appended.forEach((envelope) => expect(events[envelope.seq - 1]).toEqual(envelope));
		}).pipe(Effect.provide(TestLayer))
	);

	it.effect('reads events from a seq, inclusive', () =>
		Effect.gen(function* () {
			const store = yield* RunStore;
			const { runId } = yield* store.create(newRun);
			yield* Effect.forEach(['a', 'b', 'c'], (to) => store.append(runId, stateChanged(to)));
			expect(seqsOf(yield* store.events(runId, 3))).toEqual([3, 4]);
			expect(yield* store.events(runId, 9)).toEqual([]);
		}).pipe(Effect.provide(TestLayer))
	);

	it.effect('reads an event it cannot decode as an UnknownEvent', () =>
		Effect.gen(function* () {
			const store = yield* RunStore;
			const sql = yield* SqlClient.SqlClient;
			const { runId } = yield* store.create(newRun);
			const payload = JSON.stringify({ _tag: 'RunExploded', at: at.toString() });
			yield* sql`INSERT INTO events ${sql.insert({ run_id: runId, seq: 2, type: 'RunExploded', payload })}`;
			yield* store.append(runId, stateChanged('review'));
			const events = yield* store.events(runId);
			expect(tagsOf(events)).toEqual(['RunCreated', 'UnknownEvent', 'StateChanged']);
			expect(events[1]?.event).toMatchObject({
				_tag: 'UnknownEvent',
				type: 'RunExploded',
				json: payload
			});
		}).pipe(Effect.provide(TestLayer))
	);

	it.effect('fails with RunNotFound for an unknown run', () =>
		Effect.gen(function* () {
			const store = yield* RunStore;
			const runId = RunId.make('missing');
			const errors = yield* Effect.all([
				Effect.flip(store.get(runId)),
				Effect.flip(store.append(runId, stateChanged('x'))),
				Effect.flip(store.events(runId)),
				Effect.flip(store.saveSnapshot(snapshotOf(runId))),
				Effect.flip(store.loadSnapshot(runId, {}))
			]);
			errors.forEach((error) => expect(error).toMatchObject({ _tag: 'RunNotFound', runId }));
		}).pipe(Effect.provide(TestLayer))
	);

	describe('snapshots', () => {
		it.effect('never stores the caller env and restores the fresh one on load', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const sql = yield* SqlClient.SqlClient;
				const { runId } = yield* store.create(newRun);
				yield* store.saveSnapshot(snapshotOf(runId));

				const rows = yield* sql<{
					snapshot: string;
					env_paths: string;
				}>`SELECT * FROM snapshots`;
				const stored = JSON.stringify(rows);
				expect(stored).not.toContain('ghp_secret-value');
				expect(stored).not.toContain('/usr/bin');

				const freshEnv = { PATH: '/opt/bin' };
				const loaded = yield* store.loadSnapshot(runId, freshEnv);
				assert(loaded._tag === 'Found');
				expect(loaded.snapshot).toEqual({
					...snapshotOf(runId),
					context: { ...runState(runId), env: freshEnv },
					children: {
						'ship.checks:0': {
							src: 'checks',
							snapshot: { status: 'active', input: { cwd: '/repo', env: freshEnv } }
						}
					}
				});
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect('updates the run from the latest snapshot', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);
				yield* store.saveSnapshot(snapshotOf(runId));
				const prUrl = 'https://github.com/f-elix/ship/pull/9';
				yield* store.saveSnapshot({
					...snapshotOf(runId),
					value: 'pr',
					context: { ...runState(runId), round: 2, prUrl }
				});
				expect(yield* store.get(runId)).toMatchObject({ state: 'pr', round: 2, prUrl });
				expect(tagsOf(yield* store.events(runId))).toEqual(['RunCreated']);
				const loaded = yield* store.loadSnapshot(runId, {});
				assert(loaded._tag === 'Found');
				expect(loaded.snapshot.value).toBe('pr');
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect('appends the given events in the same write as the snapshot', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);
				const appended = yield* store.saveSnapshot(snapshotOf(runId), [
					stateChanged('checks.running'),
					stateChanged('checks.waiting')
				]);
				expect(seqsOf(appended)).toEqual([2, 3]);
				expect(yield* store.events(runId, 2)).toEqual(appended);

				yield* store.finish(summaryOf(runId));
				yield* store.saveSnapshot(snapshotOf(runId));
				const late = yield* Effect.flip(
					store.saveSnapshot(snapshotOf(runId), [stateChanged('done')])
				);
				expect(late._tag).toBe('InvalidRunStatus');
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect('reports a missing, version-mismatched or corrupt snapshot as an outcome', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const sql = yield* SqlClient.SqlClient;
				const { runId } = yield* store.create(newRun);
				expect((yield* store.loadSnapshot(runId, {}))._tag).toBe('Missing');

				yield* store.saveSnapshot(snapshotOf(runId));
				yield* sql`UPDATE snapshots SET snapshot_version = ${SNAPSHOT_VERSION + 1}`;
				expect(yield* store.loadSnapshot(runId, {})).toEqual({
					_tag: 'IncompatibleVersion',
					storedVersion: SNAPSHOT_VERSION + 1,
					currentVersion: SNAPSHOT_VERSION
				});

				yield* sql`UPDATE snapshots SET snapshot_version = ${SNAPSHOT_VERSION}, snapshot = ${'{"value":"pr","context":{}}'}`;
				expect((yield* store.loadSnapshot(runId, {}))._tag).toBe('Corrupt');
			}).pipe(Effect.provide(TestLayer))
		);
	});

	describe('status', () => {
		it.effect('finishes a run once, storing its summary and appending RunFinished', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);
				const summary = summaryOf(runId, 'escalated');
				const finished = yield* store.finish(summary);
				expect(finished).toMatchObject({ seq: 2, event: { _tag: 'RunFinished', summary } });
				expect(yield* store.get(runId)).toMatchObject({ status: 'escalated', summary });
				const again = yield* Effect.flip(store.finish(summary));
				expect(again).toMatchObject({ _tag: 'InvalidRunStatus', status: 'escalated' });
				const late = yield* Effect.flip(store.append(runId, stateChanged('pr')));
				expect(late).toMatchObject({ _tag: 'InvalidRunStatus', status: 'escalated' });
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect('appends RunCancelled before RunFinished for a cancelled run', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);
				const finished = yield* store.finish(summaryOf(runId, 'cancelled'));
				expect(finished).toMatchObject({ seq: 3, event: { _tag: 'RunFinished' } });
				expect(tagsOf(yield* store.events(runId))).toEqual([
					'RunCreated',
					'RunCancelled',
					'RunFinished'
				]);
				expect((yield* store.get(runId)).status).toBe('cancelled');
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect('marks every running run interrupted and appends RunInterrupted to each', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const first = yield* store.create(newRun);
				const second = yield* store.create(newRun);
				const finished = yield* store.create(newRun);
				yield* store.finish(summaryOf(finished.runId));

				const interrupted = yield* store.markInterrupted;
				expect([...interrupted].sort()).toEqual([first.runId, second.runId].sort());
				for (const runId of [first.runId, second.runId]) {
					expect((yield* store.get(runId)).status).toBe('interrupted');
					expect(tagsOf(yield* store.events(runId))).toEqual([
						'RunCreated',
						'RunInterrupted'
					]);
				}
				expect((yield* store.get(finished.runId)).status).toBe('done');
				expect(tagsOf(yield* store.events(finished.runId))).toEqual([
					'RunCreated',
					'RunFinished'
				]);
				expect(yield* store.markInterrupted).toEqual([]);
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect('interrupts one running run', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);
				const other = yield* store.create(newRun);
				const interrupted = yield* store.interrupt(runId);
				expect(interrupted).toMatchObject({ seq: 2, event: { _tag: 'RunInterrupted' } });
				expect((yield* store.get(runId)).status).toBe('interrupted');
				expect((yield* store.get(other.runId)).status).toBe('running');
				const again = yield* Effect.flip(store.interrupt(runId));
				expect(again).toMatchObject({ _tag: 'InvalidRunStatus', status: 'interrupted' });
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect('resumes only an interrupted run', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);
				const running = yield* Effect.flip(store.markResumed(runId));
				expect(running).toMatchObject({ _tag: 'InvalidRunStatus', status: 'running' });

				yield* store.markInterrupted;
				const resumed = yield* store.markResumed(runId);
				expect(resumed).toMatchObject({ seq: 3, event: { _tag: 'RunResumed' } });
				expect((yield* store.get(runId)).status).toBe('running');
			}).pipe(Effect.provide(TestLayer))
		);
	});

	it.effect('lists runs most recently updated first, filtered by project and status', () =>
		Effect.gen(function* () {
			const store = yield* RunStore;
			const other = ProjectKey.make('github.com/f-elix/other');
			const a = yield* store.create(newRun);
			yield* TestClock.adjust('1 second');
			const b = yield* store.create({ ...newRun, projectKey: other });
			yield* TestClock.adjust('1 second');
			const c = yield* store.create(newRun);
			yield* TestClock.adjust('1 second');
			yield* store.append(a.runId, stateChanged('review'));
			yield* store.finish(summaryOf(c.runId));

			const ids = (runs: ReadonlyArray<{ readonly runId: RunId }>) =>
				runs.map((run) => run.runId);
			expect(ids(yield* store.list())).toEqual([c.runId, a.runId, b.runId]);
			expect(ids(yield* store.list({ limit: 1 }))).toEqual([c.runId]);
			expect(ids(yield* store.list({ projectKey: other }))).toEqual([b.runId]);
			expect(ids(yield* store.list({ status: ['running'] }))).toEqual([a.runId, b.runId]);
			expect(yield* store.list({ status: [] })).toEqual([]);
		}).pipe(Effect.provide(TestLayer))
	);

	describe('review runs', () => {
		const prUrl = 'https://github.com/f-elix/ship/pull/7';
		const headSha = GitSha.make('b'.repeat(40));
		const newReview = { projectKey, repoDir: '/repo', prUrl, prNumber: 7, baseSha, headSha };

		it.effect('creates a review run whose log starts with ReviewRunCreated', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const run = yield* store.createReview(newReview);

				expect(run).toMatchObject({
					kind: 'review',
					status: 'running',
					prUrl,
					reviewUrl: null,
					summary: null
				});
				const events = yield* store.events(run.runId);
				expect(events.map((envelope) => envelope.event)).toMatchObject([
					{ _tag: 'ReviewRunCreated', prUrl, prNumber: 7, headSha }
				]);
				expect(yield* store.get(run.runId)).toEqual(run);
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect('records the posted review from its snapshot and restores its context', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.createReview(newReview);
				const reviewUrl = `${prUrl}#pullrequestreview-1`;
				const context = {
					...initialReviewRunState({
						runId,
						projectKey,
						cwd: '/repo',
						env: secretEnv,
						config: resolveConfig(
							decodeGlobalConfigSync({}),
							decodeProjectConfigSync({})
						),
						pr: { number: 7, url: prUrl, title: 'T', body: '', baseSha, headSha },
						post: true
					}),
					reviewUrl
				};

				yield* store.saveSnapshot({ status: 'active', value: 'post', context });

				expect(yield* store.get(runId)).toMatchObject({ state: 'post', prUrl, reviewUrl });
				const load = yield* store.loadSnapshot(runId, secretEnv);
				assert(load._tag === 'Found');
				expect(load.snapshot.context).toEqual(context);
			}).pipe(Effect.provide(TestLayer))
		);
	});

	describe('checkpoints', () => {
		it.effect('stores a value per run and key, replacing it when saved again', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);
				const other = (yield* store.create(newRun)).runId;

				yield* store.saveCheckpoint({ runId, key: 'review:1/route', value: { n: 1 } });
				yield* store.saveCheckpoint({ runId, key: 'review:1/route', value: { n: 2 } });

				expect(yield* store.loadCheckpoint(runId, 'review:1/route')).toEqual(
					Option.some({ n: 2 })
				);
				// Another key, or the same key in another run, is a different checkpoint.
				expect(yield* store.loadCheckpoint(runId, 'review:2/route')).toEqual(Option.none());
				expect(yield* store.loadCheckpoint(other, 'review:1/route')).toEqual(Option.none());
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect('appends the given events in the same write as the checkpoint', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);

				const appended = yield* store.saveCheckpoint(
					{ runId, key: 'checks:1/pass/1', value: [] },
					[{ _tag: 'StepStarted', at, step: 'checks' }]
				);

				expect(tagsOf(appended)).toEqual(['StepStarted']);
				expect(tagsOf(yield* store.events(runId))).toEqual(['RunCreated', 'StepStarted']);
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect(
			'refuses a checkpoint for a finished run, so nothing is written after the end',
			() =>
				Effect.gen(function* () {
					const store = yield* RunStore;
					const { runId } = yield* store.create(newRun);
					yield* store.finish(summaryOf(runId));

					const error = yield* Effect.flip(
						store.saveCheckpoint({ runId, key: 'post/post', value: 'x' })
					);

					expect(error).toMatchObject({
						_tag: 'InvalidRunStatus',
						runId,
						status: 'done'
					});
					expect(yield* store.loadCheckpoint(runId, 'post/post')).toEqual(Option.none());
				}).pipe(Effect.provide(TestLayer))
		);

		it.effect('goes with its run when the run is deleted', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const sql = yield* SqlClient.SqlClient;
				const { runId } = yield* store.create(newRun);
				yield* store.saveCheckpoint({ runId, key: 'k', value: 1 });

				yield* sql`DELETE FROM runs WHERE id = ${runId}`;

				expect(yield* sql`SELECT * FROM checkpoints`).toEqual([]);
			}).pipe(Effect.provide(TestLayer))
		);
	});

	describe('reviews', () => {
		it.effect('stores a review that reads back as saved', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);
				const review = reviewOf(`${runId}-r1`, runId);

				yield* store.reviews.save(review);

				expect(yield* store.reviews.get(review.id)).toEqual(review);
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect('fails with ReviewNotFound for an unknown review', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const id = reviewOf('missing', RunId.make('20261117-120000-abcdef')).id;

				const error = yield* Effect.flip(store.reviews.get(id));

				expect(error).toMatchObject({ _tag: 'ReviewNotFound', reviewId: 'missing' });
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect("lists a PR's reviews oldest first, a re-saved review keeping its place", () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);
				const first = reviewOf('a-first', runId);
				const second = reviewOf('b-second', runId);
				yield* store.reviews.save(second);
				yield* TestClock.adjust('1 second');
				yield* store.reviews.save(first);
				yield* store.reviews.save(
					reviewOf('other', runId, 'https://github.com/f-elix/ship/pull/8')
				);
				yield* TestClock.adjust('1 second');

				// Posting saves the review again; it stays where it was first stored.
				const posted = { ...second, postedUrl: `${reviewPrUrl}#pullrequestreview-1` };
				yield* store.reviews.save(posted);

				expect(yield* store.reviews.byPr(reviewPrUrl)).toEqual([posted, first]);
				expect(yield* store.reviews.byPr('https://github.com/f-elix/ship/pull/9')).toEqual(
					[]
				);
			}).pipe(Effect.provide(TestLayer))
		);

		it.effect('outlives the run that made it', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const sql = yield* SqlClient.SqlClient;
				const { runId } = yield* store.create(newRun);
				const review = reviewOf(`${runId}-r1`, runId);
				yield* store.reviews.save(review);

				yield* sql`DELETE FROM runs WHERE id = ${runId}`;

				expect(yield* store.reviews.get(review.id)).toEqual(review);
			}).pipe(Effect.provide(TestLayer))
		);
	});

	it.effect('adds checkpoints and reviews to a database from before primitives', () =>
		Effect.gen(function* () {
			const filename = yield* tempDbFile;
			// A database as the second migration left it.
			yield* Effect.void.pipe(
				Effect.provide(
					SqliteMigrator.layer({
						loader: Effect.map(migrations, (all) => all.filter(([id]) => id <= 2))
					}).pipe(Layer.provideMerge(SqliteClient.layer({ filename })))
				)
			);

			yield* Effect.gen(function* () {
				const store = yield* RunStore;
				const sql = yield* SqlClient.SqlClient;
				const applied = yield* sql<{ migration_id: number }>`
					SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id
				`;
				expect(applied.map((row) => row.migration_id)).toEqual([1, 2, 3]);
				const { runId } = yield* store.create(newRun);
				yield* store.saveCheckpoint({ runId, key: 'k', value: 'v' });
				expect(yield* store.loadCheckpoint(runId, 'k')).toEqual(Option.some('v'));
				const review = reviewOf(`${runId}-r1`, runId);
				yield* store.reviews.save(review);
				expect(yield* store.reviews.get(review.id)).toEqual(review);
			}).pipe(
				Effect.provide(
					RunStore.layer.pipe(Layer.provideMerge(SqliteClient.layer({ filename })))
				)
			);
		}).pipe(Effect.scoped)
	);

	it.effect('keeps the runs of a database from before review runs as ship runs', () =>
		Effect.gen(function* () {
			const filename = yield* tempDbFile;
			const runId = RunId.make('20261117-120000-abcdef');
			const created = Schema.encodeSync(RunEvent)(
				RunEvent.cases.RunCreated.make({ at, ...newRun })
			);
			// A database as the first migration left it, with one run in it.
			yield* Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO runs ${sql.insert({
					id: runId,
					project_key: projectKey,
					cwd: '/repo',
					plan_dir: '/plans/feature',
					branch: 'feature',
					status: 'running',
					state: 'implement',
					round: 0,
					pr_url: null,
					created_at: 1,
					updated_at: 1,
					summary: null
				})}`;
				yield* sql`INSERT INTO events ${sql.insert({
					run_id: runId,
					seq: 1,
					type: 'RunCreated',
					payload: JSON.stringify(created)
				})}`;
			}).pipe(
				Effect.provide(
					SqliteMigrator.layer({
						loader: Effect.map(migrations, (all) => all.filter(([id]) => id === 1))
					}).pipe(Layer.provideMerge(SqliteClient.layer({ filename })))
				)
			);

			yield* Effect.gen(function* () {
				const store = yield* RunStore;
				expect(yield* store.get(runId)).toMatchObject({
					kind: 'ship',
					planDir: '/plans/feature',
					branch: 'feature',
					state: 'implement'
				});
				expect(tagsOf(yield* store.events(runId))).toEqual(['RunCreated']);
				const review = yield* store.createReview({
					projectKey,
					repoDir: '/repo',
					prUrl: 'https://github.com/f-elix/ship/pull/7',
					prNumber: 7,
					baseSha,
					headSha: baseSha
				});
				expect((yield* store.list()).map((run) => run.kind).toSorted()).toEqual([
					'review',
					'ship'
				]);
				expect(review.kind).toBe('review');
			}).pipe(Effect.provide(RunStore.layerFile(filename)));
		}).pipe(Effect.scoped)
	);

	it.effect('refuses a database migrated by a newer ship', () =>
		Effect.gen(function* () {
			const filename = yield* tempDbFile;
			yield* Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO effect_sql_migrations ${sql.insert({ migration_id: 99, name: 'future' })}`;
			}).pipe(
				Effect.provide(
					RunStore.layer.pipe(Layer.provideMerge(SqliteClient.layer({ filename })))
				)
			);

			const exit = yield* Effect.exit(
				Effect.provide(Effect.void, RunStore.layerFile(filename))
			);
			expect(String(exit)).toContain('newer than this ship knows');
		}).pipe(Effect.scoped)
	);

	describe('follow', () => {
		it.effect('replays, then follows new events until the run finishes', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);
				yield* store.append(runId, stateChanged('checks'));
				const replayed = yield* Deferred.make<void>();
				const fiber = yield* store.follow(runId, 2).pipe(
					Stream.tap(() => Deferred.succeed(replayed, undefined)),
					Stream.runCollect,
					Effect.forkScoped
				);
				yield* Deferred.await(replayed);
				const other = yield* store.create(newRun);
				yield* store.append(other.runId, stateChanged('elsewhere'));
				yield* store.append(runId, stateChanged('review'));
				yield* store.finish(summaryOf(runId));
				const followed = Array.from(yield* Fiber.join(fiber));
				expect(seqsOf(followed)).toEqual([2, 3, 4]);
				expect(tagsOf(followed)).toEqual(['StateChanged', 'StateChanged', 'RunFinished']);
			}).pipe(Effect.scoped, Effect.provide(TestLayer))
		);

		it.effect('ends after the replay when the run is not active', () =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const { runId } = yield* store.create(newRun);
				yield* store.markInterrupted;
				const followed = yield* Stream.runCollect(store.follow(runId));
				expect(tagsOf(Array.from(followed))).toEqual(['RunCreated', 'RunInterrupted']);
				const missing = yield* Effect.flip(
					Stream.runCollect(store.follow(RunId.make('missing')))
				);
				expect(missing._tag).toBe('RunNotFound');
			}).pipe(Effect.provide(TestLayer))
		);
	});
});
