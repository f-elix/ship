import { Clock, Context, DateTime, Duration, Effect, Ref, Schema } from 'effect';
import { agentErrorCost, type AgentCallCost, type AgentError } from './agent.ts';
import type { CheckSpawnError, CheckTimeout } from './checks.ts';
import type { GhError } from './gh.ts';
import { Git, type GitError } from './git.ts';
import type { UnknownLockResource } from './locks.ts';
import type { PrPublishError } from './pr.ts';
import { CostUsd, Step, type Env, type GitSha } from './primitives.ts';
import type { ReviewerFileError } from './reviewer-markdown.ts';
import type { AppendableEvent } from './run-journal.ts';
import { AgentSession } from './run.ts';

/**
 * Where a step runs git, and the base a timed-out step compares `HEAD` with to tell whether
 * it committed.
 */
interface GitRepoAt {
	readonly cwd: string;
	readonly env: Env;
	readonly baseSha: GitSha;
}

// --- Reporting ---

/** Where step actors send the events they produce; the run driver provides it. */
export class RunReporter extends Context.Service<
	RunReporter,
	{ readonly report: (event: AppendableEvent) => Effect.Effect<void> }
>()('@ship/core/RunReporter') {}

/** An event as a step reports it; the timestamp is added when it is reported. */
export type EventInput = AppendableEvent extends infer E
	? E extends AppendableEvent
		? Omit<E, 'at'>
		: never
	: never;

// --- Step results ---

/** A step ran past its configured timeout. */
export class StepTimeout extends Schema.TaggedError<StepTimeout>()('StepTimeout', {
	step: Step,
	timeoutMs: Schema.Number
}) {
	override get message(): string {
		return `The ${this.step} step timed out after ${this.timeoutMs} ms`;
	}
}

/** The repo or the run is not in the state a step needs, e.g. a dirty tree at baseline. */
export class StepNotReady extends Schema.TaggedError<StepNotReady>()('StepNotReady', {
	reason: Schema.String
}) {
	override get message(): string {
		return this.reason;
	}
}

/** Every error a step can fail with; anything else is a defect and fails the run. */
export type StepError =
	| AgentError
	| CheckSpawnError
	| CheckTimeout
	| GhError
	| GitError
	| PrPublishError
	| StepNotReady
	| ReviewerFileError
	| StepTimeout
	| UnknownLockResource;

/** Why a step failed, as the machine needs it to pick the next state. */
export const StepFailure = Schema.Struct({
	step: Step,
	message: Schema.String,
	/** The step, an agent call or a check command ran past its timeout. */
	timedOut: Schema.Boolean,
	/** Set on timeouts only: HEAD moved past the base, so the run has commits to publish. */
	hasCommits: Schema.Boolean
});
export interface StepFailure extends Schema.Schema.Type<typeof StepFailure> {}

/** What a step spent, whether it succeeded or failed. */
export const StepSpend = Schema.Struct({
	costUsd: CostUsd,
	/** The implementer session to resume next, when the step called the implementer. */
	session: Schema.NullOr(AgentSession)
});
export interface StepSpend extends Schema.Schema.Type<typeof StepSpend> {}

/** A step's result. Steps never fail: their errors become `Failed`, so spending is kept. */
export const stepOutcome = <S extends Schema.Top>(output: S) =>
	Schema.Union([
		Schema.TaggedStruct('Ok', { output, spent: StepSpend }),
		Schema.TaggedStruct('Failed', { failure: StepFailure, spent: StepSpend })
	]);

export type StepOutcome<A> =
	| { readonly _tag: 'Ok'; readonly output: A; readonly spent: StepSpend }
	| { readonly _tag: 'Failed'; readonly failure: StepFailure; readonly spent: StepSpend };

/** What a step body uses to report events and record what it spent. */
export interface StepKit {
	readonly report: (event: EventInput) => Effect.Effect<void>;
	/** Reports an event that already has its timestamp, e.g. a check event. */
	readonly emit: (event: AppendableEvent) => Effect.Effect<void>;
	/** Reports an agent call's cost and adds it to the step's spending. */
	readonly recordCost: (cost: AgentCallCost) => Effect.Effect<void>;
	/** Keeps the implementer session the next fix step resumes. */
	readonly recordSession: (session: AgentSession) => Effect.Effect<void>;
}

export interface RunStepOptions {
	/**
	 * Limit for the whole step, or `null` for none. Steps whose work waits for a lock or
	 * has a fallback for a slow call leave it to their services' own per-call limits.
	 */
	readonly timeoutMs: number | null;
}

/** Whether each step error is a timeout. Listing every tag makes a new error decide. */
const TIMED_OUT: Readonly<Record<StepError['_tag'], boolean>> = {
	StepTimeout: true,
	AgentTimeout: true,
	CheckTimeout: true,
	AgentSdkError: false,
	AgentOutputMismatch: false,
	CheckSpawnError: false,
	GhError: false,
	GitError: false,
	PrPublishError: false,
	StepNotReady: false,
	ReviewerFileError: false,
	UnknownLockResource: false
};

/**
 * The steps that run the implementer, whose session the next fix step resumes: `checks`
 * runs it between passes.
 */
const IMPLEMENTER_STEPS: ReadonlySet<Step> = new Set(['implement', 'checks', 'fix']);

interface FailedSpend {
	readonly cost: AgentCallCost | null;
	readonly session: AgentSession | null;
}

/** The cost and implementer session a failed step still produced. */
const failedSpend = (error: StepError): FailedSpend => {
	switch (error._tag) {
		case 'PrPublishError':
			return { cost: error.cost, session: null };
		case 'AgentSdkError':
		case 'AgentOutputMismatch':
			return { cost: agentErrorCost(error), session: error.spend?.session ?? null };
		case 'AgentTimeout':
		case 'StepTimeout':
		case 'CheckTimeout':
		case 'CheckSpawnError':
		case 'GhError':
		case 'GitError':
		case 'StepNotReady':
		case 'ReviewerFileError':
		case 'UnknownLockResource':
			return { cost: null, session: null };
	}
};

/**
 * Runs one step's `body`: reports `StepStarted` and `StepEnded` (also when interrupted),
 * applies the step timeout, and turns typed errors into a `Failed` outcome that keeps
 * the cost and implementer session the step produced before failing.
 */
export const runStep = <A, R>(
	step: Step,
	state: Pick<GitRepoAt, 'cwd' | 'env' | 'baseSha'>,
	options: RunStepOptions,
	body: (kit: StepKit) => Effect.Effect<A, StepError, R>
): Effect.Effect<StepOutcome<A>, never, R | RunReporter | Git> =>
	Effect.gen(function* () {
		const reporter = yield* RunReporter;
		const git = yield* Git;
		const spent = yield* Ref.make<StepSpend>({ costUsd: 0, session: null });

		const emit = reporter.report;
		const report = (event: EventInput): Effect.Effect<void> =>
			Effect.flatMap(DateTime.now, (at) => emit(withAt(event, at)));
		const recordCost = (cost: AgentCallCost) =>
			Effect.andThen(
				Ref.update(spent, (current) => ({
					...current,
					costUsd: current.costUsd + cost.costUsd
				})),
				report({
					_tag: 'AgentCost',
					step: cost.step,
					model: cost.model,
					sessionId: cost.sessionId,
					costUsd: cost.costUsd
				})
			);
		const recordSession = (session: AgentSession) =>
			Ref.update(spent, (current) => ({ ...current, session }));
		const kit: StepKit = { report, emit, recordCost, recordSession };

		const start = yield* Clock.currentTimeMillis;
		const ended = (outcome: 'ok' | 'failed' | 'timed-out' | 'interrupted', error?: string) =>
			Effect.flatMap(Clock.currentTimeMillis, (now) =>
				report({
					_tag: 'StepEnded',
					step,
					outcome,
					durationMs: now - start,
					...(error === undefined ? {} : { error })
				})
			);

		const { timeoutMs } = options;
		const limited =
			timeoutMs === null
				? body(kit)
				: Effect.timeoutOrElse(body(kit), {
						duration: Duration.millis(timeoutMs),
						orElse: () => Effect.fail(new StepTimeout({ step, timeoutMs }))
					});

		const onError = Effect.fnUntraced(function* (error: StepError) {
			const { cost, session } = failedSpend(error);
			if (cost !== null) yield* recordCost(cost);
			if (session !== null && IMPLEMENTER_STEPS.has(step)) yield* recordSession(session);
			const timedOut = TIMED_OUT[error._tag];
			const hasCommits = timedOut
				? yield* git.headSha(state).pipe(
						Effect.map((head) => head !== state.baseSha),
						Effect.orElseSucceed(() => false)
					)
				: false;
			yield* ended(timedOut ? 'timed-out' : 'failed', error.message);
			const failure: StepFailure = { step, message: error.message, timedOut, hasCommits };
			return { _tag: 'Failed', failure, spent: yield* Ref.get(spent) } as const;
		});

		yield* report({ _tag: 'StepStarted', step });
		return yield* limited.pipe(
			Effect.flatMap((output) =>
				Effect.andThen(
					ended('ok'),
					Effect.map(Ref.get(spent), (current): StepOutcome<A> => ({
						_tag: 'Ok',
						output,
						spent: current
					}))
				)
			),
			Effect.catch(onError),
			Effect.onInterrupt(() => ended('interrupted'))
		);
	});

const withAt = (event: EventInput, at: DateTime.Utc): AppendableEvent => ({ ...event, at });
