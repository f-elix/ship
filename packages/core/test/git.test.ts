import { assert, describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	Git,
	GitError,
	GitSha,
	parseAddedLines,
	parseNameStatus,
	unquoteGitPath
} from '../src/index.ts';
import { GitLive, tempRepo, tempRepoWithoutOrigin } from './temp-repo.ts';

const sha = (value: string) => GitSha.make(value);

describe('Git', () => {
	it.effect('reads the repo root, branches, project key and shas', () =>
		Effect.gen(function* () {
			const { work, git: run, repo } = yield* tempRepo;
			const git = yield* Git;
			mkdirSync(join(work, 'sub'));

			expect(yield* git.repoRoot({ ...repo, cwd: join(work, 'sub') })).toBe(work);
			expect(yield* git.defaultBranch(repo)).toBe('main');
			expect(yield* git.currentBranch(repo)).toBe('feature');
			expect(yield* git.originUrl(repo)).toMatch(/origin\.git$/);
			expect(yield* git.projectKey(repo)).toMatch(/origin$/);

			const main = run('rev-parse', 'main');
			run('commit', '--quiet', '--allow-empty', '-m', 'Feature work');
			expect(yield* git.baseSha(repo)).toBe(main);
			expect(yield* git.headSha(repo)).toBe(run('rev-parse', 'HEAD'));

			run('switch', '--quiet', '--detach');
			expect(yield* git.currentBranch(repo)).toBeNull();
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('uses origin/main over a stale local main for the base', () =>
		Effect.gen(function* () {
			const { git: run, repo } = yield* tempRepo;
			const git = yield* Git;
			// Advance origin/main past the local main, then branch from it.
			run('switch', '--quiet', 'main');
			run('commit', '--quiet', '--allow-empty', '-m', 'Upstream work');
			run('push', '--quiet', 'origin', 'main');
			const upstream = run('rev-parse', 'HEAD');
			run('reset', '--quiet', '--hard', 'HEAD~1');
			run('switch', '--quiet', '-C', 'feature', 'origin/main');
			expect(yield* git.baseSha(repo)).toBe(upstream);
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('falls back to main or master without origin, and the root as project key', () =>
		Effect.gen(function* () {
			const { work, git: run, repo } = yield* tempRepoWithoutOrigin;
			const git = yield* Git;
			expect(yield* git.originUrl(repo)).toBeNull();
			expect(yield* git.projectKey(repo)).toBe(work);
			expect(yield* git.defaultBranch(repo)).toBe('main');

			run('branch', '-m', 'main', 'master');
			expect(yield* git.defaultBranch(repo)).toBe('master');

			run('branch', '-m', 'master', 'trunk');
			const error = yield* Effect.flip(git.defaultBranch(repo));
			expect(error.message).toMatch(/No default branch/);
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('fails with a GitError carrying stderr outside a repo', () =>
		Effect.gen(function* () {
			const { dir, repo } = yield* tempRepo;
			const git = yield* Git;
			const error = yield* Effect.flip(git.repoRoot({ ...repo, cwd: dir }));
			assert.instanceOf(error, GitError);
			expect(error.exitCode).toBe(128);
			expect(error.stderr).toMatch(/not a git repository/);
			expect(error.message).toMatch(/^git rev-parse --show-toplevel exited with 128/);

			const missing = yield* Effect.flip(git.repoRoot({ ...repo, cwd: join(dir, 'nope') }));
			expect(missing.exitCode).toBeNull();
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('lists changed files with status, against a commit or the working tree', () =>
		Effect.gen(function* () {
			const { git: run, write, repo } = yield* tempRepo;
			const git = yield* Git;
			write('keep.txt', 'one\ntwo\nthree\nfour\n');
			write('gone.txt', 'bye\n');
			run('add', '.');
			run('commit', '--quiet', '-m', 'Setup');
			const from = sha(run('rev-parse', 'HEAD'));

			run('mv', 'keep.txt', 'kept.txt');
			run('rm', '--quiet', 'gone.txt');
			write('README.md', 'hello\nworld\n');
			write('dir with space/new file.ts', 'export {};\n');
			run('add', '.');
			run('commit', '--quiet', '-m', 'Change');
			const to = sha(run('rev-parse', 'HEAD'));
			write('untracked.md', 'draft\n');
			write('.gitignore', 'ignored.log\n');
			write('ignored.log', 'noise\n');

			const sortByPath = <T extends { path: string }>(files: ReadonlyArray<T>) =>
				[...files].sort((a, b) => a.path.localeCompare(b.path));

			expect(sortByPath(yield* git.changedFiles(repo, { from, to }))).toEqual([
				{ path: 'dir with space/new file.ts', status: 'added' },
				{ path: 'gone.txt', status: 'deleted' },
				{ path: 'kept.txt', status: 'renamed', oldPath: 'keep.txt' },
				{ path: 'README.md', status: 'modified' }
			]);
			expect(sortByPath(yield* git.changedFiles(repo, { from: to }))).toEqual([
				{ path: '.gitignore', status: 'added' },
				{ path: 'untracked.md', status: 'added' }
			]);
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('returns the diff, commits and added lines of a range', () =>
		Effect.gen(function* () {
			const { git: run, write, repo } = yield* tempRepo;
			const git = yield* Git;
			const from = sha(run('rev-parse', 'HEAD'));
			write('README.md', 'hello\n+++ not a header\n');
			write('café.ts', 'const a = 1;\n\nconst b = 2;\n');
			run('add', '.');
			run('commit', '--quiet', '-m', 'First');
			write('café.ts', 'const a = 1;\n// note\nconst b = 3;\n');
			run('add', '.');
			run('commit', '--quiet', '-m', 'Second\n\nWith a body');
			const to = sha(run('rev-parse', 'HEAD'));

			const diff = yield* git.diff(repo, { from, to });
			expect(diff).toContain('+++ b/README.md');
			expect(diff).toContain('+const b = 3;');

			const commits = yield* git.commits(repo, { from, to });
			expect(commits.map((commit) => commit.subject)).toEqual(['First', 'Second']);
			expect(commits[1]?.sha).toBe(to);

			expect(yield* git.addedLines(repo, { from, to })).toEqual({
				'README.md': ['+++ not a header'],
				'café.ts': ['const a = 1;', '// note', 'const b = 3;']
			});
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('commits every change, and returns null when there is nothing to commit', () =>
		Effect.gen(function* () {
			const { work, git: run, write, repo } = yield* tempRepo;
			const git = yield* Git;
			expect(yield* git.commit(repo, 'Nothing')).toBeNull();

			write('src/a.ts', 'export const a = 1;\n');
			// A failing hook would block the commit; ship's checks are the gate instead.
			write('.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
			chmodSync(join(work, '.git/hooks/pre-commit'), 0o755);
			const committed = yield* git.commit(repo, 'Add a\n\nBody');
			expect(committed).toBe(run('rev-parse', 'HEAD'));
			expect(run('log', '-1', '--format=%B')).toBe('Add a\n\nBody');
			expect(run('status', '--porcelain')).toBe('');
			expect(yield* git.isClean(repo)).toBe(true);
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('squashes the commits since base into one, idempotently', () =>
		Effect.gen(function* () {
			const { git: run, write, repo } = yield* tempRepo;
			const git = yield* Git;
			const base = sha(run('rev-parse', 'HEAD'));
			expect(yield* git.squash(repo, { base, message: 'Feature' })).toBe(base);

			write('a.txt', 'a\n');
			yield* git.commit(repo, 'One');
			write('b.txt', 'b\n');
			yield* git.commit(repo, 'Two');
			const squashed = yield* git.squash(repo, { base, message: 'Feature\n\nAll of it' });
			expect(run('rev-list', '--count', `${base}..HEAD`)).toBe('1');
			expect(run('log', '-1', '--format=%B')).toBe('Feature\n\nAll of it');
			expect(run('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
				'a.txt',
				'b.txt'
			]);

			expect(yield* git.squash(repo, { base, message: 'Feature\n\nAll of it' })).toBe(
				squashed
			);
			const renamed = yield* git.squash(repo, { base, message: 'Renamed' });
			expect(renamed).not.toBe(squashed);
			expect(run('log', '-1', '--format=%s')).toBe('Renamed');
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('pushes the branch with upstream tracking', () =>
		Effect.gen(function* () {
			const { git: run, write, repo, origin } = yield* tempRepo;
			const git = yield* Git;
			write('a.txt', 'a\n');
			const head = yield* git.commit(repo, 'One');
			yield* git.push(repo, 'feature');
			expect(run('rev-parse', '--abbrev-ref', 'feature@{upstream}')).toBe('origin/feature');
			expect(run('--git-dir', origin, 'rev-parse', 'feature')).toBe(head);
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('adds a path inside the repo to info/exclude once', () =>
		Effect.gen(function* () {
			const { work, dir, git: run, write, repo } = yield* tempRepo;
			const git = yield* Git;
			write('plans/feature [1]/spec.md', '# spec\n');
			write('notes.md', 'x\n');
			const excludeFile = join(work, '.git/info/exclude');

			expect(yield* git.excludePath(repo, join(work, 'plans/feature [1]'))).toBe(true);
			expect(yield* git.excludePath(repo, join(work, 'plans/feature [1]'))).toBe(false);
			expect(yield* git.excludePath(repo, join(work, 'notes.md'))).toBe(true);
			expect(yield* git.excludePath(repo, dir)).toBe(false);
			expect(yield* git.excludePath(repo, work)).toBe(false);

			const lines = readFileSync(excludeFile, 'utf8').trimEnd().split('\n');
			expect(lines.slice(-2)).toEqual(['/plans/feature \\[1\\]/', '/notes.md']);
			expect(run('status', '--porcelain')).toBe('');
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('opens a detached worktree and removes it when the scope closes', () =>
		Effect.gen(function* () {
			const { dir, git: run, write, repo } = yield* tempRepo;
			const git = yield* Git;
			const base = sha(run('rev-parse', 'HEAD'));
			write('later.txt', 'later\n');
			yield* git.commit(repo, 'Later');
			const path = join(dir, 'runs/run-1/baseline');

			// A leftover from an interrupted run is replaced.
			mkdirSync(path, { recursive: true });
			const opened = yield* Effect.scoped(
				Effect.gen(function* () {
					const worktree = yield* git.worktree(repo, { path, sha: base });
					expect(existsSync(join(worktree, 'README.md'))).toBe(true);
					expect(existsSync(join(worktree, 'later.txt'))).toBe(false);
					expect(yield* git.headSha({ ...repo, cwd: worktree })).toBe(base);
					return worktree;
				})
			);
			expect(opened).toBe(path);
			expect(existsSync(path)).toBe(false);
			expect(run('worktree', 'list', '--porcelain')).not.toContain(path);
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);

	it.effect('removes the worktree when interrupted', () =>
		Effect.gen(function* () {
			const { dir, git: run, repo } = yield* tempRepo;
			const git = yield* Git;
			const path = join(dir, 'baseline');
			const exit = yield* Effect.scoped(
				Effect.andThen(
					git.worktree(repo, { path, sha: sha(run('rev-parse', 'HEAD')) }),
					Effect.interrupt
				)
			).pipe(Effect.exit);
			expect(Exit.hasInterrupts(exit)).toBe(true);
			expect(existsSync(path)).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(GitLive))
	);
});

describe('git output parsing', () => {
	it('parses name-status output with renames', () => {
		expect(parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0D\0gone\0T\0link\0')).toEqual([
			{ path: 'a.ts', status: 'modified' },
			{ path: 'new.ts', status: 'renamed', oldPath: 'old.ts' },
			{ path: 'gone', status: 'deleted' },
			{ path: 'link', status: 'type-changed' }
		]);
		expect(parseNameStatus('')).toEqual([]);
	});

	it('unquotes C-style paths', () => {
		expect(unquoteGitPath('"b/caf\\303\\251 \\"x\\"\\ttab"')).toBe('b/café "x"\ttab');
		expect(unquoteGitPath('b/plain')).toBe('b/plain');
	});

	it('counts hunk lines so added lines that look like headers stay added lines', () => {
		const diff = [
			'diff --git a/x b/x',
			'--- a/x',
			'+++ b/x',
			'@@ -1,2 +1,3 @@',
			'-old one',
			'-old two',
			'++++ b/fake',
			'+@@ -1 +1 @@',
			'+new',
			'@@ -9 +10,0 @@',
			'-removed',
			'diff --git a/gone b/gone',
			'--- a/gone',
			'+++ /dev/null',
			'@@ -1 +0,0 @@',
			'-bye',
			'diff --git a/"q" b/"q"',
			'--- /dev/null',
			'+++ "b/sp\\303\\251cial"',
			'@@ -0,0 +1 @@',
			'+hi',
			'\\ No newline at end of file'
		].join('\n');
		expect(parseAddedLines(diff)).toEqual({
			x: ['+++ b/fake', '@@ -1 +1 @@', 'new'],
			spécial: ['hi']
		});
	});
});
