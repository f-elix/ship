import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node';
import {
	InvalidRunStatus,
	NonNegativeInt,
	ProjectKey,
	RunEvent,
	RunId,
	RunInfo,
	RunJournal,
	RunNotFound,
	RunState,
	RunStatus,
	SNAPSHOT_VERSION,
	SnapshotLoad,
	statePath,
	Summary,
	TerminalRunStatus,
	UnknownEvent,
	type AppendableEvent,
	type Env,
	type PersistedRunSnapshot,
	type RunEventEnvelope,
	type RunJournalShape
} from '@ship/core';
import {
	Context,
	Data,
	DateTime,
	Effect,
	Layer,
	PubSub,
	Random,
	Result,
	Schema,
	Semaphore,
	Stream
} from 'effect';
import { SqlClient, SqlError } from 'effect/sql';
import { latestMigrationId, migrations } from './migrations.ts';
import { restoreEnv, stripEnv, type EnvPath } from './snapshot.ts';

// --- Public types ---

/** What a new run starts from: its `RunCreated` event without the timestamp. */
export type NewRun = Omit<typeof RunEvent.cases.RunCreated.Type, '_tag' | 'at'>;

/** Statuses the store records; `waiting` is derived by the daemon from the live machine. */
export type StoredRunStatus = Exclude<RunStatus, 'waiting'>;

/**
 * A `list` filter on stored values. A daemon serving `waiting` filters it from the `running`
 * runs and applies its own limit after.
 */
export interface RunFilter {
	readonly projectKey?: ProjectKey;
	readonly status?: ReadonlyArray<StoredRunStatus>;
	readonly limit?: number;
}

/** The run store; the members a run driver needs are documented on `RunJournalShape`. */
export interface RunStoreShape extends RunJournalShape {
	/** Creates a run with status `running` and appends its `RunCreated` event (seq 1). */
	readonly create: (run: NewRun) => Effect.Effect<RunInfo>;
	/** Appends an event with the run's next seq. Fails with `InvalidRunStatus` once the run finished. */
	readonly append: (
		runId: RunId,
		event: AppendableEvent
	) => Effect.Effect<RunEventEnvelope, RunNotFound | InvalidRunStatus>;
	/**
	 * Replays the run's events from `fromSeq`, then follows new ones until the run finishes
	 * or is interrupted. Ends after the replay when the run is not active.
	 */
	readonly follow: (
		runId: RunId,
		fromSeq?: number
	) => Stream.Stream<RunEventEnvelope, RunNotFound>;
	readonly get: (runId: RunId) => Effect.Effect<RunInfo, RunNotFound>;
	/** Most recently updated first. */
	readonly list: (filter?: RunFilter) => Effect.Effect<ReadonlyArray<RunInfo>>;
	/**
	 * Sets every `running` run to `interrupted` and appends `RunInterrupted` to each.
	 * Returns the interrupted runs' ids.
	 */
	readonly markInterrupted: Effect.Effect<ReadonlyArray<RunId>>;
}

// --- Rows ---

const RunRow = Schema.Struct({
	id: RunId,
	project_key: ProjectKey,
	cwd: Schema.String,
	plan_dir: Schema.String,
	branch: Schema.String,
	status: RunStatus,
	state: Schema.String,
	round: NonNegativeInt,
	pr_url: Schema.NullOr(Schema.String),
	created_at: Schema.Number,
	updated_at: Schema.Number,
	summary: Schema.NullOr(Schema.String)
});
type RunRow = typeof RunRow.Type;

const decodeRunRow = Schema.decodeUnknownEffect(RunRow);

const decodeRunInfo = Schema.decodeUnknownEffect(RunInfo);

const toRunInfo = (row: RunRow) =>
	decodeRunInfo({
		runId: row.id,
		projectKey: row.project_key,
		cwd: row.cwd,
		planDir: row.plan_dir,
		branch: row.branch,
		status: row.status,
		state: row.state,
		round: row.round,
		prUrl: row.pr_url,
		createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.created_at)),
		updatedAt: DateTime.formatIso(DateTime.makeUnsafe(row.updated_at)),
		summary: row.summary === null ? null : JSON.parse(row.summary)
	});

const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(RunEvent));
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(Summary));
const decodeEventResult = Schema.decodeUnknownResult(Schema.fromJsonString(RunEvent));
const decodeEnvPaths = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String)))
);
const decodeSnapshotObject = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
);
const decodeRunState = Schema.decodeUnknownEffect(RunState);

/** Decodes a stored event, turning one this build does not know into an `UnknownEvent`. */
const decodeStoredEvent = (type: string, payload: string): RunEvent | UnknownEvent => {
	const result = decodeEventResult(payload);
	if (Result.isSuccess(result)) return result.success;
	return UnknownEvent.make({ type, json: payload, error: result.failure.message });
};

const isTerminal = Schema.is(TerminalRunStatus);
const isUnfinished = (status: RunStatus): boolean => !isTerminal(status);

/** A follower stops after these: the run has nothing more to say until it is resumed. */
const endsFollow = (event: RunEvent | UnknownEvent): boolean =>
	event._tag === 'RunFinished' || event._tag === 'RunInterrupted';

/** Run ids look like `20261117-153012-a1b2c3`: sortable, short enough to type. */
const newRunId = Effect.gen(function* () {
	const now = yield* DateTime.now;
	const stamp = DateTime.formatIso(now).slice(0, 19).replaceAll(/[-:]/gu, '').replace('T', '-');
	const suffix = (yield* Random.nextIntBetween(0, 0xffffff)).toString(16).padStart(6, '0');
	return RunId.make(`${stamp}-${suffix}`);
});

const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);

// --- Implementation ---

/** Why a stored snapshot could not be read; surfaces as `SnapshotLoad.Corrupt`. */
class CorruptSnapshot extends Data.TaggedError('CorruptSnapshot')<{ readonly message: string }> {}

/**
 * Storage failures (a broken or full disk) have no recovery a caller could take, so they
 * are defects. Typed errors are kept for outcomes callers act on.
 */
type StorageError = SqlError.SqlError | Schema.SchemaError;

const isDomainError = <E>(error: E): error is Exclude<E, StorageError> =>
	!SqlError.isSqlError(error) && !Schema.isSchemaError(error);

const orDieStorage = <A, E, R>(
	effect: Effect.Effect<A, E, R>
): Effect.Effect<A, Exclude<E, StorageError>, R> =>
	Effect.catch(effect, (error) =>
		isDomainError(error) ? Effect.fail(error) : Effect.die(error)
	);

const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const [applied] = yield* sql<{ id: number | null }>`
		SELECT max(migration_id) AS id FROM effect_sql_migrations
	`;
	if ((applied?.id ?? 0) > latestMigrationId) {
		// Rows a newer ship wrote may not decode here; refuse instead of failing per call.
		return yield* Effect.die(
			new Error(
				`The run store has migration ${applied?.id}, newer than this ship knows (${latestMigrationId}). Upgrade ship.`
			)
		);
	}
	yield* sql`PRAGMA foreign_keys = ON`;

	const appended = yield* PubSub.unbounded<RunEventEnvelope>();
	/**
	 * Held across every write that appends, through publishing, so followers receive
	 * events in seq order.
	 */
	const writeLock = yield* Semaphore.make(1);

	const findRun = (runId: RunId) =>
		Effect.gen(function* () {
			const rows = yield* sql`SELECT * FROM runs WHERE id = ${runId}`;
			if (rows[0] === undefined) return yield* new RunNotFound({ runId });
			return yield* decodeRunRow(rows[0]);
		});

	/**
	 * Inserts the event with the run's next seq. Run it inside a transaction, after a write
	 * that proved the run exists and bumped its `updated_at`.
	 */
	const insertEvent = (runId: RunId, event: RunEvent) =>
		Effect.gen(function* () {
			const payload = yield* encodeEvent(event);
			const [next] = yield* sql<{ seq: number }>`
				SELECT coalesce(max(seq), 0) + 1 AS seq FROM events WHERE run_id = ${runId}
			`;
			const seq = next?.seq ?? 1;
			yield* sql`INSERT INTO events ${sql.insert({ run_id: runId, seq, type: event._tag, payload })}`;
			const envelope: RunEventEnvelope = { runId, seq, event };
			return envelope;
		});

	/** Runs `write` in a transaction under the write lock, then publishes what it appended. */
	const appending = <A, E, R>(
		write: Effect.Effect<A, E, R>,
		envelopesOf: (result: A) => ReadonlyArray<RunEventEnvelope>
	) =>
		writeLock.withPermits(1)(
			// Uninterruptible so a committed event always reaches followers.
			Effect.uninterruptible(
				Effect.gen(function* () {
					const result = yield* sql.withTransaction(write);
					yield* PubSub.publishAll(appended, envelopesOf(result));
					return result;
				})
			)
		);

	const readEvents = (runId: RunId, fromSeq: number) =>
		Effect.gen(function* () {
			const rows = yield* sql<{ seq: number; type: string; payload: string }>`
				SELECT seq, type, payload FROM events WHERE run_id = ${runId} AND seq >= ${fromSeq} ORDER BY seq
			`;
			return rows.map((row): RunEventEnvelope => ({
				runId,
				seq: row.seq,
				event: decodeStoredEvent(row.type, row.payload)
			}));
		});

	const create = Effect.fn('RunStore.create')(function* (run: NewRun) {
		const runId = yield* newRunId;
		const now = yield* DateTime.now;
		const created = RunEvent.cases.RunCreated.make({ ...run, at: now });
		const row = yield* appending(
			Effect.gen(function* () {
				const [inserted] = yield* sql`INSERT INTO runs ${sql.insert({
					id: runId,
					project_key: run.projectKey,
					cwd: run.cwd,
					plan_dir: run.planDir,
					branch: run.branch,
					status: 'running',
					state: '',
					round: 0,
					pr_url: null,
					created_at: DateTime.toEpochMillis(now),
					updated_at: DateTime.toEpochMillis(now),
					summary: null
				})} RETURNING *`;
				const envelope = yield* insertEvent(runId, created);
				return { inserted, envelope };
			}),
			({ envelope }) => [envelope]
		);
		return yield* toRunInfo(yield* decodeRunRow(row.inserted));
	}, orDieStorage);

	const append = Effect.fn('RunStore.append')(function* (runId: RunId, event: AppendableEvent) {
		const write = Effect.gen(function* () {
			yield* updateRun(runId, isUnfinished, {});
			return yield* insertEvent(runId, event);
		});
		return yield* appending(write, (envelope) => [envelope]);
	}, orDieStorage);

	const events = Effect.fn('RunStore.events')(function* (runId: RunId, fromSeq = 1) {
		yield* findRun(runId);
		return yield* readEvents(runId, fromSeq);
	}, orDieStorage);

	const follow = (runId: RunId, fromSeq = 1): Stream.Stream<RunEventEnvelope, RunNotFound> =>
		Stream.unwrap(
			Effect.gen(function* () {
				// Subscribe before reading so nothing appended in between is missed.
				const subscription = yield* PubSub.subscribe(appended);
				const { status, past } = yield* sql.withTransaction(
					Effect.gen(function* () {
						const run = yield* findRun(runId);
						return { status: run.status, past: yield* readEvents(runId, fromSeq) };
					})
				);
				const replay = Stream.fromIterable(past);
				if (status !== 'running') return replay;
				const lastSeq = past.at(-1)?.seq ?? fromSeq - 1;
				const live = Stream.fromSubscription(subscription).pipe(
					Stream.filter((envelope) => envelope.runId === runId && envelope.seq > lastSeq),
					Stream.takeUntil((envelope) => endsFollow(envelope.event))
				);
				return Stream.concat(replay, live);
			}).pipe(orDieStorage)
		);

	const saveSnapshot = Effect.fn('RunStore.saveSnapshot')(function* (
		snapshot: PersistedRunSnapshot,
		events: ReadonlyArray<AppendableEvent> = []
	) {
		const { context } = snapshot;
		const { runId } = context;
		const { json, envPaths } = stripEnv(snapshot);
		const now = yield* nowMillis;
		const write = Effect.gen(function* () {
			if (events.length > 0) yield* updateRun(runId, isUnfinished, {});
			const touched = yield* sql`
				UPDATE runs SET ${sql.update({
					state: statePath(snapshot.value),
					round: context.round,
					pr_url: context.prUrl,
					updated_at: now
				})} WHERE id = ${runId} RETURNING id
			`;
			if (touched.length === 0) return yield* new RunNotFound({ runId });
			yield* sql`
				INSERT INTO snapshots ${sql.insert({
					run_id: runId,
					snapshot_version: SNAPSHOT_VERSION,
					snapshot: json,
					env_paths: JSON.stringify(envPaths),
					saved_at: now
				})}
				ON CONFLICT (run_id) DO UPDATE SET
					snapshot_version = excluded.snapshot_version,
					snapshot = excluded.snapshot,
					env_paths = excluded.env_paths,
					saved_at = excluded.saved_at
			`;
			return yield* Effect.forEach(events, (event) => insertEvent(runId, event));
		});
		return yield* appending(write, (envelopes) => envelopes);
	}, orDieStorage);

	const decodeSnapshot = (json: string, envPathsJson: string, env: Env) =>
		Effect.gen(function* () {
			const snapshot = yield* decodeSnapshotObject(json);
			const envPaths: ReadonlyArray<EnvPath> = yield* decodeEnvPaths(envPathsJson);
			yield* Effect.try({
				try: () => restoreEnv(snapshot, envPaths, env),
				catch: (error) => new CorruptSnapshot({ message: String(error) })
			});
			const context = yield* decodeRunState(snapshot['context']);
			if (!('value' in snapshot))
				return yield* new CorruptSnapshot({ message: 'The snapshot has no state value' });
			const restored: PersistedRunSnapshot = {
				...snapshot,
				value: snapshot['value'],
				context
			};
			return restored;
		});

	const loadSnapshot = Effect.fn('RunStore.loadSnapshot')(function* (runId: RunId, env: Env) {
		yield* findRun(runId);
		const [row] = yield* sql<{ snapshot_version: number; snapshot: string; env_paths: string }>`
			SELECT snapshot_version, snapshot, env_paths FROM snapshots WHERE run_id = ${runId}
		`;
		if (row === undefined) return SnapshotLoad.Missing();
		if (row.snapshot_version !== SNAPSHOT_VERSION) {
			return SnapshotLoad.IncompatibleVersion({
				storedVersion: row.snapshot_version,
				currentVersion: SNAPSHOT_VERSION
			});
		}
		return yield* decodeSnapshot(row.snapshot, row.env_paths, env).pipe(
			Effect.map((snapshot) => SnapshotLoad.Found({ snapshot })),
			Effect.catch((error) => Effect.succeed(SnapshotLoad.Corrupt({ error: error.message })))
		);
	}, orDieStorage);

	const get = Effect.fn('RunStore.get')(function* (runId: RunId) {
		return yield* toRunInfo(yield* findRun(runId));
	}, orDieStorage);

	const list = Effect.fn('RunStore.list')(function* (filter: RunFilter = {}) {
		const clauses = [
			...(filter.projectKey === undefined ? [] : [sql`project_key = ${filter.projectKey}`]),
			...(filter.status === undefined ? [] : [sql.in('status', filter.status)])
		];
		const limit = filter.limit ?? -1;
		const rows = yield* sql`
			SELECT * FROM runs WHERE ${sql.and(clauses)} ORDER BY updated_at DESC, id DESC LIMIT ${limit}
		`;
		return yield* Effect.forEach(rows, (row) => Effect.flatMap(decodeRunRow(row), toRunInfo));
	}, orDieStorage);

	/**
	 * Writes `set` and bumps `updated_at`, inside a transaction. Fails with `InvalidRunStatus`
	 * unless `allowed` holds for the run's current status.
	 */
	const updateRun = (
		runId: RunId,
		allowed: (status: RunStatus) => boolean,
		set: Record<string, unknown>
	) =>
		Effect.gen(function* () {
			const run = yield* findRun(runId);
			if (!allowed(run.status))
				return yield* new InvalidRunStatus({ runId, status: run.status });
			const now = yield* nowMillis;
			yield* sql`UPDATE runs SET ${sql.update({ ...set, updated_at: now })} WHERE id = ${runId}`;
		});

	const finish = Effect.fn('RunStore.finish')(function* (summary: Summary) {
		const { runId } = summary;
		const encoded = yield* encodeSummary(summary);
		const at = yield* DateTime.now;
		return yield* appending(
			Effect.gen(function* () {
				yield* updateRun(runId, isUnfinished, {
					status: summary.status,
					summary: encoded
				});
				const cancelled =
					summary.status === 'cancelled'
						? [yield* insertEvent(runId, RunEvent.cases.RunCancelled.make({ at }))]
						: [];
				const finished = yield* insertEvent(
					runId,
					RunEvent.cases.RunFinished.make({ at, summary })
				);
				return { cancelled, finished };
			}),
			({ cancelled, finished }) => [...cancelled, finished]
		).pipe(Effect.map(({ finished }) => finished));
	}, orDieStorage);

	const markInterrupted = Effect.gen(function* () {
		const at = yield* DateTime.now;
		const envelopes = yield* appending(
			Effect.gen(function* () {
				const rows = yield* sql<{ id: RunId }>`
					UPDATE runs SET status = 'interrupted', updated_at = ${DateTime.toEpochMillis(at)}
					WHERE status = 'running' RETURNING id
				`;
				return yield* Effect.forEach(rows, (row) =>
					insertEvent(row.id, RunEvent.cases.RunInterrupted.make({ at }))
				);
			}),
			(envelopes) => envelopes
		);
		return envelopes.map((envelope) => envelope.runId);
	}).pipe(Effect.withSpan('RunStore.markInterrupted'), orDieStorage);

	const markResumed = Effect.fn('RunStore.markResumed')(function* (runId: RunId) {
		const at = yield* DateTime.now;
		return yield* appending(
			Effect.gen(function* () {
				yield* updateRun(runId, (status) => status === 'interrupted', {
					status: 'running'
				});
				return yield* insertEvent(runId, RunEvent.cases.RunResumed.make({ at }));
			}),
			(envelope) => [envelope]
		);
	}, orDieStorage);

	const store: RunStoreShape = {
		create,
		append,
		events,
		follow,
		saveSnapshot,
		loadSnapshot,
		get,
		list,
		finish,
		markInterrupted,
		markResumed
	};
	return store;
});

/** The run store: runs, their append-only event logs and their latest snapshots. */
export class RunStore extends Context.Service<RunStore, RunStoreShape>()('@ship/store/RunStore') {
	/** Migrates the database behind `SqlClient`, then serves the store from it. */
	static readonly layer = Layer.effect(this, make).pipe(
		Layer.provide(SqliteMigrator.layer({ loader: migrations })),
		Layer.orDie
	);

	/** The store on a SQLite file, created if absent. */
	static readonly layerFile = (filename: string) =>
		this.layer.pipe(Layer.provide(SqliteClient.layer({ filename })));

	/** The store as the `RunJournal` a run driver writes to. */
	static readonly journal: Layer.Layer<RunJournal, never, RunStore> = Layer.effect(
		RunJournal,
		Effect.gen(function* () {
			return RunJournal.of(yield* RunStore);
		})
	);
}
