import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import {
	baselineStep,
	ChecksOutput,
	checksStep,
	ClefError,
	type ChecksInput
} from '../src/index.ts';
import { AgentFake, ChecksFake, ClefFake, exitCodesByCheck, GitFake } from '../src/testing.ts';
import { resolvedConfig } from './fixtures.ts';
import { CheckpointValues, recordingKit, scopeWith, withSteps } from './step-harness.ts';

const checksInput = (
	checkFixAttempts = 3,
	preexisting: ReadonlyArray<string> = []
): ChecksInput => ({
	...scopeWith({ caps: { ...resolvedConfig.caps, checkFixAttempts } }),
	planDir: '/plans/feature',
	session: null,
	round: 0,
	commitMessage: 'Add a',
	preexisting
});

const dirty = { dirty: true, changedFiles: [{ path: 'src/a.ts', status: 'added' as const }] };

describe('baselineStep', () => {
	it.effect('runs every check once on the base, without fixing failures', () =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1] }));
				const recorded = yield* recordingKit;

				const output = yield* baselineStep.run(
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
		withSteps(
			Effect.gen(function* () {
				const recorded = yield* recordingKit;

				const error = yield* Effect.flip(
					baselineStep.run({ ...scopeWith(), planDir: '/plans/feature' }, recorded.kit)
				);

				expect(error._tag).toBe('StepNotReady');
				expect(yield* (yield* ChecksFake).calls).toEqual([]);
			}),
			{ dirty: true }
		)
	);
});

describe('checksStep', () => {
	it.effect('commits the work when the first pass passes', () =>
		withSteps(
			Effect.gen(function* () {
				const recorded = yield* recordingKit;

				const output = yield* checksStep.run(checksInput(), recorded.kit);

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
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1] }));
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'fixChecks' }, { costUsd: 0.2 });
				const recorded = yield* recordingKit;

				const output = yield* checksStep.run(checksInput(), recorded.kit);

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

	it.effect('neither fails on nor fixes a check that failed before the change', () =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(
					yield* exitCodesByCheck({ lint: [1, 0], test: [1, 1] })
				);
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'fixChecks' }, { costUsd: 0.2 });
				const recorded = yield* recordingKit;

				const output = yield* checksStep.run(checksInput(3, ['test']), recorded.kit);

				expect(output.passed).toBe(true);
				expect(output.passes).toHaveLength(2);
				const [fix] = yield* agent.calls;
				expect(fix?.prompt).toContain('## lint (exit code 1)');
				expect(fix?.prompt).not.toContain('## test');
				const { commits } = yield* (yield* GitFake).state;
				expect(commits.map((commit) => commit.message)).toEqual(['Add a']);
			}),
			dirty
		)
	);

	it.effect('stops without committing once the fixes reach the cap', () =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1, 1, 1] }));
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'fixChecks' }, { costUsd: 0.2 });
				const recorded = yield* recordingKit;

				const output = yield* checksStep.run(checksInput(1), recorded.kit);

				expect(output.passed).toBe(false);
				expect(output.passes).toHaveLength(2);
				expect(yield* agent.calls).toHaveLength(1);
				expect((yield* (yield* GitFake).state).commits).toEqual([]);
			}),
			dirty
		)
	);

	it.effect('resumes after its finished passes and fixes without redoing them', () =>
		withSteps(
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

				const output = yield* checksStep.run(checksInput(), recorded.kit);

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

	/** Clef rates the failure of the `index`th failing check unrelated with probability `p`. */
	const unrelated = (index: number, p: number) =>
		Effect.gen(function* () {
			yield* (yield* ClefFake).answer(`check.${index}`, {
				pick: p >= 0.5 ? 'unrelated' : 'change',
				probabilities: { change: 1 - p, unrelated: p }
			});
		});

	const changed = { ...dirty, diff: '+const a = 1;' };

	it.effect('re-runs with no fix when Clef rates every failure unrelated, then commits', () =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1, 0] }));
				yield* unrelated(0, 0.7);
				const recorded = yield* recordingKit;

				const output = yield* checksStep.run(checksInput(), recorded.kit);

				expect(output).toMatchObject({ passed: true, unrelated: false });
				expect(output.passes.map((pass) => pass.attempt)).toEqual([0, 1]);
				expect(yield* (yield* AgentFake).calls).toEqual([]);
				const { commits } = yield* (yield* GitFake).state;
				expect(commits.map((commit) => commit.message)).toEqual(['Add a']);
				const [ask] = yield* (yield* ClefFake).asks;
				expect(Object.keys(ask?.questions ?? {})).toEqual(['check.0']);
				expect(ask?.state).toContain(
					'Check 0: test\nCommand: vitest run\nExit code: 1\nOutput (tail):\ntest failed'
				);
				expect(ask?.state).toContain('- added src/a.ts');
				expect(ask?.state).toContain('+const a = 1;');
			}),
			changed
		)
	);

	it.effect('ends unrelated, without a fix, when the re-run fails too', () =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1, 1, 0] }));
				yield* unrelated(0, 0.9);
				const recorded = yield* recordingKit;

				const output = yield* checksStep.run(checksInput(), recorded.kit);

				expect(output).toMatchObject({ passed: false, unrelated: true });
				expect(output.passes).toHaveLength(2);
				expect(yield* (yield* AgentFake).calls).toEqual([]);
				expect((yield* (yield* GitFake).state).commits).toEqual([]);
			}),
			changed
		)
	);

	it.effect('fixes as before unless Clef rates every failure unrelated', () =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(
					yield* exitCodesByCheck({ lint: [1, 0], test: [1, 0] })
				);
				yield* unrelated(0, 0.9);
				yield* unrelated(1, 0.69);
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'fixChecks' }, { costUsd: 0.2 });
				const recorded = yield* recordingKit;

				const output = yield* checksStep.run(checksInput(), recorded.kit);

				expect(output).toMatchObject({ passed: true, unrelated: false });
				expect(output.passes.map((pass) => pass.attempt)).toEqual([0, 1]);
				expect(yield* agent.calls).toHaveLength(1);
			}),
			changed
		)
	);

	it.effect('fixes as before without a Clef answer', () =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1, 0] }));
				yield* unrelated(0, 1);
				yield* (yield* ClefFake).fail(new ClefError({ status: null, detail: 'no answer' }));
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'fixChecks' }, { costUsd: 0.2 });
				const recorded = yield* recordingKit;

				const output = yield* checksStep.run(checksInput(), recorded.kit);

				expect(output.passed).toBe(true);
				expect(yield* agent.calls).toHaveLength(1);
			}),
			changed
		)
	);

	it.effect('fixes as before, without asking Clef, when the change cannot be read', () =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1, 0] }));
				yield* (yield* GitFake).fail('diff', 'fatal: bad object');
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'fixChecks' }, { costUsd: 0.2 });
				const recorded = yield* recordingKit;

				const output = yield* checksStep.run(checksInput(), recorded.kit);

				expect(output).toMatchObject({ passed: true, unrelated: false });
				expect(yield* agent.calls).toHaveLength(1);
				expect(yield* (yield* ClefFake).asks).toEqual([]);
				expect((yield* CheckpointValues).get('cause/0')).toBe(false);
			}),
			changed
		)
	);

	it.effect('asks Clef nothing when no fix is allowed', () =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1] }));
				const recorded = yield* recordingKit;

				const output = yield* checksStep.run(checksInput(0), recorded.kit);

				expect(output).toMatchObject({ passed: false, unrelated: false });
				expect(yield* (yield* ClefFake).asks).toEqual([]);
			}),
			changed
		)
	);

	it.effect("keeps Clef's checkpointed rating on resume", () =>
		withSteps(
			Effect.gen(function* () {
				const values = yield* CheckpointValues;
				values.set('pass/0', {
					baseline: false,
					round: 0,
					attempt: 0,
					results: [{ name: 'test', exitCode: 1, durationMs: 5, outputTail: 'failed' }]
				});
				values.set('cause/0', true);
				const recorded = yield* recordingKit;

				const output = yield* checksStep.run(checksInput(), recorded.kit);

				expect(output.passed).toBe(true);
				expect(output.passes.map((pass) => pass.attempt)).toEqual([0, 1]);
				expect(yield* (yield* AgentFake).calls).toEqual([]);
				expect(yield* (yield* ClefFake).asks).toEqual([]);
			}),
			changed
		)
	);
});

describe('ChecksOutput', () => {
	it('decodes an output stored before Clef rated failures as not unrelated', () => {
		expect(Schema.decodeUnknownSync(ChecksOutput)({ passes: [], passed: false })).toEqual({
			passes: [],
			passed: false,
			unrelated: false
		});
	});
});
