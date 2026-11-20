import {
	ConfigLoader,
	Gh,
	Git,
	loadFindings,
	Locks,
	parsePrUrl,
	PLAN_FILES,
	PreconditionFailed,
	prRepoKey,
	type Env,
	type FindingsSource,
	type GitSha,
	type LoadedFindings,
	type PrDetails,
	type PreconditionReason,
	type ProjectKey,
	type PushTarget,
	type ResolvedConfig,
	type ReviewedPr,
	type TargetPr
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

const failed = (reason: PreconditionReason, detail: string, cause?: unknown) =>
	new PreconditionFailed(cause === undefined ? { reason, detail } : { reason, detail, cause });

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
	/**
	 * Where `ship review` was run: a clone of the PR's base repository, with the PR checked
	 * out and nothing uncommitted.
	 */
	readonly cwd: string;
	/** The caller's env, which git and `gh` run with. */
	readonly env: Env;
}

/** What a review run starts from once its preconditions hold. */
export interface ReviewStart {
	readonly projectKey: ProjectKey;
	/** The PR, with its head pinned to the checked-out commit and its merge base found. */
	readonly pr: ReviewedPr;
	readonly config: ResolvedConfig;
}

/**
 * Checks that `ship review` can review the PR in the caller's checkout, with the caller's
 * env, and pins what it reviews: the PR exists and belongs to the repository `origin` points
 * at, the project config, when there is one, is valid, as `ship run` would read it, and the
 * checkout is clean with `HEAD` at the PR's head commit. ship never checks the PR out
 * itself; the caller does, with `gh pr checkout <n>`. Then it fetches the PR's base branch
 * from `origin`; the run reviews the merge base of the base and `HEAD` up to `HEAD`.
 *
 * Git failures past the first check are not precondition failures, so they are defects,
 * except fetching the base branch, which fails as `base-fetch-failed` with the git error as
 * its `cause`.
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
			.pipe(Effect.mapError((error) => failed('pr-not-found', error.message, error)));
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

		const checkout = `run \`gh pr checkout ${pr.number}\` first`;
		if (!(yield* git.isClean(repo))) {
			return yield* failed(
				'dirty-tree',
				`${request.cwd} has uncommitted changes; commit or stash them, then ${checkout}`
			);
		}
		const headSha = pr.headSha;
		const head = yield* git.headSha(repo);
		if (head !== headSha) {
			return yield* failed(
				'pr-not-checked-out',
				`HEAD in ${request.cwd} is ${head}, not ${pr.url}'s head ${headSha}; ${checkout}`
			);
		}
		const baseTip = yield* git
			.fetchRef(repo, `refs/heads/${pr.baseRef}`)
			.pipe(
				Effect.mapError((error) =>
					failed(
						'base-fetch-failed',
						`Could not fetch ${pr.url}'s base branch ${pr.baseRef} from origin: ${error.message}`,
						error
					)
				)
			);
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

/** What `ship fix` or `ship recheck` asks the daemon to work through, and from where. */
export interface FindingsRequest {
	readonly source: FindingsSource;
	/** With `local`, nothing is pushed or resolved on GitHub. */
	readonly local: boolean;
	/** The caller's checkout of the PR, at its head, with nothing uncommitted. */
	readonly cwd: string;
	/** The caller's env, which git and `gh` run with. */
	readonly env: Env;
}

/** What a fix or recheck run starts from once its preconditions hold. */
export interface FindingsStart {
	readonly projectKey: ProjectKey;
	readonly pr: TargetPr;
	readonly loaded: LoadedFindings;
	readonly config: ResolvedConfig;
	/** The PR's branch, where a fix run pushes; `null` with `local`. */
	readonly push: PushTarget | null;
	/** The merge base of the PR's base branch and its head; only a recheck run needs it. */
	readonly mergeBase: GitSha | null;
}

/**
 * Where a fix to `pr` is pushed: the PR's branch on `origin` for a PR from the base
 * repository, or on the fork, by URL, when its maintainers may push to it. `null` when
 * the branch cannot be pushed to.
 */
export const pushTarget = (pr: PrDetails): PushTarget | null => {
	if (pr.headRepository === null) return null;
	if (!pr.isCrossRepository) return { remote: 'origin', ref: pr.headRef };
	if (!pr.maintainerCanModify) return null;
	const host = parsePrUrl(pr.url)?.host ?? 'github.com';
	const { owner, name } = pr.headRepository;
	return { remote: `https://${host}/${owner}/${name}.git`, ref: pr.headRef };
};

/**
 * Checks that `ship fix` (`kind` `fix`) or `ship recheck` can work through `source` in the
 * caller's checkout, and loads its findings: the source exists and names a PR of the
 * repository `origin` points at, the project config is valid (a fix run needs it, for its
 * checks; a recheck run takes the defaults without one), the checkout is clean with `HEAD`
 * at the PR's head, and there is at least one must-fix finding or nit. A fix run that
 * pushes also needs a PR branch it may push to; a recheck run fetches the PR's base branch
 * for the merge base, as `ship review` does.
 *
 * Git failures past the first check are defects, except fetching the base branch, which
 * fails as `base-fetch-failed`.
 */
export const checkFindingsPreconditions = Effect.fn('checkFindingsPreconditions')(
	function* (kind: 'fix' | 'recheck', request: FindingsRequest) {
		const git = yield* Git;
		const loader = yield* ConfigLoader;
		const repo = { cwd: request.cwd, env: request.env };

		yield* git
			.repoRoot(repo)
			.pipe(Effect.mapError((error) => failed('not-a-git-repo', error.message)));
		const projectKey = yield* git.projectKey(repo);
		const { pr, loaded } = yield* loadFindings(repo, request.source).pipe(
			Effect.catchTags({
				ReviewNotFound: (error) =>
					Effect.fail(
						failed(
							'review-not-found',
							`${error.message}; \`ship list\` shows the runs that stored reviews`,
							error
						)
					),
				ReviewWithoutPr: (error) =>
					Effect.fail(
						failed(
							'review-without-pr',
							`${error.message}; open a PR and run \`ship review\` on it first`,
							error
						)
					),
				PrNotFound: (error) => Effect.fail(failed('pr-not-found', error.message, error)),
				GhError: (error) =>
					Effect.fail(
						failed(
							'github-failed',
							`Could not read the review threads: ${error.message}`,
							error
						)
					)
			})
		);
		const prRepo = prRepoKey(pr.url);
		if (prRepo !== projectKey) {
			return yield* failed(
				'pr-other-repo',
				`${pr.url} belongs to ${prRepo ?? 'another repository'}, but origin is ${projectKey}; run ship ${kind} from a clone of the PR's base repository`
			);
		}

		const config =
			kind === 'fix'
				? yield* loadProjectConfig(projectKey)
				: (yield* loader
						.loadOrDefaults(projectKey)
						.pipe(
							Effect.mapError((error) =>
								failed(error.reason, `${error.path}: ${error.detail}`)
							)
						)).resolved;

		const checkout = `run \`gh pr checkout ${pr.number}\` first`;
		if (!(yield* git.isClean(repo))) {
			return yield* failed(
				'dirty-tree',
				`${request.cwd} has uncommitted changes; commit or stash them, then ${checkout}`
			);
		}
		const head = yield* git.headSha(repo);
		if (head !== pr.headSha) {
			return yield* failed(
				'pr-not-checked-out',
				`HEAD in ${request.cwd} is ${head}, not ${pr.url}'s head ${pr.headSha}; ${checkout}`
			);
		}

		const push = kind === 'fix' && !request.local ? pushTarget(pr) : null;
		if (kind === 'fix' && !request.local && push === null) {
			return yield* failed(
				'pr-not-pushable',
				pr.headRepository === null
					? `${pr.url}'s branch ${pr.headRef} no longer exists; run with --local to keep the fix local`
					: `${pr.url} comes from a fork whose maintainers may not push to it; run with --local to keep the fix local`
			);
		}
		if (loaded.findings.length === 0) {
			return yield* failed(
				'no-findings',
				`There are no must-fix findings or nits to ${kind} on ${pr.url}`
			);
		}

		let mergeBase: GitSha | null = null;
		if (kind === 'recheck') {
			const baseTip = yield* git
				.fetchRef(repo, `refs/heads/${pr.baseRef}`)
				.pipe(
					Effect.mapError((error) =>
						failed(
							'base-fetch-failed',
							`Could not fetch ${pr.url}'s base branch ${pr.baseRef} from origin: ${error.message}`,
							error
						)
					)
				);
			mergeBase = yield* git.mergeBase(repo, baseTip, pr.headSha);
		}
		return {
			projectKey,
			pr: { number: pr.number, url: pr.url, headSha: pr.headSha },
			loaded,
			config,
			push,
			mergeBase
		} satisfies FindingsStart;
	},
	Effect.catchTags({ GitError: Effect.die })
);
