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
	Reviews,
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
	type ReviewId,
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
 * make the tree dirty. `ship implement` starts from the same checks.
 *
 * Git failures past the first check are not precondition failures, so they are defects.
 */
export const checkPreconditions = Effect.fn('checkPreconditions')(
	function* (request: RunRequest) {
		const repo = { cwd: request.cwd, env: request.env };
		const branch = yield* requireFeatureBranch(repo);
		yield* requirePlanFiles(request.planDir);
		const projectKey = yield* (yield* Git).projectKey(repo);
		const config = yield* loadProjectConfig(projectKey);
		yield* requireCleanTree(repo, request.planDir);
		const baseSha = yield* (yield* Git).headSha(repo);
		return { projectKey, branch, baseSha, config } satisfies RunStart;
	},
	Effect.catchTags({ GitError: Effect.die, PlatformError: Effect.die })
);

/** What `ship checks` or `ship pr` asks the daemon to do on the caller's branch. */
export interface BranchRequest {
	/** The plan the PR describes; `null` for `ship checks`, and `ship pr` without one. */
	readonly planDir: string | null;
	readonly cwd: string;
	readonly env: Env;
}

/**
 * Checks that `ship checks` or `ship pr` can work on the caller's branch: as
 * `checkPreconditions`, except that the plan is optional and `ship pr` takes the default
 * config when the project has none. The run's range starts at the merge base of `HEAD`
 * and the default branch.
 *
 * Git failures past the first check are defects.
 */
export const checkBranchPreconditions = Effect.fn('checkBranchPreconditions')(
	function* (command: 'checks' | 'pr', request: BranchRequest) {
		const git = yield* Git;
		const repo = { cwd: request.cwd, env: request.env };
		const branch = yield* requireFeatureBranch(repo);
		if (request.planDir !== null) yield* requirePlanFiles(request.planDir);
		const projectKey = yield* git.projectKey(repo);
		const config =
			command === 'checks'
				? yield* loadProjectConfig(projectKey)
				: yield* loadConfigOrDefaults(projectKey);
		yield* requireCleanTree(repo, request.planDir);
		const baseSha = yield* git.baseSha(repo);
		return { projectKey, branch, baseSha, config } satisfies RunStart;
	},
	Effect.catchTags({ GitError: Effect.die, PlatformError: Effect.die })
);

/** Fails unless the repo is on a branch other than the default one; returns the branch. */
const requireFeatureBranch = Effect.fnUntraced(function* (repo: Repo) {
	const git = yield* Git;
	yield* git
		.repoRoot(repo)
		.pipe(Effect.mapError((error) => failed('not-a-git-repo', error.message)));
	const branch = yield* git.currentBranch(repo);
	if (branch === null) return yield* failed('detached-head', `HEAD is detached in ${repo.cwd}`);
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
	return branch;
});

/** Fails unless `planDir` holds the plan files. */
const requirePlanFiles = Effect.fnUntraced(function* (planDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const missing = yield* Effect.filter(Object.values(PLAN_FILES), (file) =>
		Effect.map(fs.exists(join(planDir, file)), (exists) => !exists)
	);
	if (missing.length > 0) {
		return yield* failed('missing-plan-files', `${planDir} has no ${missing.join(' or ')}`);
	}
});

/**
 * Fails unless the tree is clean, once the plan dir, if any, is excluded from git, so
 * plan files are never committed and never make the tree dirty.
 */
const requireCleanTree = Effect.fnUntraced(function* (repo: Repo, planDir: string | null) {
	const git = yield* Git;
	if (planDir !== null) yield* git.excludePath(repo, planDir);
	if (!(yield* git.isClean(repo))) {
		return yield* failed(
			'dirty-tree',
			`${repo.cwd} has uncommitted changes; commit or stash them first`
		);
	}
});

/** What `ship post` asks the daemon to post, and from where. */
export interface PostRequest {
	readonly review: ReviewId;
	/** The caller's checkout of the reviewed PR, at the head the review reviewed. */
	readonly cwd: string;
	readonly env: Env;
}

/** What a post run starts from once its preconditions hold. */
export interface PostStart {
	readonly projectKey: ProjectKey;
	/** The base the review reviewed from. */
	readonly baseSha: GitSha;
	readonly config: ResolvedConfig;
}

/**
 * Checks that `ship post` can post the stored review from the caller's checkout: the
 * review exists, has findings and a PR of the repository `origin` points at, and `HEAD` is
 * the head it reviewed. The project config may be missing; the defaults apply.
 *
 * Git failures past the first check are defects.
 */
export const checkPostPreconditions = Effect.fn('checkPostPreconditions')(
	function* (request: PostRequest) {
		const git = yield* Git;
		const reviews = yield* Reviews;
		const repo = { cwd: request.cwd, env: request.env };
		const projectKey = yield* originKey(repo);
		const stored = yield* reviews
			.get(request.review)
			.pipe(
				Effect.mapError((error) =>
					failed(
						'review-not-found',
						`${error.message}; \`ship list\` shows the runs that stored reviews`,
						error
					)
				)
			);
		const { subject } = stored;
		if (subject.prUrl === null) {
			return yield* failed(
				'review-without-pr',
				`The review ${stored.id} has no PR to post on; open a PR and run \`ship review\` on it first`
			);
		}
		if (subject.projectKey !== projectKey) {
			return yield* failed(
				'pr-other-repo',
				`The review ${stored.id} is of ${subject.prUrl}, but origin is ${projectKey}; run ship post from a clone of the PR's base repository`
			);
		}
		if (stored.findings.length === 0) {
			return yield* failed('no-findings', `The review ${stored.id} has no findings to post`);
		}
		const config = yield* loadConfigOrDefaults(projectKey);
		const head = yield* git.headSha(repo);
		if (head !== subject.headSha) {
			const number = parsePrUrl(subject.prUrl)?.number;
			return yield* failed(
				'pr-not-checked-out',
				`HEAD in ${repo.cwd} is ${head}, not the reviewed head ${subject.headSha}${number === undefined ? '' : `; run \`gh pr checkout ${number}\`, or \`ship review ${number}\` again if the PR moved on`}`
			);
		}
		return { projectKey, baseSha: subject.baseSha, config } satisfies PostStart;
	},
	Effect.catchTags({ GitError: Effect.die })
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
		const gh = yield* Gh;
		const repo = { cwd: request.cwd, env: request.env };

		const projectKey = yield* originKey(repo);
		const pr = yield* gh
			.viewPr(repo, request.pr)
			.pipe(Effect.mapError((error) => failed('pr-not-found', error.message, error)));
		yield* requireOriginPr('review', pr, projectKey);
		const config = yield* loadConfigOrDefaults(projectKey);
		yield* requireCheckedOut(repo, pr);
		const baseSha = yield* prMergeBase(repo, pr);
		return {
			projectKey,
			pr: {
				number: pr.number,
				url: pr.url,
				title: pr.title,
				body: pr.body,
				baseSha,
				headSha: pr.headSha
			},
			config
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

/** What a fix run starts from once its preconditions hold. */
export interface FixStart {
	readonly projectKey: ProjectKey;
	readonly pr: TargetPr;
	readonly loaded: LoadedFindings;
	readonly config: ResolvedConfig;
	/** The PR's branch, where the run pushes; `null` with `local`. */
	readonly push: PushTarget | null;
}

/** What a recheck run starts from once its preconditions hold. */
export interface RecheckStart {
	readonly projectKey: ProjectKey;
	readonly pr: TargetPr;
	readonly loaded: LoadedFindings;
	readonly config: ResolvedConfig;
	/** The merge base of the PR's base branch and its head, where the run's range starts. */
	readonly baseSha: GitSha;
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
 * Checks that `ship fix` can work through `request.source` in the caller's checkout, and
 * loads its findings: the project config is valid, the source exists and names a PR of the
 * repository `origin` points at, the checkout is clean with `HEAD` at the PR's head, the
 * PR's branch can be pushed to unless `local`, and there is at least one must-fix finding
 * or nit. The run needs the project config for its checks, and loading the findings needs
 * its Clef flag.
 *
 * Git failures past the first check are defects.
 */
export const checkFixPreconditions = Effect.fn('checkFixPreconditions')(
	function* (request: FindingsRequest) {
		const repo = { cwd: request.cwd, env: request.env };
		const projectKey = yield* originKey(repo);
		const config = yield* loadProjectConfig(projectKey);
		const { pr, loaded } = yield* loadSource('fix', repo, request.source, projectKey, config);
		yield* requireCheckedOut(repo, pr);
		const push = request.local ? null : pushTarget(pr);
		if (!request.local && push === null) {
			return yield* failed(
				'pr-not-pushable',
				pr.headRepository === null
					? `${pr.url}'s branch ${pr.headRef} no longer exists; run with --local to keep the fix local`
					: `${pr.url} comes from a fork whose maintainers may not push to it; run with --local to keep the fix local`
			);
		}
		yield* requireFindings('fix', pr, loaded);
		return {
			projectKey,
			pr: targetPr(pr),
			loaded,
			config,
			push
		} satisfies FixStart;
	},
	Effect.catchTags({ GitError: Effect.die })
);

/**
 * Checks that `ship recheck` can recheck `request.source` in the caller's checkout, and
 * loads its findings: as `checkFixPreconditions`, except that the project config may be
 * missing (the defaults apply) and nothing is pushed. It fetches the PR's base branch for
 * the merge base, as `ship review` does.
 *
 * Git failures past the first check are defects, except fetching the base branch, which
 * fails as `base-fetch-failed`.
 */
export const checkRecheckPreconditions = Effect.fn('checkRecheckPreconditions')(
	function* (request: FindingsRequest) {
		const repo = { cwd: request.cwd, env: request.env };
		const projectKey = yield* originKey(repo);
		const config = yield* loadConfigOrDefaults(projectKey);
		const { pr, loaded } = yield* loadSource(
			'recheck',
			repo,
			request.source,
			projectKey,
			config
		);
		yield* requireCheckedOut(repo, pr);
		yield* requireFindings('recheck', pr, loaded);
		const baseSha = yield* prMergeBase(repo, pr);
		return {
			projectKey,
			pr: targetPr(pr),
			loaded,
			config,
			baseSha
		} satisfies RecheckStart;
	},
	Effect.catchTags({ GitError: Effect.die })
);

const targetPr = (pr: PrDetails): TargetPr => ({
	number: pr.number,
	url: pr.url,
	headSha: pr.headSha
});

/**
 * Loads `source`, with Clef rating its unlabelled threads unless `config` turned it off,
 * and checks that its PR belongs to `projectKey`, the repository `origin` points at.
 */
const loadSource = Effect.fnUntraced(function* (
	command: 'fix' | 'recheck',
	repo: Repo,
	source: FindingsSource,
	projectKey: ProjectKey,
	config: ResolvedConfig
) {
	const { pr, loaded } = yield* loadFindings(repo, source, { config }).pipe(
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
	yield* requireOriginPr(command, pr, projectKey);
	return { pr, loaded };
});

/** Fails when the source has no must-fix finding or nit to work through. */
const requireFindings = (command: 'fix' | 'recheck', pr: PrDetails, loaded: LoadedFindings) =>
	loaded.findings.length > 0
		? Effect.void
		: Effect.fail(
				failed(
					'no-findings',
					`There are no must-fix findings or nits to ${command} on ${pr.url}`
				)
			);

// --- The checks several commands share ---

type Repo = { readonly cwd: string; readonly env: Env };

/** The project `origin` points at, failing as `not-a-git-repo` outside a repo. */
const originKey = Effect.fnUntraced(function* (repo: Repo) {
	const git = yield* Git;
	yield* git
		.repoRoot(repo)
		.pipe(Effect.mapError((error) => failed('not-a-git-repo', error.message)));
	return yield* git.projectKey(repo);
});

/** The project config, or the defaults when the project has none. */
const loadConfigOrDefaults = Effect.fnUntraced(function* (projectKey: ProjectKey) {
	const loader = yield* ConfigLoader;
	const { resolved } = yield* loader
		.loadOrDefaults(projectKey)
		.pipe(Effect.mapError((error) => failed(error.reason, `${error.path}: ${error.detail}`)));
	return resolved;
});

/** Fails unless `pr` is a PR of the repository `origin` points at. */
const requireOriginPr = (command: string, pr: PrDetails, projectKey: ProjectKey) => {
	const prRepo = prRepoKey(pr.url);
	return prRepo === projectKey
		? Effect.void
		: Effect.fail(
				failed(
					'pr-other-repo',
					`${pr.url} belongs to ${prRepo ?? 'another repository'}, but origin is ${projectKey}; run ship ${command} from a clone of the PR's base repository`
				)
			);
};

/** Fails unless the checkout is clean with `HEAD` at `pr`'s head. */
const requireCheckedOut = Effect.fnUntraced(function* (repo: Repo, pr: PrDetails) {
	const git = yield* Git;
	const checkout = `run \`gh pr checkout ${pr.number}\` first`;
	if (!(yield* git.isClean(repo))) {
		return yield* failed(
			'dirty-tree',
			`${repo.cwd} has uncommitted changes; commit or stash them, then ${checkout}`
		);
	}
	const head = yield* git.headSha(repo);
	if (head !== pr.headSha) {
		return yield* failed(
			'pr-not-checked-out',
			`HEAD in ${repo.cwd} is ${head}, not ${pr.url}'s head ${pr.headSha}; ${checkout}`
		);
	}
});

/** Fetches `pr`'s base branch from `origin` and returns its merge base with the PR's head. */
const prMergeBase = Effect.fnUntraced(function* (repo: Repo, pr: PrDetails) {
	const git = yield* Git;
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
	return yield* git.mergeBase(repo, baseTip, pr.headSha);
});
