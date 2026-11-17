import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { baselineWorkdir, Git, GitSha } from '../src/index.ts';
import { GitLive, tempRepo } from './temp-repo.ts';

describe('baselineWorkdir', () => {
	it.effect('runs in place when HEAD is the clean base commit', () =>
		Effect.gen(function* () {
			const { dir, work, git: run, write, repo } = yield* tempRepo;
			const git = yield* Git;
			write('plans/feature/spec.md', '# spec\n');
			yield* git.excludePath(repo, join(work, 'plans/feature'));
			const baseSha = GitSha.make(run('rev-parse', 'HEAD'));

			const workdir = yield* baselineWorkdir({
				repo,
				baseSha,
				worktreePath: join(dir, 'baseline')
			});
			expect(workdir).toEqual({ cwd: work, worktree: false });
			expect(existsSync(join(dir, 'baseline'))).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('uses a temporary worktree of the base, keeping the subdirectory, otherwise', () =>
		Effect.gen(function* () {
			const { dir, work, git: run, write, repo } = yield* tempRepo;
			const git = yield* Git;
			write('pkg/index.ts', 'export {};\n');
			yield* git.commit(repo, 'Package');
			const baseSha = GitSha.make(run('rev-parse', 'HEAD'));
			write('pkg/index.ts', 'export const changed = true;\n');
			yield* git.commit(repo, 'Change');
			const worktreePath = join(dir, 'runs/run-1/baseline');
			mkdirSync(join(work, 'pkg'), { recursive: true });

			const workdir = yield* Effect.scoped(
				Effect.gen(function* () {
					const workdir = yield* baselineWorkdir({
						repo: { ...repo, cwd: join(work, 'pkg') },
						baseSha,
						worktreePath
					});
					expect(yield* git.headSha({ ...repo, cwd: workdir.cwd })).toBe(baseSha);
					return workdir;
				})
			);
			expect(workdir).toEqual({ cwd: join(worktreePath, 'pkg'), worktree: true });
			expect(existsSync(worktreePath)).toBe(false);

			// A dirty tree at the base commit also needs the worktree.
			run('reset', '--quiet', '--hard', baseSha);
			write('scratch.txt', 'x\n');
			const dirty = yield* Effect.scoped(baselineWorkdir({ repo, baseSha, worktreePath }));
			expect(dirty.worktree).toBe(true);
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);
});
