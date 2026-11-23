import { Array as Arr, Context, Effect, FileSystem, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import {
	readCredentials,
	writeCredentials,
	type CloudflareCredentials,
	type Credentials
} from './credentials.ts';
import type { ChangedFile } from './git.ts';
import { truncateDiff } from './prompt.ts';
import { ShipHome } from './ship-paths.ts';

// --- Questions and answers ---

/** A yes/no question; Clef answers with the probability of yes. */
export interface NoulQuestion {
	readonly type: 'noul';
	readonly instructions: string;
}

/** A question with one answer among `criteria`, each option id mapped to what it means. */
export interface ChoiceQuestion<O extends string = string> {
	readonly type: 'choice';
	readonly instructions: string;
	readonly criteria: Readonly<Record<O, string>>;
}

/** A rating on an ordered rubric: `criteria` lists the levels, lowest first. */
export interface ScoreQuestion {
	readonly type: 'score';
	readonly instructions: string;
	readonly criteria: ReadonlyArray<string>;
}

export type ClefQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** The questions of one request, by id (letters, digits, `_`, `.` and `-`). */
export type ClefQuestions = Readonly<Record<string, ClefQuestion>>;

/** The answer to a `noul` question: `p` is the probability of yes, between 0 and 1. */
export interface NoulAnswer {
	readonly p: number;
}

/** The answer to a `choice` question: the most probable option, and each option's probability. */
export interface ChoiceAnswer<O extends string = string> {
	readonly pick: O;
	readonly probabilities: Readonly<Record<O, number>>;
}

/**
 * The answer to a `score` question: the probability-weighted level, from 0 (the first
 * level) to the last level's index, which can fall between two levels.
 */
export interface ScoreAnswer {
	readonly score: number;
}

/** The answer type that matches question type `Q`. */
export type ClefAnswer<Q extends ClefQuestion> =
	Q extends ChoiceQuestion<infer O>
		? ChoiceAnswer<O>
		: Q extends ScoreQuestion
			? ScoreAnswer
			: NoulAnswer;

/** One answer per question of `Qs`, under the question's id. */
export type ClefAnswers<Qs extends ClefQuestions> = {
	readonly [K in keyof Qs]: ClefAnswer<Qs[K]>;
};

/** What a Clef decision needs of its step: whether the project turned Clef on. */
export interface ClefScope {
	readonly config: { readonly clef: boolean };
}

export interface ClefRequest<Qs extends ClefQuestions> {
	/** What the answers decide, for the warning logged when Clef gives none, e.g. "routing". */
	readonly decision: string;
	/** What the questions are about: the change, a comment, a failing check. */
	readonly state: string;
	readonly questions: Qs;
}

/**
 * A Clef call failed: Cloudflare could not be reached, answered with an error status
 * (`status` set, `detail` holds Cloudflare's error), answered something unexpected, or
 * took longer than {@link CLEF_TIMEOUT}. `cause` is the HTTP client or decoding error,
 * when there was one.
 */
export class ClefError extends Schema.TaggedError<ClefError>()('ClefError', {
	status: Schema.NullOr(Schema.Int),
	detail: Schema.String,
	cause: Schema.optionalKey(Schema.Defect())
}) {
	override get message(): string {
		const status = this.status === null ? '' : ` (HTTP ${this.status})`;
		return `Cloudflare Clef failed${status}: ${this.detail}`;
	}
}

export interface ClefShape {
	/**
	 * Asks `request.questions` about `request.state`, with the saved Cloudflare credentials.
	 * Returns one answer per question, or `null` when Clef gives none: the project turned it
	 * off, no credentials are saved, the credentials file cannot be read, or the call failed
	 * or timed out. `null` logs a warning, and the caller takes its fallback; Clef is never
	 * required. No questions means no call. More than {@link CLEF_MAX_QUESTIONS} questions
	 * are split into parallel calls.
	 */
	readonly ask: <const Qs extends ClefQuestions>(
		scope: ClefScope,
		request: ClefRequest<Qs>
	) => Effect.Effect<ClefAnswers<Qs> | null, never, ShipHome>;
	/**
	 * Asks one trivial question, which proves together that the account id exists, the
	 * token is valid and it may run Workers AI.
	 */
	readonly verify: (credentials: CloudflareCredentials) => Effect.Effect<void, ClefError>;
}

export const CLEF_MODEL = 'clef-flash';
export const CLEF_TIMEOUT = '30 seconds';
/** The most questions one call may ask, the API's limit. */
export const CLEF_MAX_QUESTIONS = 64;
/**
 * The diff Clef sees, in characters. clef-flash has a 24,576-token context, which the
 * questions share; Clef truncates a longer `state` itself, but sending less keeps the
 * request small and the changed files list whole.
 */
export const MAX_STATE_CHARS = 60_000;

/** A change as Clef's `state`: its changed files, then its diff cut to {@link MAX_STATE_CHARS}. */
export const changeState = (files: ReadonlyArray<ChangedFile>, diff: string): string =>
	[
		'Changed files:',
		...files.map((file) => `- ${file.status} ${file.path}`),
		'',
		'Diff:',
		truncateDiff(diff, MAX_STATE_CHARS)
	].join('\n');

// --- REST API ---

const clefUrl = (accountId: string) =>
	`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${CLEF_MODEL}`;

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

const RawAnswer = Schema.Union([
	Schema.Struct({ type: Schema.Literal('noul'), noul: Probability }),
	Schema.Struct({
		type: Schema.Literal('choice'),
		choice: Schema.String,
		probabilities: Schema.Record(Schema.String, Probability)
	}),
	Schema.Struct({ type: Schema.Literal('score'), score: Schema.Number })
]);
type RawAnswer = typeof RawAnswer.Type;

const ClefOutput = Schema.Struct({ answers: Schema.Record(Schema.String, RawAnswer) });

// The docs show the model's output bare; the REST API wraps results in an envelope.
// Accept both so either shape decodes.
const ClefResponse = Schema.Union([Schema.Struct({ result: ClefOutput }), ClefOutput]);

/** The `errors` of Cloudflare's REST envelope, which an error status carries. */
const CloudflareErrors = Schema.Struct({
	errors: Schema.Array(Schema.Struct({ message: Schema.String }))
});

const decodeResponse = Schema.decodeUnknownEffect(ClefResponse);
const decodeErrors = Schema.decodeUnknownEffect(CloudflareErrors);

type AnyAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** `raw` as the answer to `question`, or `null` when it answers another type or option. */
const toAnswer = (question: ClefQuestion, raw: RawAnswer | undefined): AnyAnswer | null => {
	if (raw === undefined) return null;
	switch (question.type) {
		case 'noul':
			return raw.type === 'noul' ? { p: raw.noul } : null;
		case 'choice':
			return raw.type === 'choice' && Object.hasOwn(question.criteria, raw.choice)
				? { pick: raw.choice, probabilities: raw.probabilities }
				: null;
		case 'score':
			return raw.type === 'score' ? { score: raw.score } : null;
	}
};

const make = Effect.gen(function* () {
	const http = yield* HttpClient.HttpClient;
	const fs = yield* FileSystem.FileSystem;

	/** One Clef call: the answer to each question, by its id. */
	const call = (credentials: CloudflareCredentials, state: string, questions: ClefQuestions) =>
		Effect.gen(function* () {
			const request = HttpClientRequest.post(clefUrl(credentials.accountId)).pipe(
				HttpClientRequest.bearerToken(credentials.apiToken),
				HttpClientRequest.bodyJsonUnsafe({ model: CLEF_MODEL, state, questions })
			);
			const response = yield* http.execute(request);
			const body = yield* response.json;
			if (response.status < 200 || response.status >= 300) {
				const detail = yield* decodeErrors(body).pipe(
					Effect.map((envelope) =>
						envelope.errors.map((error) => error.message).join('; ')
					),
					Effect.orElseSucceed(() => JSON.stringify(body))
				);
				return yield* new ClefError({ status: response.status, detail });
			}
			const decoded = yield* decodeResponse(body).pipe(
				Effect.mapError(
					(error) =>
						new ClefError({
							status: response.status,
							detail: `unexpected response: ${error.message}`,
							cause: error
						})
				)
			);
			const output = 'result' in decoded ? decoded.result : decoded;
			const answers: Record<string, AnyAnswer> = {};
			for (const [id, question] of Object.entries(questions)) {
				const answer = toAnswer(question, output.answers[id]);
				if (answer === null) {
					return yield* new ClefError({
						status: response.status,
						detail: `unexpected response: no ${question.type} answer to "${id}"`
					});
				}
				answers[id] = answer;
			}
			return answers;
		}).pipe(
			Effect.catchTag('HttpClientError', (error) =>
				Effect.fail(
					new ClefError({
						status: error.response?.status ?? null,
						detail: error.message,
						cause: error
					})
				)
			),
			Effect.timeoutOrElse({
				duration: CLEF_TIMEOUT,
				orElse: () =>
					Effect.fail(
						new ClefError({ status: null, detail: `no answer after ${CLEF_TIMEOUT}` })
					)
			})
		);

	/** The saved Cloudflare credentials, or `null` after logging why there are none. */
	const savedCredentials = (decision: string) =>
		Effect.gen(function* () {
			const home = yield* ShipHome;
			const credentials: Credentials | null = yield* readCredentials(home.home).pipe(
				Effect.provideService(FileSystem.FileSystem, fs),
				Effect.catchTag('CredentialsFileError', (error) =>
					Effect.as(Effect.logWarning(`${decision} without Clef`, error), null)
				)
			);
			if (credentials === null) return null;
			if (credentials.cloudflare === undefined) {
				yield* Effect.logWarning(
					`No Cloudflare credentials are saved (\`ship auth cloudflare\`); ${decision} without Clef`
				);
				return null;
			}
			return credentials.cloudflare;
		});

	const ask = <const Qs extends ClefQuestions>(scope: ClefScope, request: ClefRequest<Qs>) =>
		Effect.gen(function* () {
			const entries = Object.entries(request.questions);
			// The answers are built per question by `toAnswer`, so they match `Qs`.
			if (entries.length === 0) return {} as ClefAnswers<Qs>;
			if (!scope.config.clef) {
				yield* Effect.logWarning(
					`Clef is off for this project (\`clef: false\`); ${request.decision} without it`
				);
				return null;
			}
			const credentials = yield* savedCredentials(request.decision);
			if (credentials === null) return null;
			const parts = yield* Effect.forEach(
				Arr.chunksOf(entries, CLEF_MAX_QUESTIONS),
				(chunk) => call(credentials, request.state, Object.fromEntries(chunk)),
				{ concurrency: 'unbounded' }
			).pipe(
				Effect.catchTag('ClefError', (error) =>
					Effect.as(Effect.logWarning(`${request.decision} without Clef`, error), null)
				)
			);
			if (parts === null) return null;
			return Object.assign({}, ...parts) as ClefAnswers<Qs>;
		}).pipe(Effect.withSpan('Clef.ask'));

	const verify = Effect.fn('Clef.verify')(function* (credentials: CloudflareCredentials) {
		yield* call(credentials, 'ship is checking its Cloudflare credentials.', {
			check: { type: 'noul', instructions: 'Is this text about credentials?' }
		});
	});

	return Clef.of({ ask, verify });
});

/**
 * Cloudflare Clef, the Workers AI model that answers yes/no, choice and score questions with
 * probabilities, over the REST API. Ship asks it for decisions where a deterministic rule
 * falls short, and keeps a fallback for each: which reviewers a change needs, how risky it
 * is, which convention topics apply, whether a must-fix is only a taste remark, how severe
 * an unlabelled review thread is, and whether a failing check is the change's fault. See
 * https://developers.cloudflare.com/workers-ai/models/clef-flash/.
 */
export class Clef extends Context.Service<Clef, ClefShape>()('@ship/core/Clef') {
	/** Calls Cloudflare with `fetch`; reads the credentials with the `FileSystem` provided. */
	static readonly layer: Layer.Layer<Clef, never, FileSystem.FileSystem> = Layer.effect(
		this,
		make
	).pipe(Layer.provide(FetchHttpClient.layer));
	/** Calls Cloudflare through the `HttpClient` provided, e.g. a stub in tests. */
	static readonly layerWithHttpClient: Layer.Layer<
		Clef,
		never,
		HttpClient.HttpClient | FileSystem.FileSystem
	> = Layer.effect(this, make);
}

/**
 * Checks Cloudflare credentials with one Clef call, which proves the account id, the
 * token and its Workers AI permission together, then saves them beside any other saved
 * credentials. When Clef refuses them, it fails with Cloudflare's error and saves nothing.
 */
export const saveCloudflareCredentials = Effect.fn('saveCloudflareCredentials')(function* (
	home: string,
	cloudflare: CloudflareCredentials
) {
	yield* (yield* Clef).verify(cloudflare);
	const saved = yield* readCredentials(home);
	yield* writeCredentials(home, { ...saved, cloudflare });
});
