import {
	createEffectEventStreamLogic,
	createEffectLogic,
	EffectFailure,
	setupEffect
} from '@xstate/effect';
import { Cause, Schema, type Effect } from 'effect';
import {
	baselineStep,
	checksPassed,
	checksStep,
	escalateStep,
	fixChecksStep,
	fixStep,
	implementStep,
	planIntent,
	prStep,
	TriageNext,
	triageStep
} from './pipeline-steps.ts';
import {
	completeRound,
	reviewStep,
	routeStep,
	startRound,
	verifyStep,
	withFindings
} from './review-round.ts';
import { stepOutcome, type StepOutcome, type StepSpend } from './run-step.ts';
import { CheckRound, RunState, type EscalationReason } from './run.ts';

// --- Step actors ---

const step = <A, R>(run: (state: RunState) => Effect.Effect<StepOutcome<A>, never, R>) =>
	createEffectLogic({ schemas: { input: RunState }, effect: ({ input }) => run(input) });

const checksLogic = (run: typeof checksStep) =>
	createEffectEventStreamLogic({
		schemas: { input: RunState },
		stream: ({ input }) => run(input)
	});

/**
 * Every step actor gets the run's context as its input, in this machine and the review
 * machine. The driver relies on this when it restarts a step that finished before the
 * machine took its result.
 */
export const stepInput = <C>({ context }: { readonly context: C }): C => context;

// --- Transitions ---

type Settled =
	| 'implement'
	| 'checks'
	| 'fixChecks'
	| 'route'
	| 'review'
	| 'verify'
	| 'triage'
	| 'fix'
	| 'escalate'
	| 'pr'
	| 'done'
	| 'escalated'
	| 'failed';

interface Next {
	readonly target: Settled;
	readonly context: RunState;
}

/** Adds what a step spent to the context. */
const withSpend = (context: RunState, spent: StepSpend): RunState => ({
	...context,
	costUsd: context.costUsd + spent.costUsd,
	implementerSession: spent.session ?? context.implementerSession
});

const escalate = (context: RunState, reason: EscalationReason): Next => ({
	target: 'escalate',
	context: { ...context, escalationReason: reason }
});

const fail = (context: RunState, error: string): Next => ({
	target: 'failed',
	context: { ...context, error }
});

/**
 * Where a step's outcome leads. A failed step fails the run, except a timeout after the
 * run committed work, which escalates so the work still ends up in a draft PR. A failing
 * `escalate` always fails the run, so escalation cannot loop.
 */
const settle = <A>(
	context: RunState,
	outcome: StepOutcome<A>,
	onOk: (context: RunState, output: A) => Next
): Next => {
	const spent = withSpend(context, outcome.spent);
	if (outcome._tag === 'Ok') return onOk(spent, outcome.output);
	const { failure } = outcome;
	return failure.timedOut && failure.hasCommits && failure.step !== 'escalate'
		? escalate(spent, 'timeout')
		: fail(spent, failure.message);
};

/** A defect in a step actor: an error no step expects. */
const onDefect = ({ context, event }: { context: RunState; event: { error: unknown } }): Next =>
	fail(context, describeDefect(event.error));

/** The message of a step actor's or the machine's unexpected error. */
export const describeDefect = (error: unknown): string => {
	const cause = EffectFailure.is(error) ? error.cause : null;
	if (cause !== null) {
		const squashed = Cause.squash(cause);
		return squashed instanceof Error ? squashed.message : String(squashed);
	}
	return error instanceof Error ? error.message : String(error);
};

const afterChecks = (context: RunState, round: CheckRound): Next => {
	const next = { ...context, checks: [...context.checks, round] };
	if (checksPassed(round)) {
		return {
			target: 'route',
			context: { ...next, round: next.round + 1, checkFixAttempts: 0 }
		};
	}
	return next.checkFixAttempts < next.config.caps.checkFixAttempts
		? { target: 'fixChecks', context: next }
		: escalate(next, 'check-fix-cap');
};

const afterBaseline = (context: RunState, round: CheckRound): Next => {
	const next = { ...context, checks: [...context.checks, round] };
	if (checksPassed(round)) return { target: 'implement', context: next };
	const failing = round.results
		.filter((result) => result.exitCode !== 0)
		.map((result) => result.name);
	return fail(next, `Baseline checks failed before any change: ${failing.join(', ')}`);
};

// --- Machine ---

/**
 * The pipeline. Each working state invokes one step actor; the step reports its own
 * events and returns an outcome, and the state's `onDone` picks the next state from it.
 *
 * `baseline` and `checks` have `running` and `waiting` substates: `waiting` while a
 * check waits for its lock (see {@link isWaitingState}). A passing check pass commits
 * inside the `checks` step and pushing happens inside `pr` and `escalate`, so every state
 * is one `Step` and re-running a step on resume repeats only that step.
 */
export const pipelineMachine = setupEffect({
	schemas: {
		input: RunState,
		context: RunState,
		events: {
			cancel: Schema.Struct({}),
			'lock.waiting': Schema.Struct({}),
			'lock.acquired': Schema.Struct({}),
			'checks.done': Schema.Struct({ outcome: stepOutcome(CheckRound) })
		}
	},
	actors: {
		baseline: checksLogic(baselineStep),
		checks: checksLogic(checksStep),
		implement: step(implementStep),
		fixChecks: step(fixChecksStep),
		route: step(routeStep),
		review: step((state) => reviewStep(state, planIntent(state))),
		verify: step((state) => verifyStep(state, planIntent(state))),
		triage: step(triageStep),
		fix: step(fixStep),
		escalate: step(escalateStep),
		pr: step(prStep)
	}
}).createMachine({
	id: 'pipeline',
	context: ({ input }) => input,
	initial: 'baseline',
	on: { cancel: { target: '.cancelled' } },
	states: {
		baseline: {
			invoke: { src: 'baseline', input: stepInput, onError: onDefect },
			initial: 'running',
			states: {
				running: { on: { 'lock.waiting': { target: 'waiting' } } },
				waiting: { on: { 'lock.acquired': { target: 'running' } } }
			},
			on: {
				'checks.done': ({ context, event }) => settle(context, event.outcome, afterBaseline)
			}
		},
		implement: {
			invoke: {
				src: 'implement',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, commitSubject) => ({
						target: 'checks',
						context: commitSubject === null ? next : { ...next, commitSubject }
					})),
				onError: onDefect
			}
		},
		checks: {
			invoke: { src: 'checks', input: stepInput, onError: onDefect },
			initial: 'running',
			states: {
				running: { on: { 'lock.waiting': { target: 'waiting' } } },
				waiting: { on: { 'lock.acquired': { target: 'running' } } }
			},
			on: {
				'checks.done': ({ context, event }) => settle(context, event.outcome, afterChecks)
			}
		},
		fixChecks: {
			invoke: {
				src: 'fixChecks',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next) => ({
						target: 'checks',
						context: { ...next, checkFixAttempts: next.checkFixAttempts + 1 }
					})),
				onError: onDefect
			}
		},
		route: {
			invoke: {
				src: 'route',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, review) => ({
						target: 'review',
						context: startRound(next, review)
					})),
				onError: onDefect
			}
		},
		review: {
			invoke: {
				src: 'review',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, findings) => ({
						target: 'verify',
						context: withFindings(next, findings)
					})),
				onError: onDefect
			}
		},
		verify: {
			invoke: {
				src: 'verify',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, verified) => {
						const completed = completeRound(next, verified);
						return completed === null
							? fail(next, 'No review round is in progress')
							: { target: 'triage', context: completed };
					}),
				onError: onDefect
			}
		},
		triage: {
			invoke: {
				src: 'triage',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, { unresolved, next: decision }) => {
						const triaged = { ...next, unresolved };
						return TriageNext.$match(decision, {
							pr: (): Next => ({ target: 'pr', context: triaged }),
							fix: (): Next => ({
								target: 'fix',
								context: { ...triaged, checkFixAttempts: 0 }
							}),
							escalate: ({ reason }) => escalate(triaged, reason)
						});
					}),
				onError: onDefect
			}
		},
		fix: {
			invoke: {
				src: 'fix',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next) => ({ target: 'checks', context: next })),
				onError: onDefect
			}
		},
		escalate: {
			invoke: {
				src: 'escalate',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, prUrl) => ({
						target: 'escalated',
						context: { ...next, prUrl }
					})),
				onError: onDefect
			}
		},
		pr: {
			invoke: {
				src: 'pr',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, prUrl) => ({
						target: 'done',
						context: { ...next, prUrl }
					})),
				onError: onDefect
			}
		},
		done: { type: 'final' },
		escalated: { type: 'final' },
		failed: { type: 'final' },
		cancelled: { type: 'final' }
	}
});

export type PipelineMachine = typeof pipelineMachine;

/** Whether the machine is waiting for a check lock, given its state path. */
export const isWaitingState = (path: string): boolean =>
	path === 'baseline.waiting' || path === 'checks.waiting';
