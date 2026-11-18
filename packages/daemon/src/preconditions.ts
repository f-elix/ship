import {
	ConfigLoader,
	Git,
	Locks,
	PLAN_FILES,
	PreconditionFailed,
	type Env,
	type GitSha,
	type PreconditionReason,
	type ProjectKey,
	type ResolvedConfig
} from '@ship/core';
import { Effect, FileSystem } from 'effect';
import { join } from 'node:path';

export interface RunRequest {
	readonly planDir: string;
	readonly cwd: string;
	readonly env: Env;
}

/** What a run starts from once its preconditions hold. */
export interface RunStart {
	readonly projectKey: ProjectKey;
	readonly branch: string;
	/** HEAD when the run starts: the base of the run's own changes. */
	readonly baseSha: GitSha;
	readonly config: ResolvedConfig;
}

const failed = (reason: PreconditionReason, detail: string) =>
	new PreconditionFailed({ reason, detail });

/**
 * Loads and resolves the project's config, failing when it is missing or invalid or when a
 * check uses a lock resource the daemon has no permits for.
 */
export const loadProjectConfig = Effect.fn('loadProjectConfig')(function* (key: ProjectKey) {
	const loader = yield* ConfigLoader;
	const locks = yield* Locks;
	const { resolved } = yield* loader
		.load(key)
		.pipe(Effect.mapError((error) => failed(error.reason, `${error.path}: ${error.detail}`)));
	// Lock permits are read once when the daemon starts, so a lock added to the global
	// config since then is unknown here.
	for (const check of resolved.checks) {
		yield* locks
			.status(check.lock)
			.pipe(
				Effect.mapError(() =>
					failed(
						'invalid-config',
						`check ${check.name} uses lock ${check.lock}, which the daemon does not have; if it was added to the global config since the daemon started, restart it with \`ship daemon restart\``
					)
				)
			);
	}
	return resolved;
});

/**
 * Checks that a run can start in the caller's repo, with the caller's env: a git repo on a
 * branch other than the default one, a plan dir holding the plan files, a project config
 * whose lock resources the daemon has, and a clean working tree. The plan dir is added to
 * `.git/info/exclude` before the tree is checked, so plan files are never committed and never
 * make the tree dirty.
 *
 * Git failures past the first check are not precondition failures, so they are defects.
 */
export const checkPreconditions = Effect.fn('checkPreconditions')(
	function* (request: RunRequest) {
		const git = yield* Git;
		const fs = yield* FileSystem.FileSystem;
		const repo = { cwd: request.cwd, env: request.env };

		yield* git
			.repoRoot(repo)
			.pipe(Effect.mapError((error) => failed('not-a-git-repo', error.message)));
		const branch = yield* git.currentBranch(repo);
		if (branch === null)
			return yield* failed('detached-head', `HEAD is detached in ${request.cwd}`);
		const defaultBranch = yield* git
			.defaultBranch(repo)
			.pipe(
				Effect.mapError(() =>
					failed(
						'unknown-default-branch',
						'origin/HEAD is not set and there is no main or master; run `git remote set-head origin --auto`'
					)
				)
			);
		if (branch === defaultBranch) {
			return yield* failed(
				'on-default-branch',
				`${branch} is the default branch; switch to a feature branch first`
			);
		}

		const missing = yield* Effect.filter(Object.values(PLAN_FILES), (file) =>
			Effect.map(fs.exists(join(request.planDir, file)), (exists) => !exists)
		);
		if (missing.length > 0) {
			return yield* failed(
				'missing-plan-files',
				`${request.planDir} has no ${missing.join(' or ')}`
			);
		}

		const projectKey = yield* git.projectKey(repo);
		const resolved = yield* loadProjectConfig(projectKey);

		yield* git.excludePath(repo, request.planDir);
		if (!(yield* git.isClean(repo))) {
			return yield* failed(
				'dirty-tree',
				`${request.cwd} has uncommitted changes; commit or stash them first`
			);
		}

		const baseSha = yield* git.headSha(repo);
		return { projectKey, branch, baseSha, config: resolved } satisfies RunStart;
	},
	Effect.catchTags({ GitError: Effect.die, PlatformError: Effect.die })
);
