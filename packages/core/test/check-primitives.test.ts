import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { baselinePrimitive, checksPrimitive, type ChecksInput } from '../src/index.ts';
import { AgentFake, ChecksFake, exitCodesByCheck, GitFake } from '../src/testing.ts';
import { resolvedConfig } from './fixtures.ts';
import { CheckpointValues, recordingKit, scopeWith, withPrimitives } from './primitive-harness.ts';

const checksInput = (checkFixAttempts = 3): ChecksInput => ({
	...scopeWith({ caps: { ...resolvedConfig.caps, checkFixAttempts } }),
	planDir: '/plans/feature',
	session: null,
	round: 0,
	commitMessage: 'Add a'
});

const dirty = { dirty: true, changedFiles: [{ path: 'src/a.ts', status: 'added' as const }] };

describe('baselinePrimitive', () => {
	it.effect('runs every check once on the base, without fixing failures', () =>
		withPrimitives(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1] }));
				const recorded = yield* recordingKit;

				const output = yield* baselinePrimitive.run(
					{ ...scopeWith(), planDir: '/plans/feature' },
					recorded.kit
				);

				expect(output.passed).toBe(false);
				expect(output.passes).toHaveLength(1);
				expect(output.passes[0]?.baseline).toBe(true);
				expect(yield* (yield* AgentFake).calls).toEqual([]);
				expect((yield* (yield* GitFake).state).excluded).toEqual(['/plans/feature']);
			})
		)
	);

	it.effect('refuses a dirty tree before running any check', () =>
		withPrimitives(
			Effect.gen(function* () {
				const recorded = yield* recordingKit;

				const error = yield* Effect.flip(
					baselinePrimitive.run(
						{ ...scopeWith(), planDir: '/plans/feature' },
						recorded.kit
					)
				);

				expect(error._tag).toBe('StepNotReady');
				expect(yield* (yield* ChecksFake).calls).toEqual([]);
			}),
			{ dirty: true }
		)
	);
});

describe('checksPrimitive', () => {
	it.effect('commits the work when the first pass passes', () =>
		withPrimitives(
			Effect.gen(function* () {
				const recorded = yield* recordingKit;

				const output = yield* checksPrimitive.run(checksInput(), recorded.kit);

				expect(output.passed).toBe(true);
				expect(output.passes).toHaveLength(1);
				const { commits } = yield* (yield* GitFake).state;
				expect(commits.map((commit) => commit.message)).toEqual(['Add a']);
				expect(yield* recorded.tags).toContain('CommitCreated');
			}),
			dirty
		)
	);

	it.effect('has the implementer fix a failing pass, then runs the checks again', () =>
		withPrimitives(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1] }));
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'fixChecks' }, { costUsd: 0.2 });
				const recorded = yield* recordingKit;

				const output = yield* checksPrimitive.run(checksInput(), recorded.kit);

				expect(output.passed).toBe(true);
				expect(output.passes.map((pass) => pass.attempt)).toEqual([0, 1]);
				const [fix] = yield* agent.calls;
				expect(fix?.prompt).toContain('## test (exit code 1)');
				expect(yield* recorded.costs).toEqual([0.2]);
				expect(yield* recorded.sessions).toContain('fake-session-1');
			}),
			dirty
		)
	);

	it.effect('stops without committing once the fixes reach the cap', () =>
		withPrimitives(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1, 1, 1] }));
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'fixChecks' }, { costUsd: 0.2 });
				const recorded = yield* recordingKit;

				const output = yield* checksPrimitive.run(checksInput(1), recorded.kit);

				expect(output.passed).toBe(false);
				expect(output.passes).toHaveLength(2);
				expect(yield* agent.calls).toHaveLength(1);
				expect((yield* (yield* GitFake).state).commits).toEqual([]);
			}),
			dirty
		)
	);

	it.effect('resumes after its finished passes and fixes without redoing them', () =>
		withPrimitives(
			Effect.gen(function* () {
				const values = yield* CheckpointValues;
				values.set('pass/0', {
					baseline: false,
					round: 0,
					attempt: 0,
					results: [{ name: 'test', exitCode: 1, durationMs: 5, outputTail: 'failed' }]
				});
				values.set('fix/0', { sessionId: 'restored', cumulativeCostUsd: 0.2 });
				const recorded = yield* recordingKit;

				const output = yield* checksPrimitive.run(checksInput(), recorded.kit);

				expect(output.passes.map((pass) => pass.attempt)).toEqual([0, 1]);
				expect(output.passed).toBe(true);
				expect(yield* (yield* AgentFake).calls).toEqual([]);
				expect(yield* recorded.sessions).toEqual(['restored']);
				const runs = (yield* (yield* ChecksFake).calls).filter(
					(command) => command.kind === 'run'
				);
				// Only pass 1 ran: lint and test once each.
				expect(runs).toHaveLength(2);
			}),
			dirty
		)
	);
});
