import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { Agent, Checks, Git, Locks, type AgentRunInput, type GitRepo } from '../src/index.ts';
import { AgentFake, ChecksFake, exitCodesByCheck, fakeSha, GitFake } from '../src/testing.ts';

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

	it.effect('fails a method on demand', () =>
		Effect.gen(function* () {
			const git = yield* Git;
			const fake = yield* GitFake;
			yield* fake.fail('push', 'rejected');
			expect((yield* Effect.flip(git.push(repo, 'feature'))).stderr).toBe('rejected');
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

describe('AgentFake', () => {
	const call: AgentRunInput = {
		step: 'review',
		label: 'security',
		prompt: 'Review',
		model: 'sonnet',
		access: 'read-only',
		cwd: '/repo',
		env: {},
		timeoutMs: 1000
	};
	const Output = Schema.Struct({ ok: Schema.Boolean });

	it.effect('answers from label scripts before step scripts, in order', () =>
		Effect.gen(function* () {
			const agent = yield* Agent;
			const fake = yield* AgentFake;
			yield* fake.script({ step: 'review' }, { text: 'step' });
			yield* fake.script(
				{ step: 'review', label: 'security' },
				{ text: 'label 1' },
				{ text: 'label 2' }
			);
			const texts = [];
			for (let i = 0; i < 3; i += 1) texts.push((yield* agent.run(call)).text);
			expect(texts).toEqual(['label 1', 'label 2', 'step']);
			expect(yield* Effect.flip(agent.run(call))).toMatchObject({ reason: 'unscripted' });
			expect(yield* fake.calls).toHaveLength(4);
		}).pipe(Effect.provide(AgentFake.layer))
	);

	it.effect('decodes structured output and keeps a resumed session’s running total', () =>
		Effect.gen(function* () {
			const agent = yield* Agent;
			const fake = yield* AgentFake;
			yield* fake.script({ step: 'implement' }, { costUsd: 1 });
			yield* fake.script(
				{ step: 'fix' },
				{ output: { ok: true }, costUsd: 0.5 },
				{ output: { ok: 'yes' } }
			);
			const first = yield* agent.run({ ...call, step: 'implement' });
			const fixed = yield* agent.runStructured(
				{ ...call, step: 'fix', resume: first.session },
				Output
			);
			expect(fixed.output).toEqual({ ok: true });
			expect(fixed.session).toEqual({
				sessionId: first.session.sessionId,
				cumulativeCostUsd: 1.5
			});
			expect(fixed.cost.costUsd).toBe(0.5);
			expect(
				yield* Effect.flip(agent.runStructured({ ...call, step: 'fix' }, Output))
			).toMatchObject({
				_tag: 'AgentOutputMismatch'
			});
		}).pipe(Effect.provide(AgentFake.layer))
	);

	it.effect('times out a script that never finishes', () =>
		Effect.gen(function* () {
			yield* (yield* AgentFake).script({ step: 'review' }, () => Effect.never);
			const fiber = yield* (yield* Agent).run(call).pipe(Effect.flip, Effect.forkChild);
			yield* TestClock.adjust(1000);
			expect(yield* Fiber.join(fiber)).toMatchObject({
				_tag: 'AgentTimeout',
				timeoutMs: 1000
			});
		}).pipe(Effect.provide(AgentFake.layer))
	);
});
