import { Effect } from 'effect';
import { Git, type GitRepo } from './git.ts';
import type { GitSha } from './primitives.ts';

export interface BaselineWorkdir {
	/** Where to run the baseline checks: the matching directory at the base commit. */
	readonly cwd: string;
	/** Whether `cwd` is in a temporary worktree, removed when the scope closes. */
	readonly worktree: boolean;
}

/**
 * Where the baseline checks run on the base commit, without touching the user's working
 * tree.
 *
 * - HEAD is the base commit and the tree is clean (the plan dir must already be in
 *   `.git/info/exclude`): the repo itself is the base commit, so the checks run in place,
 *   with installed dependencies and build caches.
 * - Otherwise: a detached worktree of the base commit at `worktreePath`, normally
 *   `~/.ship/runs/<id>/baseline`, removed when the scope closes. It holds tracked files
 *   only, so a check that needs untracked files such as `node_modules` fails there.
 */
export const baselineWorkdir = Effect.fn('baselineWorkdir')(function* (input: {
	readonly repo: GitRepo;
	readonly baseSha: GitSha;
	readonly worktreePath: string;
}) {
	const git = yield* Git;
	const head = yield* git.headSha(input.repo);
	if (head === input.baseSha && (yield* git.isClean(input.repo))) {
		return { cwd: input.repo.cwd, worktree: false } satisfies BaselineWorkdir;
	}
	const root = yield* git.repoRoot(input.repo);
	const worktree = yield* git.worktree(input.repo, {
		path: input.worktreePath,
		sha: input.baseSha
	});
	const cwd = input.repo.cwd.startsWith(`${root}/`)
		? `${worktree}${input.repo.cwd.slice(root.length)}`
		: worktree;
	return { cwd, worktree: true } satisfies BaselineWorkdir;
});
