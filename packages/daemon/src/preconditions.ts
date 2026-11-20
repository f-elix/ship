import {
	ConfigLoader,
	Gh,
	Git,
	Locks,
	PLAN_FILES,
	PreconditionFailed,
	prRepoKey,
	type Env,
	type GitSha,
	type PreconditionReason,
	type ProjectKey,
	type ResolvedConfig,
	type ReviewedPr
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

/** What `ship review` asks the daemon to review, and from where. */
export interface ReviewRequest {
	/** A PR number in the repo's GitHub repository, or a PR URL. */
	readonly pr: string;
	/** Where `ship review` was run: a clone of the PR's base repository. */
	readonly cwd: string;
	/** The caller's env, which git and `gh` run with. */
	readonly env: Env;
}

/** What a review run starts from once its preconditions hold. */
export interface ReviewStart {
	readonly projectKey: ProjectKey;
	/** The PR, with its head fetched and pinned and its merge base found. */
	readonly pr: ReviewedPr;
	readonly config: ResolvedConfig;
}

/**
 * Checks that `ship review` can review the PR from the caller's repo, with the caller's env,
 * and pins what it reviews: the PR exists and belongs to the repository `origin` points at,
 * and the project config, when there is one, is valid, as `ship run` would read it. Then it
 * fetches the PR's head as `refs/pull/<n>/head` and its base branch from `origin`; the run
 * reviews the merge base of the two up to that head.
 *
 * Git failures past the first check are not precondition failures, so they are defects,
 * except fetching, which fails as `pr-not-found`.
 */
export const checkReviewPreconditions = Effect.fn('checkReviewPreconditions')(
	function* (request: ReviewRequest) {
		const git = yield* Git;
		const gh = yield* Gh;
		const loader = yield* ConfigLoader;
		const repo = { cwd: request.cwd, env: request.env };

		yield* git
			.repoRoot(repo)
			.pipe(Effect.mapError((error) => failed('not-a-git-repo', error.message)));
		const projectKey = yield* git.projectKey(repo);
		const pr = yield* gh
			.viewPr(repo, request.pr)
			.pipe(Effect.mapError((error) => failed('pr-not-found', error.message)));
		const prRepo = prRepoKey(pr.url);
		if (prRepo !== projectKey) {
			return yield* failed(
				'pr-other-repo',
				`${pr.url} belongs to ${prRepo ?? 'another repository'}, but origin is ${projectKey}; run ship review from a clone of the PR's base repository`
			);
		}

		const { resolved } = yield* loader
			.loadOrDefaults(projectKey)
			.pipe(
				Effect.mapError((error) => failed(error.reason, `${error.path}: ${error.detail}`))
			);

		const fetchFailed = (error: { readonly message: string }) =>
			failed('pr-not-found', `Could not fetch ${pr.url} from origin: ${error.message}`);
		const headSha = yield* git
			.fetchRef(repo, `refs/pull/${pr.number}/head`)
			.pipe(Effect.mapError(fetchFailed));
		const baseTip = yield* git
			.fetchRef(repo, `refs/heads/${pr.baseRef}`)
			.pipe(Effect.mapError(fetchFailed));
		const baseSha = yield* git.mergeBase(repo, baseTip, headSha);
		return {
			projectKey,
			pr: {
				number: pr.number,
				url: pr.url,
				title: pr.title,
				body: pr.body,
				baseSha,
				headSha
			},
			config: resolved
		} satisfies ReviewStart;
	},
	Effect.catchTags({ GitError: Effect.die })
);
