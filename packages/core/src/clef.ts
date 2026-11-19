import { Context, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import type { ChangedFile } from './git.ts';
import { truncateDiff } from './prompt.ts';
import type { ReviewerDef } from './reviewer.ts';

/** A Cloudflare account and an API token with the Workers AI permission. */
export const CloudflareCredentials = Schema.Struct({
	accountId: Schema.NonEmptyString,
	apiToken: Schema.NonEmptyString
});
export interface CloudflareCredentials extends Schema.Schema.Type<typeof CloudflareCredentials> {}

export interface ClefPickInput {
	/** Reviewers the deterministic triggers did not pick; one question is asked per reviewer. */
	readonly candidates: ReadonlyArray<ReviewerDef>;
	/** The range being routed: its changed files and its diff. */
	readonly changes: {
		readonly files: ReadonlyArray<ChangedFile>;
		readonly diff: string;
	};
	readonly credentials: CloudflareCredentials;
}

/** A candidate Clef picked, with the probability it gave. */
export interface ClefPick {
	readonly name: string;
	readonly probability: number;
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
	 * Asks, for each candidate, whether the change touches what the reviewer covers. Returns
	 * the candidates Clef gives a probability of at least {@link CLEF_THRESHOLD}, in the
	 * order given. No candidates means no call.
	 */
	readonly pick: (input: ClefPickInput) => Effect.Effect<ReadonlyArray<ClefPick>, ClefError>;
	/**
	 * Asks one trivial question, which proves together that the account id exists, the
	 * token is valid and it may run Workers AI.
	 */
	readonly verify: (credentials: CloudflareCredentials) => Effect.Effect<void, ClefError>;
}

export const CLEF_MODEL = 'clef-flash';
/** A candidate is picked at this probability or above. */
export const CLEF_THRESHOLD = 0.5;
export const CLEF_TIMEOUT = '30 seconds';
/**
 * The diff Clef sees, in characters. clef-flash has a 24,576-token context, which the
 * questions share; Clef truncates a longer `state` itself, but sending less keeps the
 * request small and the changed files list whole.
 */
const MAX_STATE_DIFF_CHARS = 60_000;
/** How much of a reviewer's brief stands in for a missing `description`. */
const MAX_BRIEF_SUMMARY_CHARS = 300;

const clefUrl = (accountId: string) =>
	`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${CLEF_MODEL}`;

/** The brief's first paragraph that is not a heading, on one line and cut to a summary. */
const firstParagraph = (brief: string): string => {
	const paragraph = brief.split(/\n\s*\n/u).find((part) => !part.trim().startsWith('#')) ?? '';
	const text = paragraph.replace(/\s+/gu, ' ').trim();
	return text.length > MAX_BRIEF_SUMMARY_CHARS
		? `${text.slice(0, MAX_BRIEF_SUMMARY_CHARS)}…`
		: text;
};

const reviewerQuestion = (reviewer: ReviewerDef) => ({
	type: 'noul',
	instructions: `Does this code change clearly touch what the "${reviewer.name}" code reviewer covers: ${reviewer.description ?? firstParagraph(reviewer.brief)}`
});

const changeState = (changes: ClefPickInput['changes']): string =>
	[
		'Changed files:',
		...changes.files.map((file) => `- ${file.status} ${file.path}`),
		'',
		'Diff:',
		truncateDiff(changes.diff, MAX_STATE_DIFF_CHARS)
	].join('\n');

const ClefOutput = Schema.Struct({
	answers: Schema.Record(
		Schema.String,
		Schema.Struct({
			type: Schema.Literal('noul'),
			noul: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
		})
	)
});

// The docs show the model's output bare; the REST API usually wraps results in an
// envelope. Accept both so either shape decodes.
const ClefResponse = Schema.Union([Schema.Struct({ result: ClefOutput }), ClefOutput]);

/** The `errors` of Cloudflare's REST envelope, which an error status carries. */
const CloudflareErrors = Schema.Struct({
	errors: Schema.Array(Schema.Struct({ message: Schema.String }))
});

const decodeResponse = Schema.decodeUnknownEffect(ClefResponse);
const decodeErrors = Schema.decodeUnknownEffect(CloudflareErrors);

const make = Effect.gen(function* () {
	const http = yield* HttpClient.HttpClient;

	/** One Clef call: the probability of yes for each question, by its id. */
	const ask = (
		credentials: CloudflareCredentials,
		state: string,
		questions: Readonly<Record<string, ReturnType<typeof reviewerQuestion>>>
	) =>
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
			const probabilities = new Map<string, number>();
			for (const [id, answer] of Object.entries(output.answers)) {
				probabilities.set(id, answer.noul);
			}
			return probabilities;
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

	const pick = Effect.fn('Clef.pick')(function* (input: ClefPickInput) {
		if (input.candidates.length === 0) return [];
		const questions = Object.fromEntries(
			input.candidates.map((reviewer) => [reviewer.name, reviewerQuestion(reviewer)])
		);
		const probabilities = yield* ask(input.credentials, changeState(input.changes), questions);
		return input.candidates.flatMap((reviewer): ReadonlyArray<ClefPick> => {
			const probability = probabilities.get(reviewer.name);
			return probability !== undefined && probability >= CLEF_THRESHOLD
				? [{ name: reviewer.name, probability }]
				: [];
		});
	});

	const verify = Effect.fn('Clef.verify')(function* (credentials: CloudflareCredentials) {
		yield* ask(credentials, 'ship is checking its Cloudflare credentials.', {
			check: { type: 'noul', instructions: 'Is this text about credentials?' }
		});
	});

	return Clef.of({ pick, verify });
});

/**
 * Cloudflare Clef, the Workers AI model that answers yes/no questions with a probability,
 * over the REST API. Routing asks it which reviewers a change needs beyond the
 * deterministic triggers. See https://developers.cloudflare.com/workers-ai/models/clef-flash/.
 */
export class Clef extends Context.Service<Clef, ClefShape>()('@ship/core/Clef') {
	/** Calls Cloudflare with `fetch`. */
	static readonly layer: Layer.Layer<Clef> = Layer.effect(this, make).pipe(
		Layer.provide(FetchHttpClient.layer)
	);
	/** Calls Cloudflare through the `HttpClient` provided, e.g. a stub in tests. */
	static readonly layerWithHttpClient: Layer.Layer<Clef, never, HttpClient.HttpClient> =
		Layer.effect(this, make);
}
