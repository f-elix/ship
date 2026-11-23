import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import {
	HttpClient,
	HttpClientError,
	HttpClientResponse,
	type HttpClientRequest
} from 'effect/http';
import { TestClock } from 'effect/testing';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
	Clef,
	CLEF_MAX_QUESTIONS,
	CLEF_MODEL,
	CLEF_TIMEOUT,
	credentialsPath,
	ShipHome,
	type ClefQuestions,
	type ClefRequest
} from '../src/index.ts';
import { tempDir } from './temp-repo.ts';

interface Sent {
	readonly url: string;
	readonly authorization: string | undefined;
	readonly body: {
		readonly model: string;
		readonly state: string;
		readonly questions: Record<string, unknown>;
	};
}

type Reply = (
	request: HttpClientRequest.HttpClientRequest,
	body: Sent['body']
) => Effect.Effect<Response, HttpClientError.HttpClientError>;

/** A Clef whose HTTP calls are recorded in `sent` and answered by `reply`. */
const clefAnswering = (sent: Array<Sent>, reply: Reply) =>
	Clef.layerWithHttpClient.pipe(
		Layer.provide(
			Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request, url) =>
					Effect.gen(function* () {
						const body =
							request.body._tag === 'Uint8Array'
								? (JSON.parse(
										new TextDecoder().decode(request.body.body)
									) as Sent['body'])
								: { model: '', state: '', questions: {} };
						sent.push({
							url: url.toString(),
							authorization: request.headers.authorization,
							body
						});
						return HttpClientResponse.fromWeb(request, yield* reply(request, body));
					})
				)
			)
		),
		Layer.provide(NodeServices.layer)
	);

const json = (status: number, body: unknown) =>
	Effect.succeed(
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		})
	);

/** The model's output, as Cloudflare documents it, for the given answers by question id. */
const output = (answers: Record<string, unknown>) => ({
	model: CLEF_MODEL,
	answers,
	usage: { input_tokens: 10, output_tokens: 0 }
});

/** The REST envelope Cloudflare wraps the model's output in. */
const envelope = (answers: Record<string, unknown>) => ({
	result: output(answers),
	success: true,
	errors: [],
	messages: []
});

const noul = (p: number) => ({ type: 'noul', noul: p });

/** A ship home in a temp dir, with `credentials` saved unless it is `null`. */
const homeWith = (credentials: unknown) =>
	Effect.gen(function* () {
		const home = yield* tempDir;
		mkdirSync(home, { recursive: true });
		if (credentials !== null) {
			writeFileSync(credentialsPath(home), JSON.stringify(credentials));
		}
		return home;
	});

const saved = { cloudflare: { accountId: 'acct-1', apiToken: 'secret-token' } };
const on = { config: { clef: true } };

/** Asks `request` with Clef `on` unless `scope` says otherwise, in a home holding `credentials`. */
const ask = <const Qs extends ClefQuestions>(
	layer: ReturnType<typeof clefAnswering>,
	request: ClefRequest<Qs>,
	options: { readonly credentials?: unknown; readonly scope?: typeof on } = {}
) =>
	Effect.gen(function* () {
		const home = yield* homeWith(options.credentials ?? saved);
		return yield* (yield* Clef)
			.ask(options.scope ?? on, request)
			.pipe(Effect.provide(ShipHome.layer(home)));
	}).pipe(Effect.provide(layer), Effect.scoped);

const yesNo = {
	decision: 'Testing',
	state: 'Changed files:\n- modified src/a.ts',
	questions: { relevant: { type: 'noul', instructions: 'Is it relevant?' } }
} as const;

describe('Clef.ask', () => {
	it.effect('sends each question type and decodes each answer type', () =>
		Effect.gen(function* () {
			const sent: Array<Sent> = [];
			const answers = yield* ask(
				clefAnswering(sent, () =>
					json(
						200,
						envelope({
							relevant: noul(0.82),
							kind: {
								type: 'choice',
								choice: 'nit',
								probabilities: { 'must-fix': 0.2, nit: 0.7, none: 0.1 },
								confidence: 0.5
							},
							risk: {
								type: 'score',
								score: 1.6,
								legend: { '0': 'trivial', '1': 'routine', '2': 'risky' },
								probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
								confidence: 0.6
							}
						})
					)
				),
				{
					decision: 'Testing',
					state: 'the state',
					questions: {
						relevant: { type: 'noul', instructions: 'Is it relevant?' },
						kind: {
							type: 'choice',
							instructions: 'What kind?',
							criteria: { 'must-fix': 'a defect', nit: 'style', none: 'chat' }
						},
						risk: {
							type: 'score',
							instructions: 'How risky?',
							criteria: ['trivial', 'routine', 'risky']
						}
					}
				}
			);
			expect(answers).toEqual({
				relevant: { p: 0.82 },
				kind: { pick: 'nit', probabilities: { 'must-fix': 0.2, nit: 0.7, none: 0.1 } },
				risk: { score: 1.6 }
			});

			expect(sent).toHaveLength(1);
			const [request] = sent;
			expect(request?.url).toBe(
				'https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/cloudflare/clef-flash'
			);
			expect(request?.authorization).toBe('Bearer secret-token');
			expect(request?.body).toEqual({
				model: 'clef-flash',
				state: 'the state',
				questions: {
					relevant: { type: 'noul', instructions: 'Is it relevant?' },
					kind: {
						type: 'choice',
						instructions: 'What kind?',
						criteria: { 'must-fix': 'a defect', nit: 'style', none: 'chat' }
					},
					risk: {
						type: 'score',
						instructions: 'How risky?',
						criteria: ['trivial', 'routine', 'risky']
					}
				}
			});
		})
	);

	it.effect('accepts the model output without the REST envelope', () =>
		Effect.gen(function* () {
			const answers = yield* ask(
				clefAnswering([], () => json(200, output({ relevant: noul(1) }))),
				yesNo
			);
			expect(answers).toEqual({ relevant: { p: 1 } });
		})
	);

	it.effect(
		`splits more than ${CLEF_MAX_QUESTIONS} questions into calls and merges the answers`,
		() =>
			Effect.gen(function* () {
				const sent: Array<Sent> = [];
				const ids = Array.from(
					{ length: CLEF_MAX_QUESTIONS + 1 },
					(_, index) => `q${index}`
				);
				const answers = yield* ask(
					clefAnswering(sent, (_request, body) =>
						json(
							200,
							envelope(
								Object.fromEntries(
									Object.keys(body.questions).map((id) => [id, noul(0.5)])
								)
							)
						)
					),
					{
						decision: 'Testing',
						state: 'the state',
						questions: Object.fromEntries(
							ids.map((id) => [id, { type: 'noul', instructions: id } as const])
						)
					}
				);
				expect(sent.map((request) => Object.keys(request.body.questions).length)).toEqual([
					CLEF_MAX_QUESTIONS,
					1
				]);
				expect(Object.keys(answers ?? {})).toEqual(ids);
			})
	);

	it.effect('makes no call without questions', () =>
		Effect.gen(function* () {
			const sent: Array<Sent> = [];
			const answers = yield* ask(
				clefAnswering(sent, () => json(200, envelope({}))),
				{ decision: 'Testing', state: '', questions: {} }
			);
			expect(answers).toEqual({});
			expect(sent).toEqual([]);
		})
	);

	it.effect('answers nothing and makes no call when the project turned Clef off', () =>
		Effect.gen(function* () {
			const sent: Array<Sent> = [];
			const answers = yield* ask(
				clefAnswering(sent, () => json(200, envelope({ relevant: noul(1) }))),
				yesNo,
				{ scope: { config: { clef: false } } }
			);
			expect(answers).toBeNull();
			expect(sent).toEqual([]);
		})
	);

	it.effect('answers nothing and makes no call without saved credentials', () =>
		Effect.gen(function* () {
			const sent: Array<Sent> = [];
			const reply = () => json(200, envelope({ relevant: noul(1) }));
			expect(yield* ask(clefAnswering(sent, reply), yesNo, { credentials: {} })).toBeNull();
			// A credentials file that does not decode counts as none too.
			expect(
				yield* ask(clefAnswering(sent, reply), yesNo, {
					credentials: { cloudflare: { accountId: '' } }
				})
			).toBeNull();
			expect(sent).toEqual([]);
		})
	);

	it.effect('answers nothing on an error status', () =>
		Effect.gen(function* () {
			const answers = yield* ask(
				clefAnswering([], () =>
					json(401, {
						success: false,
						errors: [{ code: 10000, message: 'Authentication error' }]
					})
				),
				yesNo
			);
			expect(answers).toBeNull();
		})
	);

	it.effect('answers nothing when an answer is missing or of another type or option', () =>
		Effect.gen(function* () {
			const missing = yield* ask(
				clefAnswering([], () => json(200, envelope({}))),
				yesNo
			);
			expect(missing).toBeNull();
			const otherType = yield* ask(
				clefAnswering([], () =>
					json(200, envelope({ relevant: { type: 'score', score: 1 } }))
				),
				yesNo
			);
			expect(otherType).toBeNull();
			const unknownOption = yield* ask(
				clefAnswering([], () =>
					json(
						200,
						envelope({
							kind: { type: 'choice', choice: 'maybe', probabilities: { maybe: 1 } }
						})
					)
				),
				{
					decision: 'Testing',
					state: '',
					questions: {
						kind: {
							type: 'choice',
							instructions: 'Which?',
							criteria: { a: 'A', b: 'B' }
						}
					}
				}
			);
			expect(unknownOption).toBeNull();
		})
	);

	it.effect('answers nothing when Cloudflare cannot be reached', () =>
		Effect.gen(function* () {
			const answers = yield* ask(
				clefAnswering([], (request) =>
					Effect.fail(
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								description: 'connection refused'
							})
						})
					)
				),
				yesNo
			);
			expect(answers).toBeNull();
		})
	);

	it.effect('answers nothing when Cloudflare does not answer in time', () =>
		Effect.gen(function* () {
			const sent = yield* Deferred.make<void>();
			const fiber = yield* Effect.forkChild(
				ask(
					clefAnswering([], () =>
						Deferred.succeed(sent, undefined).pipe(Effect.andThen(Effect.never))
					),
					yesNo
				)
			);
			// Reading the credentials is real I/O, so wait for the call before moving the clock.
			yield* Deferred.await(sent);
			yield* TestClock.adjust(CLEF_TIMEOUT);
			expect(yield* Fiber.join(fiber)).toBeNull();
		})
	);
});

const verify = (layer: ReturnType<typeof clefAnswering>) =>
	Effect.gen(function* () {
		yield* (yield* Clef).verify({ accountId: 'acct-2', apiToken: 'other-token' });
	}).pipe(Effect.provide(layer));

describe('Clef.verify', () => {
	it.effect('asks one question with the given credentials', () =>
		Effect.gen(function* () {
			const sent: Array<Sent> = [];
			yield* verify(clefAnswering(sent, () => json(200, envelope({ check: noul(0.7) }))));
			expect(sent).toHaveLength(1);
			expect(sent[0]?.url).toContain('/accounts/acct-2/');
			expect(sent[0]?.authorization).toBe('Bearer other-token');
		})
	);

	it.effect("fails with Cloudflare's error message on an error status", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				verify(
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
				verify(clefAnswering([], () => json(200, { result: { answers: { check: 2 } } })))
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
				verify(
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
				Effect.flip(verify(clefAnswering([], () => Effect.never)))
			);
			yield* TestClock.adjust(CLEF_TIMEOUT);
			const error = yield* Fiber.join(fiber);
			expect(error).toMatchObject({ _tag: 'ClefError', status: null });
			expect(error.detail).toBe(`no answer after ${CLEF_TIMEOUT}`);
		})
	);
});
