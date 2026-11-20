import { Effect } from 'effect';
import { Migrator, SqlClient } from 'effect/sql';

/** Schema migrations, applied in id order. Never edit one that has shipped; add a new one. */
const byName = {
	'1_init': Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				project_key TEXT NOT NULL,
				cwd TEXT NOT NULL,
				plan_dir TEXT NOT NULL,
				branch TEXT NOT NULL,
				status TEXT NOT NULL,
				state TEXT NOT NULL,
				round INTEGER NOT NULL,
				pr_url TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				summary TEXT
			) STRICT
		`;
		yield* sql`CREATE INDEX runs_by_updated_at ON runs (updated_at DESC)`;
		yield* sql`CREATE INDEX runs_by_status ON runs (status)`;
		yield* sql`
			CREATE TABLE events (
				run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
				seq INTEGER NOT NULL CHECK (seq >= 1),
				type TEXT NOT NULL,
				payload TEXT NOT NULL,
				PRIMARY KEY (run_id, seq)
			) STRICT, WITHOUT ROWID
		`;
		yield* sql`
			CREATE TABLE snapshots (
				run_id TEXT PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
				snapshot_version INTEGER NOT NULL,
				snapshot TEXT NOT NULL,
				env_paths TEXT NOT NULL,
				saved_at INTEGER NOT NULL
			) STRICT
		`;
	}),
	/**
	 * Adds `ship review` runs: `kind` tells them from `ship run` ones (existing rows are
	 * `ship`), `subject` holds a review run's PR URL, and `plan_dir` and `branch` become
	 * nullable, since a review run has neither. SQLite cannot drop a NOT NULL constraint, so
	 * `runs` is rebuilt, and with it `events` and `snapshots`: dropping `runs` while they
	 * still referenced it would cascade-delete their rows when foreign keys are on.
	 */
	'2_run_kind': Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			CREATE TABLE runs_new (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL DEFAULT 'ship',
				project_key TEXT NOT NULL,
				cwd TEXT NOT NULL,
				plan_dir TEXT,
				branch TEXT,
				subject TEXT,
				status TEXT NOT NULL,
				state TEXT NOT NULL,
				round INTEGER NOT NULL,
				pr_url TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				summary TEXT
			) STRICT
		`;
		yield* sql`
			INSERT INTO runs_new (
				id, project_key, cwd, plan_dir, branch, status, state, round, pr_url,
				created_at, updated_at, summary
			)
			SELECT
				id, project_key, cwd, plan_dir, branch, status, state, round, pr_url,
				created_at, updated_at, summary
			FROM runs
		`;
		yield* sql`
			CREATE TABLE events_new (
				run_id TEXT NOT NULL REFERENCES runs_new (id) ON DELETE CASCADE,
				seq INTEGER NOT NULL CHECK (seq >= 1),
				type TEXT NOT NULL,
				payload TEXT NOT NULL,
				PRIMARY KEY (run_id, seq)
			) STRICT, WITHOUT ROWID
		`;
		yield* sql`INSERT INTO events_new SELECT run_id, seq, type, payload FROM events`;
		yield* sql`
			CREATE TABLE snapshots_new (
				run_id TEXT PRIMARY KEY REFERENCES runs_new (id) ON DELETE CASCADE,
				snapshot_version INTEGER NOT NULL,
				snapshot TEXT NOT NULL,
				env_paths TEXT NOT NULL,
				saved_at INTEGER NOT NULL
			) STRICT
		`;
		yield* sql`
			INSERT INTO snapshots_new
			SELECT run_id, snapshot_version, snapshot, env_paths, saved_at FROM snapshots
		`;
		// Children first, so dropping `runs` has nothing to cascade to.
		yield* sql`DROP TABLE events`;
		yield* sql`DROP TABLE snapshots`;
		yield* sql`DROP TABLE runs`;
		// Renaming `runs_new` also renames the references to it in the new child tables.
		yield* sql`ALTER TABLE runs_new RENAME TO runs`;
		yield* sql`ALTER TABLE events_new RENAME TO events`;
		yield* sql`ALTER TABLE snapshots_new RENAME TO snapshots`;
		yield* sql`CREATE INDEX runs_by_updated_at ON runs (updated_at DESC)`;
		yield* sql`CREATE INDEX runs_by_status ON runs (status)`;
	})
};

export const migrations = Migrator.fromRecord(byName);

/** The newest migration this build knows; a database past it was written by a newer ship. */
export const latestMigrationId = Math.max(
	...Object.keys(byName).map((name) => Number.parseInt(name, 10))
);
