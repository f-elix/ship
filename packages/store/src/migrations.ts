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
	})
};

export const migrations = Migrator.fromRecord(byName);

/** The newest migration this build knows; a database past it was written by a newer ship. */
export const latestMigrationId = Math.max(
	...Object.keys(byName).map((name) => Number.parseInt(name, 10))
);
