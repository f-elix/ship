import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { AgentSdkError, fixStep, implementStep, invokeStep, SessionId } from '../src/index.ts';
import { AgentFake, ChecksFake, GitFake } from '../src/testing.ts';
import { nit, verifiedFinding } from './fixtures.ts';
import { recordingKit, scopeWith, withSteps } from './step-harness.ts';

const implementInput = { ...scopeWith(), planDir: '/plans/feature', session: null };

/** An implementer call that edits `src/a.ts`, like a real agent would. */
const editing = (reply: { readonly output?: unknown; readonly costUsd: number }) =>
	Effect.gen(function* () {
		const git = yield* GitFake;
		return () => Effect.as(git.edit([{ path: 'src/a.ts', status: 'added' }]), reply);
	});

describe('implementStep', () => {
	it.effect('returns the commit subject, records cost and session, and formats', () =>
		withSteps(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				yield* agent.script(
					{ step: 'implement' },
					yield* editing({ output: { commitSubject: 'Add a' }, costUsd: 0.5 })
				);
				const recorded = yield* recordingKit;

				const subject = yield* implementStep.run(implementInput, recorded.kit);

				expect(subject).toBe('Add a');
				expect(yield* recorded.costs).toEqual([0.5]);
				expect(yield* recorded.sessions).toEqual(['fake-session-1']);
				const [call] = yield* agent.calls;
				expect(call?.prompt).toContain('/plans/feature/spec.md');
				expect(call?.resume).toBeUndefined();
				const commands = yield* (yield* ChecksFake).calls;
				expect(commands.map((command) => command.kind)).toEqual(['format']);
				// The work stays uncommitted for `checks`.
				expect((yield* (yield* GitFake).state).dirty).toBe(true);
			})
		)
	);

	it.effect('returns no subject for an invalid one, still billing the call', () =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* AgentFake).script(
					{ step: 'implement' },
					{ output: { commitSubject: '' }, costUsd: 0.4 }
				);
				const recorded = yield* recordingKit;

				const subject = yield* implementStep.run(implementInput, recorded.kit);

				expect(subject).toBeNull();
				expect(yield* recorded.costs).toEqual([0.4]);
				expect(yield* recorded.sessions).toEqual(['fake-session-1']);
			})
		)
	);

	it.effect('keeps the cost of an agent call that fails', () =>
		withSteps(
			Effect.gen(function* () {
				const sessionId = SessionId.make('failed-session');
				yield* (yield* AgentFake).script(
					{ step: 'implement' },
					new AgentSdkError({
						step: 'implement',
						reason: 'error_max_turns',
						detail: 'Out of turns',
						spend: {
							session: { sessionId, cumulativeCostUsd: 0.7 },
							cost: { step: 'implement', model: 'opus', sessionId, costUsd: 0.7 }
						}
					})
				);

				const outcome = yield* invokeStep(implementStep, implementInput);

				expect(outcome).toMatchObject({
					_tag: 'Failed',
					failure: { step: 'implement', timedOut: false },
					spent: { costUsd: 0.7, session: { sessionId } }
				});
			})
		)
	);
});

describe('fixStep', () => {
	it.effect('resumes the session with every finding, the nits included', () =>
		withSteps(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'fix' }, yield* editing({ costUsd: 0.3 }));
				const recorded = yield* recordingKit;
				const session = {
					sessionId: SessionId.make('implementer'),
					cumulativeCostUsd: 1
				};

				yield* fixStep.run(
					{
						...scopeWith(),
						planDir: null,
						session,
						mustFix: [verifiedFinding],
						nits: [nit]
					},
					recorded.kit
				);

				const [call] = yield* agent.calls;
				expect(call?.resume).toEqual(session);
				expect(call?.prompt).toContain(`# Must-fix\n\n## ${verifiedFinding.id}`);
				expect(call?.prompt).toContain(`# Nits\n\n## ${nit.id}`);
				expect(yield* recorded.costs).toEqual([0.3]);
				expect(yield* recorded.sessions).toEqual(['implementer']);
			})
		)
	);
});
