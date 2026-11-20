import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { readdirSync, readFileSync } from 'node:fs';
import {
	agentErrorCost,
	AgentOutputMismatch,
	AgentSdkError,
	AgentTimeout,
	callCost,
	makeAgent,
	outputJsonSchema,
	sdkOptions,
	SessionId,
	type AgentRunInput,
	type QueryFn
} from '../src/index.ts';
import { tempDir } from './temp-repo.ts';

/**
 * A result message with the fields the wrapper reads. The SDK's type has many more
 * required fields (usage, timings) that the wrapper never looks at.
 */
const result = (fields: Record<string, unknown>): SDKMessage =>
	({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'done',
		num_turns: 3,
		total_cost_usd: 0.5,
		session_id: 'session-1',
		stop_reason: 'end_turn',
		errors: [],
		...fields
	}) as unknown as SDKMessage;

const assistant = { type: 'assistant', message: { content: 'thinking' } } as unknown as SDKMessage;

interface Recorded {
	readonly prompt: string;
	readonly options: Parameters<QueryFn>[0]['options'];
}

/** A query function that yields `messages` and records what it was called with. */
const scripted =
	(messages: ReadonlyArray<SDKMessage>, calls: Array<Recorded> = []): QueryFn =>
	(params) => {
		calls.push({ prompt: params.prompt, options: params.options });
		return (async function* () {
			yield* messages;
		})();
	};

const agentWith = (runQuery: QueryFn) =>
	makeAgent(runQuery).pipe(Effect.provide(NodeServices.layer));

const input: AgentRunInput = {
	step: 'review',
	label: 'security',
	prompt: 'Review this',
	model: 'sonnet',
	access: 'read-only',
	cwd: '/repo',
	env: { PATH: '/bin', HOME: '/home/me' },
	timeoutMs: 60_000
};

/**
 * Runs `effect` to its end past every retry wait. Tries do real file I/O, so the test clock
 * moves a second at a time, well inside the call's timeout, until the call ends.
 */
const settle = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(effect);
		while (fiber.pollUnsafe() === undefined) {
			yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)));
			yield* TestClock.adjust('1 second');
		}
		return yield* Fiber.join(fiber);
	});

const Output = Schema.Struct({ findings: Schema.Array(Schema.String) });

describe('Agent', () => {
	it.effect('decodes structured output, reports cost and turns, and writes a transcript', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const calls: Array<Recorded> = [];
			const agent = yield* agentWith(
				scripted([assistant, result({ structured_output: { findings: ['a'] } })], calls)
			);
			const first = yield* agent.runStructured({ ...input, transcript: { dir } }, Output);
			expect(first.output).toEqual({ findings: ['a'] });
			expect(first.session).toEqual({ sessionId: 'session-1', cumulativeCostUsd: 0.5 });
			expect(first.cost).toEqual({
				step: 'review',
				model: 'sonnet',
				sessionId: 'session-1',
				costUsd: 0.5
			});
			expect(first.turns).toBe(3);
			expect(first.text).toBe('done');
			expect(first.transcriptPath).toBe(`${dir}/review-security-1.jsonl`);
			const lines = readFileSync(`${dir}/review-security-1.jsonl`, 'utf8').trim().split('\n');
			expect(lines.map((line) => JSON.parse(line).type)).toEqual(['assistant', 'result']);

			// A re-run never overwrites an earlier transcript.
			const second = yield* agent.runStructured({ ...input, transcript: { dir } }, Output);
			expect(second.transcriptPath).toBe(`${dir}/review-security-2.jsonl`);
			expect(readdirSync(dir).toSorted()).toEqual([
				'review-security-1.jsonl',
				'review-security-2.jsonl'
			]);

			const options = calls[0]?.options;
			expect(options?.outputFormat).toEqual({
				type: 'json_schema',
				schema: outputJsonSchema(Output)
			});
			expect(options?.settingSources).toEqual([]);
			expect(options?.env).toEqual(input.env);
			expect(calls[0]?.prompt).toBe('Review this');
		}).pipe(Effect.scoped)
	);

	it.effect('reports only the resumed call’s cost and resumes by session id', () =>
		Effect.gen(function* () {
			const calls: Array<Recorded> = [];
			const agent = yield* agentWith(scripted([result({ total_cost_usd: 1.25 })], calls));
			const resumed = yield* agent.run({
				...input,
				step: 'fix',
				access: 'edit',
				resume: { sessionId: SessionId.make('session-1'), cumulativeCostUsd: 1 }
			});
			expect(resumed.output).toBeNull();
			expect(resumed.cost.costUsd).toBe(0.25);
			expect(resumed.session.cumulativeCostUsd).toBe(1.25);
			expect(calls[0]?.options.resume).toBe('session-1');
			expect(calls[0]?.options.outputFormat).toBeUndefined();
		})
	);

	it('computes per-call cost from the running total', () => {
		const session = { sessionId: SessionId.make('s'), cumulativeCostUsd: 2 };
		expect(callCost(3, undefined)).toBe(3);
		expect(callCost(3, session)).toBe(1);
		// The transcript saved no total, so the count restarted from zero.
		expect(callCost(0.5, session)).toBe(0.5);
	});

	it.effect('fails with AgentSdkError on an error result, without trying again', () =>
		Effect.gen(function* () {
			const calls: Array<Recorded> = [];
			const errored = yield* agentWith(
				scripted(
					[
						result({
							subtype: 'error_max_turns',
							is_error: true,
							errors: ['too many turns']
						})
					],
					calls
				)
			);
			const maxTurns = yield* Effect.flip(errored.run(input));
			expect(maxTurns).toBeInstanceOf(AgentSdkError);
			expect(maxTurns).toMatchObject({
				reason: 'error_max_turns',
				detail: expect.stringContaining('too many turns')
			});
			expect(calls).toHaveLength(1);
			// An error result is still billed, so its cost survives the failure.
			expect(agentErrorCost(maxTurns)).toEqual({
				step: 'review',
				model: 'sonnet',
				sessionId: 'session-1',
				costUsd: 0.5
			});
		})
	);

	it.effect('tries a throw or a missing result twice more, then fails with AgentSdkError', () =>
		Effect.gen(function* () {
			let throws = 0;
			const throwing = yield* agentWith(() => {
				throws += 1;
				throw new Error('overloaded');
			});
			const thrown = yield* settle(Effect.flip(throwing.run(input)));
			expect(thrown).toMatchObject({
				_tag: 'AgentSdkError',
				reason: 'exception',
				detail: 'overloaded'
			});
			expect(agentErrorCost(thrown)).toBeNull();
			expect(throws).toBe(3);

			const calls: Array<Recorded> = [];
			const silent = yield* agentWith(scripted([assistant], calls));
			expect(yield* settle(Effect.flip(silent.run(input)))).toMatchObject({
				reason: 'no-result'
			});
			expect(calls).toHaveLength(3);
		})
	);

	it.effect('succeeds when a try after a transient failure does', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			let tries = 0;
			const agent = yield* agentWith((params) => {
				tries += 1;
				if (tries === 1) throw new Error('safeguards flagged this message');
				return scripted([result({})])(params);
			});
			const answer = yield* settle(agent.run({ ...input, transcript: { dir } }));
			expect(answer).toMatchObject({
				text: 'done',
				transcriptPath: `${dir}/review-security-2.jsonl`
			});
			expect(tries).toBe(2);
		})
	);

	it.effect('fails with AgentOutputMismatch when the output does not match the schema', () =>
		Effect.gen(function* () {
			const agent = yield* agentWith(
				scripted([result({ structured_output: { findings: [1] } })])
			);
			const error = yield* Effect.flip(agent.runStructured(input, Output));
			expect(error).toBeInstanceOf(AgentOutputMismatch);
			expect(error).toMatchObject({
				step: 'review',
				output: '{"findings":[1]}',
				spend: {
					session: { sessionId: 'session-1', cumulativeCostUsd: 0.5 },
					cost: { step: 'review', model: 'sonnet', costUsd: 0.5 }
				}
			});
		})
	);

	it.effect('fails with AgentOutputMismatch when the SDK gives up on structured output', () =>
		Effect.gen(function* () {
			const agent = yield* agentWith(
				scripted([
					result({
						subtype: 'error_max_structured_output_retries',
						is_error: true,
						errors: ['output did not match the schema']
					})
				])
			);
			const error = yield* Effect.flip(agent.runStructured(input, Output));
			expect(error).toBeInstanceOf(AgentOutputMismatch);
			expect(error).toMatchObject({
				step: 'review',
				detail: expect.stringContaining('did not match'),
				spend: { cost: { costUsd: 0.5 } }
			});
		})
	);

	it.effect('times out, aborting the agent', () =>
		Effect.gen(function* () {
			const calls: Array<Recorded> = [];
			const agent = yield* agentWith((params) => {
				calls.push({ prompt: params.prompt, options: params.options });
				return (async function* (): AsyncGenerator<SDKMessage> {
					yield assistant;
					await new Promise(() => {});
				})();
			});
			const fiber = yield* agent
				.run({ ...input, timeoutMs: 1000 })
				.pipe(Effect.flip, Effect.forkChild);
			yield* TestClock.adjust(1000);
			const error = yield* Fiber.join(fiber);
			expect(error).toBeInstanceOf(AgentTimeout);
			expect(error).toMatchObject({ timeoutMs: 1000 });
			expect(calls[0]?.options.abortController?.signal.aborted).toBe(true);
		})
	);
});

describe('sdkOptions', () => {
	const controller = new AbortController();

	it('lets the implementer edit and run commands unattended', () => {
		const options = sdkOptions({ ...input, access: 'edit' }, controller);
		expect(options.permissionMode).toBe('bypassPermissions');
		expect(options.allowDangerouslySkipPermissions).toBe(true);
		expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
	});

	it('restricts reviewers to reading and searching', () => {
		const options = sdkOptions(
			{ ...input, additionalDirectories: ['/plans/feature'] },
			controller
		);
		expect(options.permissionMode).toBe('dontAsk');
		expect(options.tools).toEqual(['Read', 'Grep', 'Glob']);
		expect(options.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
		expect(options.additionalDirectories).toEqual(['/plans/feature']);
	});

	it('gives tool-less calls no tools', () => {
		const options = sdkOptions({ ...input, access: 'none' }, controller);
		expect(options.tools).toEqual([]);
		expect(options.permissionMode).toBe('dontAsk');
	});
});
