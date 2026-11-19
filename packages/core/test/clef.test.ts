import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Schema } from 'effect';
import {
	HttpClient,
	HttpClientError,
	HttpClientResponse,
	type HttpClientRequest
} from 'effect/http';
import { TestClock } from 'effect/testing';
import {
	Clef,
	CLEF_MODEL,
	CLEF_TIMEOUT,
	ReviewerTriggers,
	type ClefPickInput,
	type ReviewerDef
} from '../src/index.ts';

const reviewer = (name: string, description?: string): ReviewerDef => ({
	name,
	triggers: Schema.decodeUnknownSync(ReviewerTriggers)({}),
	brief: `# ${name}\n\nThe ${name} brief.\n\nMore detail.`,
	...(description === undefined ? {} : { description })
});

const input: ClefPickInput = {
	candidates: [reviewer('design', 'Module boundaries.'), reviewer('security'), reviewer('data')],
	changes: {
		files: [{ path: 'src/a.ts', status: 'modified' }],
		diff: 'diff --git a/src/a.ts b/src/a.ts\n+const a = 1;'
	},
	credentials: { accountId: 'acct-1', apiToken: 'secret-token' }
};

interface Sent {
	readonly url: string;
	readonly authorization: string | undefined;
	readonly body: unknown;
}

/** A Clef whose HTTP calls are recorded in `sent` and answered by `reply`. */
const clefAnswering = (
	sent: Array<Sent>,
	reply: (
		request: HttpClientRequest.HttpClientRequest
	) => Effect.Effect<Response, HttpClientError.HttpClientError>
) =>
	Clef.layerWithHttpClient.pipe(
		Layer.provide(
			Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request, url) =>
					Effect.gen(function* () {
						const body =
							request.body._tag === 'Uint8Array'
								? JSON.parse(new TextDecoder().decode(request.body.body))
								: null;
						sent.push({
							url: url.toString(),
							authorization: request.headers.authorization,
							body
						});
						return HttpClientResponse.fromWeb(request, yield* reply(request));
					})
				)
			)
		)
	);

const json = (status: number, body: unknown) =>
	Effect.succeed(
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		})
	);

const answers = (probabilities: Record<string, number>) => ({
	model: CLEF_MODEL,
	answers: Object.fromEntries(
		Object.entries(probabilities).map(([id, noul]) => [id, { type: 'noul', noul }])
	),
	usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 }
});

const pick = (layer: Layer.Layer<Clef>) =>
	Effect.gen(function* () {
		return yield* (yield* Clef).pick(input);
	}).pipe(Effect.provide(layer));

describe('Clef.pick', () => {
	it.effect('asks one question per candidate and keeps those at or above the threshold', () =>
		Effect.gen(function* () {
			const sent: Array<Sent> = [];
			const picks = yield* pick(
				clefAnswering(sent, () =>
					json(200, { result: answers({ design: 0.5, security: 0.49, data: 0.9 }) })
				)
			);
			expect(picks).toEqual([
				{ name: 'design', probability: 0.5 },
				{ name: 'data', probability: 0.9 }
			]);

			expect(sent).toHaveLength(1);
			const [request] = sent;
			expect(request?.url).toBe(
				'https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/cloudflare/clef-flash'
			);
			expect(request?.authorization).toBe('Bearer secret-token');
			const body = request?.body as {
				model: string;
				state: string;
				questions: Record<string, { type: string; instructions: string }>;
			};
			expect(body.model).toBe('clef-flash');
			expect(body.state).toContain('- modified src/a.ts');
			expect(body.state).toContain('+const a = 1;');
			expect(Object.keys(body.questions)).toEqual(['design', 'security', 'data']);
			expect(body.questions['design']?.type).toBe('noul');
			expect(body.questions['design']?.instructions).toContain('Module boundaries.');
			// Without a description, the brief's first paragraph that is not a heading.
			expect(body.questions['security']?.instructions).toContain('The security brief.');
			expect(body.questions['security']?.instructions).not.toContain('More detail.');
		})
	);

	it.effect('accepts the model output without the REST envelope', () =>
		Effect.gen(function* () {
			const picks = yield* pick(clefAnswering([], () => json(200, answers({ security: 1 }))));
			expect(picks).toEqual([{ name: 'security', probability: 1 }]);
		})
	);

	it.effect('makes no call without candidates', () =>
		Effect.gen(function* () {
			const sent: Array<Sent> = [];
			const picks = yield* Effect.gen(function* () {
				return yield* (yield* Clef).pick({ ...input, candidates: [] });
			}).pipe(Effect.provide(clefAnswering(sent, () => json(200, answers({})))));
			expect(picks).toEqual([]);
			expect(sent).toEqual([]);
		})
	);

	it.effect("fails with Cloudflare's error message on an error status", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				pick(
					clefAnswering([], () =>
						json(401, {
							success: false,
							errors: [{ code: 10000, message: 'Authentication error' }],
							result: null
						})
					)
				)
			);
			expect(error).toMatchObject({
				_tag: 'ClefError',
				status: 401,
				detail: 'Authentication error'
			});
			expect(error.message).toBe('Cloudflare Clef failed (HTTP 401): Authentication error');
		})
	);

	it.effect('fails on an unexpected response body', () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				pick(clefAnswering([], () => json(200, { result: { answers: { design: 2 } } })))
			);
			expect(error).toMatchObject({
				_tag: 'ClefError',
				status: 200,
				cause: { _tag: 'SchemaError' }
			});
			expect(error.detail).toMatch(/^unexpected response/u);
		})
	);

	it.effect('fails when Cloudflare cannot be reached', () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				pick(
					clefAnswering([], (request) =>
						Effect.fail(
							new HttpClientError.HttpClientError({
								reason: new HttpClientError.TransportError({
									request,
									description: 'connection refused'
								})
							})
						)
					)
				)
			);
			expect(error).toMatchObject({
				_tag: 'ClefError',
				status: null,
				cause: { _tag: 'HttpClientError', reason: { _tag: 'TransportError' } }
			});
			expect(error.detail).toContain('connection refused');
		})
	);

	it.effect('fails when Cloudflare does not answer in time', () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				Effect.flip(pick(clefAnswering([], () => Effect.never)))
			);
			yield* TestClock.adjust(CLEF_TIMEOUT);
			const error = yield* Fiber.join(fiber);
			expect(error).toMatchObject({ _tag: 'ClefError', status: null });
			expect(error.detail).toBe(`no answer after ${CLEF_TIMEOUT}`);
		})
	);
});

describe('Clef.verify', () => {
	it.effect('asks one question with the given credentials', () =>
		Effect.gen(function* () {
			const sent: Array<Sent> = [];
			yield* Effect.gen(function* () {
				yield* (yield* Clef).verify({ accountId: 'acct-2', apiToken: 'other-token' });
			}).pipe(
				Effect.provide(
					clefAnswering(sent, () => json(200, { result: answers({ check: 0.7 }) }))
				)
			);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.url).toContain('/accounts/acct-2/');
			expect(sent[0]?.authorization).toBe('Bearer other-token');
		})
	);
});
