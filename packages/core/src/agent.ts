import {
	query as sdkQuery,
	type SDKMessage,
	type Options as SdkOptions,
	type SDKResultMessage
} from '@anthropic-ai/claude-agent-sdk';
import {
	Context,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Schema,
	SchemaIssue,
	Stream,
	Struct
} from 'effect';
import { CostUsd, SessionId, Step, type Env } from './primitives.ts';
import { AgentSession } from './run.ts';

// --- Public types ---

/**
 * What the agent may do.
 *
 * - `edit`: the implementer and its fix steps. They must edit files and run commands
 *   unattended, so they run with `bypassPermissions`. `acceptEdits` would still deny every
 *   shell command (nobody can answer a prompt), and an allowlist cannot predict the
 *   project's commands. The agent is confined only by its `cwd` and the caller's env, not
 *   sandboxed.
 * - `read-only`: reviewers and the verifier. Only `Read`, `Grep` and `Glob` exist, and
 *   `dontAsk` denies anything not pre-approved.
 * - `none`: no tools; everything the agent needs is in the prompt (the LLM router).
 */
export type AgentAccess = 'edit' | 'read-only' | 'none';

/** Where to write the call's transcript: `<dir>/<step>[-<label>]-<n>.jsonl`. */
export interface TranscriptTarget {
	/** Normally `shipPaths(home).transcripts(runId)`. */
	readonly dir: string;
}

export interface AgentRunInput {
	/** The pipeline step making the call. Names the transcript and the fake's script. */
	readonly step: Step;
	/** Tells apart calls within one step, e.g. the reviewer's name. */
	readonly label?: string;
	readonly prompt: string;
	readonly model: string;
	readonly access: AgentAccess;
	/** Continue this session instead of starting a new one. */
	readonly resume?: AgentSession;
	readonly cwd: string;
	/** The caller's environment. It replaces the agent process's environment entirely. */
	readonly env: Env;
	/** Directories outside `cwd` the agent may read, e.g. the plan dir. */
	readonly additionalDirectories?: ReadonlyArray<string>;
	/** The call fails with `AgentTimeout` and the agent is killed after this long. */
	readonly timeoutMs: number;
	readonly transcript?: TranscriptTarget | undefined;
}

export interface AgentResult<A> {
	readonly session: AgentSession;
	/** The structured output decoded with the call's schema; `null` without a schema. */
	readonly output: A;
	/** The agent's final text. */
	readonly text: string;
	/** What this call cost, excluding earlier calls in a resumed session. */
	readonly cost: AgentCallCost;
	readonly turns: number;
	/** The transcript file, when one was written. */
	readonly transcriptPath: string | null;
}

/**
 * The cost of one agent call, ready for an `AgentCost` event. The Agent builds it from
 * the call's own step and model, so callers never re-supply them.
 */
export const AgentCallCost = Schema.Struct({
	step: Step,
	model: Schema.String,
	sessionId: SessionId,
	/** Excludes earlier calls in a resumed session. */
	costUsd: CostUsd
});
export interface AgentCallCost extends Schema.Schema.Type<typeof AgentCallCost> {}

/**
 * What a failed call still cost, when the SDK got as far as a result. Its `session` is the
 * one to resume next: resuming the older one would count this call's cost again.
 */
export const AgentSpend = Schema.Struct({
	session: AgentSession,
	cost: AgentCallCost
});
export interface AgentSpend extends Schema.Schema.Type<typeof AgentSpend> {}

export class AgentTimeout extends Schema.TaggedError<AgentTimeout>()('AgentTimeout', {
	step: Step,
	timeoutMs: Schema.Number
}) {
	override get message(): string {
		return `The ${this.step} agent timed out after ${this.timeoutMs} ms`;
	}
}

/**
 * The call failed outside the agent's control: the SDK threw, the agent ended with an
 * error result or without one, or the transcript file could not be opened.
 */
export class AgentSdkError extends Schema.TaggedError<AgentSdkError>()('AgentSdkError', {
	step: Step,
	/**
	 * The result's subtype (e.g. `error_max_turns`), `exception` when the SDK threw,
	 * `no-result`, or `transcript`; `AgentFake` adds `unscripted`.
	 */
	reason: Schema.String,
	detail: Schema.String,
	/** Set for an error result, which is still billed. */
	spend: Schema.optionalKey(AgentSpend)
}) {
	override get message(): string {
		return `The ${this.step} agent failed (${this.reason}): ${this.detail}`;
	}
}

/** The agent's structured output does not match the schema it was given. */
export class AgentOutputMismatch extends Schema.TaggedError<AgentOutputMismatch>()(
	'AgentOutputMismatch',
	{
		step: Step,
		detail: Schema.String,
		/** The output as JSON text, for the event log. */
		output: Schema.String,
		/** Set when the mismatch came from a finished call, which is still billed. */
		spend: Schema.optionalKey(AgentSpend)
	}
) {
	override get message(): string {
		return `The ${this.step} agent's output does not match its schema: ${this.detail}`;
	}
}

export type AgentError = AgentTimeout | AgentSdkError | AgentOutputMismatch;

/**
 * The cost of a failed call, for an `AgentCost` event; `null` when nothing is known
 * (a timeout or an exception aborts the call before the SDK reports a total).
 */
export const agentErrorCost = (error: AgentError): AgentCallCost | null =>
	error._tag === 'AgentTimeout' ? null : (error.spend?.cost ?? null);

/** A schema for structured output. Its encoded side must be a JSON object. */
export type OutputSchema<A> = Schema.Codec<A, unknown>;

export interface AgentShape {
	/** Runs one agent call to completion; its final text is the answer. */
	readonly run: (input: AgentRunInput) => Effect.Effect<AgentResult<null>, AgentError>;
	/** Runs one agent call whose answer is structured output matching `schema`. */
	readonly runStructured: <A>(
		input: AgentRunInput,
		schema: OutputSchema<A>
	) => Effect.Effect<AgentResult<A>, AgentError>;
}

// --- Helpers ---

/** The JSON Schema the SDK's `outputFormat` gets for `schema`. */
export const outputJsonSchema = (schema: Schema.Top): Record<string, unknown> => {
	const document = Schema.toJsonSchemaDocument(schema);
	return {
		...document.schema,
		...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {})
	};
};

/**
 * This call's cost from the session's running total. A resumed session's
 * `total_cost_usd` starts from the total its transcript saved, so the previous total is
 * subtracted. A total below the previous one means the transcript saved none and the
 * count restarted, so the whole total is this call's.
 *
 * TODO: confirm against a real resumed session.
 */
export const callCost = (totalCostUsd: number, resume: AgentSession | undefined): number => {
	const previous = resume?.cumulativeCostUsd ?? 0;
	return totalCostUsd >= previous ? totalCostUsd - previous : totalCostUsd;
};

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
// TODO: confirm against the real SDK that `json_schema` output still arrives under
// `dontAsk` with a restricted tool list (`read-only`) and with no tools (`none`): the SDK
// delivers it through a tool call, and nothing documents whether `dontAsk` allows it.

/** SDK options for one call. */
export const sdkOptions = (
	input: AgentRunInput & { readonly schema?: Schema.Top },
	abortController: AbortController
): SdkOptions => {
	const access: SdkOptions =
		input.access === 'edit'
			? {
					tools: { type: 'preset', preset: 'claude_code' },
					permissionMode: 'bypassPermissions',
					allowDangerouslySkipPermissions: true
				}
			: {
					tools: input.access === 'read-only' ? READ_ONLY_TOOLS : [],
					allowedTools: input.access === 'read-only' ? READ_ONLY_TOOLS : [],
					permissionMode: 'dontAsk'
				};
	return {
		...access,
		cwd: input.cwd,
		env: { ...input.env },
		model: input.model,
		abortController,
		// Never load the user's or project's Claude settings, hooks or CLAUDE.md.
		settingSources: [],
		...(input.resume === undefined ? {} : { resume: input.resume.sessionId }),
		...(input.additionalDirectories === undefined
			? {}
			: { additionalDirectories: [...input.additionalDirectories] }),
		...(input.schema === undefined
			? {}
			: { outputFormat: { type: 'json_schema', schema: outputJsonSchema(input.schema) } })
	};
};

/** Starts an SDK query; the real layer passes the SDK's `query`, tests a scripted stream. */
export type QueryFn = (params: {
	readonly prompt: string;
	readonly options: SdkOptions;
}) => AsyncIterable<SDKMessage>;

const errorDetail = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const resultSpend = (input: AgentRunInput, result: SDKResultMessage): AgentSpend => {
	const sessionId = SessionId.make(result.session_id);
	return {
		session: { sessionId, cumulativeCostUsd: result.total_cost_usd },
		cost: {
			step: input.step,
			model: input.model,
			sessionId,
			costUsd: callCost(result.total_cost_usd, input.resume)
		}
	};
};

const resultError = (input: AgentRunInput, result: SDKResultMessage): AgentSdkError => {
	const detail =
		result.subtype === 'success'
			? result.result
			: [...result.errors, result.stop_reason ?? ''].filter(Boolean).join('; ');
	return new AgentSdkError({
		step: input.step,
		reason: result.subtype,
		detail: detail || 'no detail',
		spend: resultSpend(input, result)
	});
};

const toJsonText = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? 'undefined';
	} catch {
		return String(value);
	}
};

/** Attaches a finished call's cost to a mismatch in its output. */
export const billedTo =
	(result: Pick<AgentResult<unknown>, 'session' | 'cost'>) =>
	(error: AgentOutputMismatch): AgentOutputMismatch =>
		new AgentOutputMismatch({
			step: error.step,
			detail: error.detail,
			output: error.output,
			spend: { session: result.session, cost: result.cost }
		});

/** Decodes an agent's structured output, failing with `AgentOutputMismatch`. */
export const decodeOutput = <A>(step: Step, schema: OutputSchema<A>, output: unknown) =>
	Schema.decodeUnknownEffect(schema)(output).pipe(
		Effect.mapError(
			(error) =>
				new AgentOutputMismatch({
					step,
					detail: SchemaIssue.makeFormatterDefault()(error.issue),
					output: toJsonText(output)
				})
		)
	);

// --- Implementation ---

/** The agent runner over `runQuery`. */
export const makeAgent = (runQuery: QueryFn) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const encoder = new TextEncoder();

		/** Opens the first free `<base>-<n>.jsonl`, so a re-run step never overwrites. */
		const openTranscript = Effect.fnUntraced(function* (
			input: AgentRunInput,
			target: TranscriptTarget
		) {
			const sdkError = (error: { message: string }) =>
				new AgentSdkError({
					step: input.step,
					reason: 'transcript',
					detail: error.message
				});
			yield* fs
				.makeDirectory(target.dir, { recursive: true })
				.pipe(Effect.mapError(sdkError));
			const base = `${target.dir}/${input.step}${input.label === undefined ? '' : `-${input.label}`}`;
			for (let n = 1; ; n += 1) {
				const path = `${base}-${n}.jsonl`;
				const opened = yield* fs.open(path, { flag: 'wx' }).pipe(
					Effect.map((file) => ({ path, file })),
					Effect.catchTag('PlatformError', (error) =>
						error.reason._tag === 'AlreadyExists'
							? Effect.succeed(null)
							: Effect.fail(sdkError(error))
					)
				);
				if (opened !== null) return opened;
			}
		});

		/** Runs the call; `structured_output` is left for the caller to decode. */
		const runCall = Effect.fnUntraced(function* (
			input: AgentRunInput,
			schema: Schema.Top | undefined
		) {
			const transcript =
				input.transcript === undefined
					? null
					: yield* openTranscript(input, input.transcript);
			const abortController = yield* Effect.acquireRelease(
				Effect.sync(() => new AbortController()),
				// Interruption, a timeout or a failure kills the agent and its child processes.
				(controller, exit) =>
					Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => controller.abort())
			);
			const options = sdkOptions(
				schema === undefined ? input : { ...input, schema },
				abortController
			);
			const result = yield* Stream.fromAsyncIterable(
				// A generator starts `query` on the first pull, so a throw becomes a typed error.
				(async function* () {
					yield* runQuery({ prompt: input.prompt, options });
				})(),
				(error) =>
					new AgentSdkError({
						step: input.step,
						reason: 'exception',
						detail: errorDetail(error)
					})
			).pipe(
				Stream.tap((message) =>
					transcript === null
						? Effect.void
						: transcript.file
								.writeAll(encoder.encode(`${toJsonText(message)}\n`))
								.pipe(Effect.ignore({ log: true }))
				),
				Stream.runFold(
					(): SDKResultMessage | null => null,
					(last, message) => (message.type === 'result' ? message : last)
				)
			);
			if (result === null) {
				return yield* new AgentSdkError({
					step: input.step,
					reason: 'no-result',
					detail: 'The agent ended without a result message'
				});
			}
			if (result.subtype !== 'success' || result.is_error) {
				return yield* resultError(input, result);
			}
			const { session, cost } = resultSpend(input, result);
			return {
				session,
				structuredOutput: result.structured_output,
				text: result.result,
				cost,
				turns: result.num_turns,
				transcriptPath: transcript?.path ?? null
			};
		});

		const withTimeout = (input: AgentRunInput, schema: Schema.Top | undefined) =>
			Effect.scoped(runCall(input, schema)).pipe(
				Effect.timeoutOrElse({
					duration: input.timeoutMs,
					orElse: () =>
						Effect.fail(
							new AgentTimeout({ step: input.step, timeoutMs: input.timeoutMs })
						)
				})
			);

		const run = Effect.fn('Agent.run')(function* (input: AgentRunInput) {
			const result = yield* withTimeout(input, undefined);
			return { ...Struct.omit(result, ['structuredOutput']), output: null };
		});

		const runStructured = Effect.fn('Agent.runStructured')(function* <A>(
			input: AgentRunInput,
			schema: OutputSchema<A>
		) {
			const { structuredOutput, ...result } = yield* withTimeout(input, schema);
			const output = yield* decodeOutput(input.step, schema, structuredOutput).pipe(
				Effect.mapError(billedTo(result))
			);
			return { ...result, output };
		});

		return Agent.of({ run, runStructured });
	});

/** Runs agents through the Claude Agent SDK, using the existing Claude Code login. */
export class Agent extends Context.Service<Agent, AgentShape>()('@ship/core/Agent') {
	static readonly layer = Layer.effect(this, makeAgent(sdkQuery));
}
