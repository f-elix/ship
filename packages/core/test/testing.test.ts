import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { Checks, Git, Locks, type GitRepo } from '../src/index.ts';
import { ChecksFake, exitCodesByCheck, fakeSha, GitFake } from '../src/testing.ts';

const repo: GitRepo = { cwd: '/repo', env: {} };

describe('GitFake', () => {
	it.effect('commits only after an edit and squashes idempotently', () =>
		Effect.gen(function* () {
			const git = yield* Git;
			const fake = yield* GitFake;
			const base = yield* git.baseSha(repo);
			expect(yield* git.commit(repo, 'Nothing')).toBeNull();

			yield* fake.edit([{ path: 'a.ts', status: 'added' }]);
			expect(yield* git.isClean(repo)).toBe(false);
			expect(yield* git.commit(repo, 'One')).toBe(fakeSha(1));
			yield* fake.edit([
				{ path: 'a.ts', status: 'added' },
				{ path: 'b.ts', status: 'added' }
			]);
			yield* git.commit(repo, 'Two');
			expect(yield* git.changedFiles(repo, { from: base })).toHaveLength(2);

			const squashed = yield* git.squash(repo, { base, message: 'Feature' });
			expect(yield* git.squash(repo, { base, message: 'Feature' })).toBe(squashed);
			expect((yield* fake.state).commits.map((commit) => commit.message)).toEqual([
				'Feature'
			]);

			yield* git.push(repo, 'feature');
			expect((yield* fake.state).pushes).toEqual(['feature']);
			expect(yield* git.projectKey(repo)).toBe('github.com/f-elix/example');
		}).pipe(Effect.provide(GitFake.layer()))
	);

	it.effect('fails a method on demand and tracks open worktrees', () =>
		Effect.gen(function* () {
			const git = yield* Git;
			const fake = yield* GitFake;
			yield* fake.fail('push', 'rejected');
			expect((yield* Effect.flip(git.push(repo, 'feature'))).stderr).toBe('rejected');

			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* git.worktree(repo, { path: '/tmp/baseline', sha: fakeSha(9) });
					expect((yield* fake.state).worktrees).toEqual(['/tmp/baseline']);
				})
			);
			expect((yield* fake.state).worktrees).toEqual([]);
		}).pipe(Effect.provide(GitFake.layer({ branch: 'topic' })))
	);
});

describe('ChecksFake', () => {
	it.effect('runs the real checks flow over scripted exit codes', () =>
		Effect.gen(function* () {
			const checks = yield* Checks;
			const fake = yield* ChecksFake;
			yield* fake.respond(yield* exitCodesByCheck({ test: [1, 0] }));
			const input = {
				cwd: '/repo',
				env: {},
				files: ['a.ts'],
				pass: { baseline: false, round: 0, attempt: 0 },
				checks: [
					{ name: 'lint', run: 'lint {files}', fix: 'lint --fix {files}', lock: 'cpu' },
					{ name: 'test', run: 'test', lock: 'cpu' }
				]
			};
			const first = yield* checks.run(input);
			expect(
				first.results.map((result) => [result.name, result.exitCode, result.outputTail])
			).toEqual([
				['lint', 0, undefined],
				['test', 1, 'test failed']
			]);
			expect((yield* checks.run(input)).results[1]?.exitCode).toBe(0);
			expect(
				(yield* fake.calls).map((call) => `${call.kind}:${call.commandLine}`).slice(0, 3)
			).toEqual(["fix:lint --fix 'a.ts'", "run:lint 'a.ts'", 'run:test']);
		}).pipe(Effect.provide(ChecksFake.layer.pipe(Layer.provide(Locks.layer({ cpu: 1 })))))
	);
});
