/**
 * The `ship run` machine: baseline, implement, checks, review, then fix, checks and review
 * again until triage opens the PR or escalates. Each working state invokes one step
 * (triage is the one pure state), so re-running a state on resume repeats only that
 * step, and the step's checkpoints skip what it already finished.
 */
import { createEffectEventStreamLogic, createEffectLogic, setupEffect } from '@xstate/effect';
import { Schema, type Effect } from 'effect';
import { baselineStep, ChecksOutput, checksStep } from './check-steps.ts';
import { withCheckpointScope } from './checkpoint.ts';
import { baselineFailures } from './checks.ts';
import { fixStep, implementStep, planIntent, planName } from './implementer.ts';
import {
	addCost,
	checksEvents,
	escalate,
	fail,
	machineKit,
	stepInput,
	type Next
} from './machine-kit.ts';
import { escalateStep, prStep, type PrInput } from './publish.ts';
import { reviewStep } from './review-step.ts';
import { stepOutcome, type StepOutcome } from './run-step.ts';
import { RunState, type ReviewRound } from './run.ts';
import type { StepScope } from './step-scope.ts';
import { invokeStep } from './step.ts';
import { TriageNext, triageStep } from './triage.ts';

// --- Context to step inputs ---

/** The step scope of the run's context. */
const scopeOf = (state: RunState): StepScope => ({
	runId: state.runId,
	projectKey: state.projectKey,
	cwd: state.cwd,
	env: state.env,
	baseSha: state.baseSha,
	config: state.config
});

/**
 * The message of the round's commit, and of the single commit a squash leaves. Round 0
 * uses the implementer's subject, or `Implement <plan name>` when it gave none.
 */
export const commitMessage = (state: RunState): string =>
	state.round === 0
		? (state.commitSubject ?? `Implement ${planName(state.planDir)}`)
		: `Address review round ${state.round} findings`;

const implementerScope = (state: RunState) => ({
	...scopeOf(state),
	planDir: state.planDir,
	session: state.implementerSession
});

const prInput = (state: RunState): PrInput => ({
	...scopeOf(state),
	planDir: state.planDir,
	branch: state.branch,
	squashMessage: commitMessage({ ...state, round: 0 }),
	checks: state.checks,
	unresolved: state.unresolved
});

/**
 * The round's review. After the first round it follows up on the fix: the verifier checks
 * the must-fix findings and nits the fix was given, and routing looks at the fix commits.
 */
const reviewInput = (state: RunState) => ({
	...scopeOf(state),
	round: state.round,
	intent: planIntent(state.planDir),
	followUp:
		state.lastReviewedSha === null
			? null
			: {
					previous: [...state.unresolved.mustFix, ...state.unresolved.nits],
					knownTradeoffs: state.unresolved.tradeoffs,
					routedFromSha: state.lastReviewedSha
				}
});

/**
 * Wraps a state's step invocation so its checkpoints are keyed under the state and the
 * round: each loop iteration gets its own keys.
 */
const inState = (state: string, round: number) => withCheckpointScope(`${state}:${round}`);

// --- Step actors ---

const step = <A, R>(run: (state: RunState) => Effect.Effect<StepOutcome<A>, never, R>) =>
	createEffectLogic({ schemas: { input: RunState }, effect: ({ input }) => run(input) });

const checksLogic = <R>(
	run: (state: RunState) => Effect.Effect<StepOutcome<ChecksOutput>, never, R>
) =>
	createEffectEventStreamLogic({
		schemas: { input: RunState },
		stream: ({ input }) => checksEvents(run(input))
	});

// --- Transitions ---

type Settled =
	| 'implement'
	| 'checks'
	| 'review'
	| 'triage'
	| 'fix'
	| 'escalate'
	| 'pr'
	| 'done'
	| 'escalated'
	| 'failed';

type PipelineNext = Next<RunState, Settled>;

/**
 * A failed step fails the run, except a timeout after the run committed work, which
 * escalates so the work still ends up in a draft PR. A failing `escalate` always fails the
 * run, so escalation cannot loop.
 */
const { settle, onDefect } = machineKit<RunState, 'escalate' | 'failed'>({
	spend: (context, spent) => ({
		...addCost(context, spent),
		implementerSession: spent.session ?? context.implementerSession
	}),
	onFailure: (context, failure) =>
		failure.timedOut && failure.hasCommits && failure.step !== 'escalate'
			? escalate(context, 'timeout')
			: fail(context, failure.message)
});

/** The run goes on after a failing baseline: the checks hold the change only to the rest. */
const afterBaseline = (context: RunState, output: ChecksOutput): PipelineNext => ({
	target: 'implement',
	context: { ...context, checks: [...context.checks, ...output.passes] }
});

const afterChecks = (context: RunState, output: ChecksOutput): PipelineNext => {
	const next = { ...context, checks: [...context.checks, ...output.passes] };
	if (output.passed) return { target: 'review', context: { ...next, round: next.round + 1 } };
	return escalate(next, output.unrelated ? 'checks-unrelated' : 'check-fix-cap');
};

/** The context once a review closed its round; the next round routes from its head. */
const completeRound = (context: RunState, round: ReviewRound): RunState => ({
	...context,
	lastReviewedSha: round.toSha,
	reviewRounds: [...context.reviewRounds, round]
});

// --- Machine ---

/**
 * The pipeline. Each working state invokes one step actor, which maps the context to its
 * step's input and returns the outcome; the state's `onDone` picks the next state.
 *
 * `baseline` and `checks` have `running` and `waiting` substates: `waiting` while a
 * check waits for its lock (see {@link isWaitingState}). A passing check pass commits
 * inside `checks`, and pushing happens inside `pr` and `escalate`.
 */
export const pipelineMachine = setupEffect({
	schemas: {
		input: RunState,
		context: RunState,
		events: {
			cancel: Schema.Struct({}),
			'lock.waiting': Schema.Struct({}),
			'lock.acquired': Schema.Struct({}),
			'checks.done': Schema.Struct({ outcome: stepOutcome(ChecksOutput) })
		}
	},
	actors: {
		baseline: checksLogic((state) =>
			invokeStep(baselineStep, { ...scopeOf(state), planDir: state.planDir })
		),
		implement: step((state) => invokeStep(implementStep, implementerScope(state))),
		checks: checksLogic((state) =>
			inState(
				'checks',
				state.round
			)(
				invokeStep(checksStep, {
					...implementerScope(state),
					round: state.round,
					commitMessage: commitMessage(state),
					preexisting: baselineFailures(state.checks)
				})
			)
		),
		review: step((state) =>
			inState('review', state.round)(invokeStep(reviewStep, reviewInput(state)))
		),
		triage: step(triageStep),
		fix: step((state) =>
			invokeStep(fixStep, {
				...implementerScope(state),
				mustFix: state.unresolved.mustFix,
				nits: state.unresolved.nits
			})
		),
		escalate: step((state) =>
			invokeStep(escalateStep, {
				...prInput(state),
				reason: state.escalationReason
			})
		),
		pr: step((state) => invokeStep(prStep, prInput(state)))
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
		review: {
			invoke: {
				src: 'review',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, round) => ({
						target: 'triage',
						context: completeRound(next, round)
					})),
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
							pr: (): PipelineNext => ({ target: 'pr', context: triaged }),
							fix: (): PipelineNext => ({ target: 'fix', context: triaged }),
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
