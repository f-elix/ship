/**
 * The machine of `ship implement`, `ship checks`, `ship pr` and `ship post`: each runs one
 * part of `ship run` on its own, picked by the run's kind.
 *
 * - `implement`: baseline, implement, then the checks, which commit; with `--no-checks`,
 *   implement and commit.
 * - `checks`: the checks on the branch's changes, fixing failing ones, then a commit of
 *   the fixes.
 * - `pr`: push the branch and open or update its PR.
 * - `post`: post a stored review on its PR.
 */
import { createEffectEventStreamLogic, createEffectLogic, setupEffect } from '@xstate/effect';
import { Effect, Schema } from 'effect';
import { baselineStep, ChecksOutput, checksStep } from './check-steps.ts';
import { withCheckpointScope } from './checkpoint.ts';
import { baselineFailures, failingChecks } from './checks.ts';
import { implementStep, planName } from './implementer.ts';
import { addCost, checksEvents, fail, machineKit, stepInput, type Next } from './machine-kit.ts';
import { postStep } from './post.ts';
import { commitStep } from './pr-branch.ts';
import { PrimitiveRunState } from './primitive-run.ts';
import { prStep } from './publish.ts';
import { stepOutcome, type StepOutcome } from './run-step.ts';
import type { StepScope } from './step-scope.ts';
import { invokeStep } from './step.ts';

/** The message of the commit `ship checks` makes of its fixes. */
export const CHECKS_COMMIT_MESSAGE = 'Fix failing checks';

const scopeOf = (state: PrimitiveRunState): StepScope => ({
	runId: state.runId,
	projectKey: state.projectKey,
	cwd: state.cwd,
	env: state.env,
	baseSha: state.baseSha,
	config: state.config
});

const implementerScope = (state: PrimitiveRunState) => ({
	...scopeOf(state),
	planDir: state.planDir,
	session: state.implementerSession
});

/** The implementer's subject, or `Implement <plan name>`; the fixes' message for `checks`. */
const commitMessage = (state: PrimitiveRunState): string =>
	state.kind === 'checks'
		? CHECKS_COMMIT_MESSAGE
		: (state.commitSubject ?? `Implement ${planName(state.planDir ?? state.cwd)}`);

/** A step that needs a field its kind always has; the handler sets it when creating the run. */
const required = <A>(value: A | null, what: string): Effect.Effect<A> =>
	value === null ? Effect.die(new Error(`This run has no ${what}`)) : Effect.succeed(value);

const step = <A, R>(run: (state: PrimitiveRunState) => Effect.Effect<StepOutcome<A>, never, R>) =>
	createEffectLogic({ schemas: { input: PrimitiveRunState }, effect: ({ input }) => run(input) });

type PrimitiveNext = Next<PrimitiveRunState, 'implement' | 'checks' | 'commit' | 'done' | 'failed'>;

/** Any failed step fails the run: these runs never escalate. */
const { settle, onDefect } = machineKit<PrimitiveRunState, 'failed'>({
	spend: (context, spent) => ({
		...addCost(context, spent),
		implementerSession: spent.session ?? context.implementerSession
	}),
	onFailure: (context, failure) => fail(context, failure.message)
});

/** The state each kind starts in. */
const firstState = (context: PrimitiveRunState) => {
	switch (context.kind) {
		case 'implement':
			return context.runChecks ? 'baseline' : 'implement';
		case 'checks':
			return 'checks';
		case 'pr':
			return 'pr';
		case 'post':
			return 'post';
	}
};

/** The run goes on after a failing baseline, as `ship run` does. */
const afterBaseline = (context: PrimitiveRunState, output: ChecksOutput): PrimitiveNext => ({
	target: 'implement',
	context: { ...context, checks: [...context.checks, ...output.passes] }
});

/** Failing checks at the cap fail the run, with the work left uncommitted. */
const afterChecks = (context: PrimitiveRunState, output: ChecksOutput): PrimitiveNext => {
	const next = { ...context, checks: [...context.checks, ...output.passes] };
	if (output.passed) return { target: 'done', context: next };
	const last = output.passes.at(-1);
	const failing = last === undefined ? [] : failingChecks(last, baselineFailures(next.checks));
	return fail(next, `Checks still fail after the check fixes: ${failing.join(', ')}`);
};

/**
 * The primitive run machine. A transient `start` picks the kind's first state. `baseline`
 * and `checks` have `running` and `waiting` substates, like the pipeline's.
 */
export const primitiveMachine = setupEffect({
	schemas: {
		input: PrimitiveRunState,
		context: PrimitiveRunState,
		events: {
			cancel: Schema.Struct({}),
			'lock.waiting': Schema.Struct({}),
			'lock.acquired': Schema.Struct({}),
			'checks.done': Schema.Struct({ outcome: stepOutcome(ChecksOutput) })
		}
	},
	actors: {
		baseline: createEffectEventStreamLogic({
			schemas: { input: PrimitiveRunState },
			stream: ({ input }) =>
				checksEvents(
					Effect.flatMap(required(input.planDir, 'plan'), (planDir) =>
						invokeStep(baselineStep, { ...scopeOf(input), planDir })
					)
				)
		}),
		implement: step((state) =>
			Effect.flatMap(required(state.planDir, 'plan'), (planDir) =>
				invokeStep(implementStep, { ...implementerScope(state), planDir })
			)
		),
		checks: createEffectEventStreamLogic({
			schemas: { input: PrimitiveRunState },
			stream: ({ input }) =>
				checksEvents(
					withCheckpointScope('checks')(
						invokeStep(checksStep, {
							...implementerScope(input),
							round: 0,
							commitMessage: commitMessage(input),
							// None for `ship checks`, which has no baseline: every failing
							// check is the branch's to fix.
							preexisting: baselineFailures(input.checks)
						})
					)
				)
		}),
		commit: step((state) =>
			invokeStep(commitStep, { ...scopeOf(state), message: commitMessage(state) })
		),
		pr: step((state) =>
			Effect.flatMap(required(state.branch, 'branch'), (branch) =>
				invokeStep(prStep, {
					...scopeOf(state),
					planDir: state.planDir,
					branch,
					squashMessage: null,
					checks: state.checks,
					unresolved: { mustFix: [], tradeoffs: [], nits: [] }
				})
			)
		),
		post: step((state) =>
			Effect.flatMap(required(state.review, 'review'), (review) =>
				withCheckpointScope('post')(invokeStep(postStep, { ...scopeOf(state), review }))
			)
		)
	}
}).createMachine({
	id: 'primitive',
	context: ({ input }) => input,
	initial: 'start',
	on: { cancel: { target: '.cancelled' } },
	states: {
		start: {
			always: ({ context }) => ({ target: firstState(context), context })
		},
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
					settle(context, event.output, (next, commitSubject) => {
						const implemented =
							commitSubject === null ? next : { ...next, commitSubject };
						return {
							target: next.runChecks ? 'checks' : 'commit',
							context: implemented
						};
					}),
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
		commit: {
			invoke: {
				src: 'commit',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next) => ({ target: 'done', context: next })),
				onError: onDefect
			}
		},
		pr: {
			invoke: {
				src: 'pr',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, url) => ({
						target: 'done',
						context: { ...next, url }
					})),
				onError: onDefect
			}
		},
		post: {
			invoke: {
				src: 'post',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, url) => ({
						target: 'done',
						context: { ...next, url }
					})),
				onError: onDefect
			}
		},
		done: { type: 'final' },
		failed: { type: 'final' },
		cancelled: { type: 'final' }
	}
});

/** The primitive run machine's type, for the driver and the services its steps require. */
export type PrimitiveMachine = typeof primitiveMachine;
