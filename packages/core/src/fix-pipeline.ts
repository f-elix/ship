/**
 * The `ship fix` machine: the fix agent works through a PR's findings in the caller's
 * checkout, the checks run (or, with `--no-checks`, the work is committed as it is), and
 * the commits are pushed to the PR's branch unless the run is `--local`.
 */
import { createEffectEventStreamLogic, createEffectLogic, setupEffect } from '@xstate/effect';
import { Effect, Schema } from 'effect';
import { ChecksOutput, checksPrimitive } from './check-primitives.ts';
import { withCheckpointScope } from './checkpoint.ts';
import { fixPrimitive } from './implementer.ts';
import { addCost, checksEvents, fail, machineKit, stepInput, type Next } from './machine-kit.ts';
import { commitPrimitive, pushPrimitive } from './pr-branch.ts';
import { FixRunState } from './pr-run.ts';
import type { PrimitiveScope } from './primitive-scope.ts';
import { invokePrimitive } from './primitive.ts';
import { stepOutcome, type StepOutcome } from './run-step.ts';

/** The message of the commit a fix run makes. */
export const FIX_COMMIT_MESSAGE = 'Address review findings';

/** The checks of a fix run belong to the review round its findings came from. */
const ROUND = 1;

const scopeOf = (state: FixRunState): PrimitiveScope => ({
	runId: state.runId,
	projectKey: state.projectKey,
	cwd: state.cwd,
	env: state.env,
	baseSha: state.baseSha,
	config: state.config
});

/** No plan: the findings say what to do. The session is the one `fix` started. */
const implementerScope = (state: FixRunState) => ({
	...scopeOf(state),
	planDir: null,
	session: state.implementerSession
});

const step = <A, R>(run: (state: FixRunState) => Effect.Effect<StepOutcome<A>, never, R>) =>
	createEffectLogic({ schemas: { input: FixRunState }, effect: ({ input }) => run(input) });

type FixNext = Next<FixRunState, 'checks' | 'commit' | 'push' | 'done' | 'failed'>;

/** Any failed step fails the run; it never escalates. */
const { settle, onDefect } = machineKit<FixRunState, 'failed'>({
	spend: (context, spent) => ({
		...addCost(context, spent),
		implementerSession: spent.session ?? context.implementerSession
	}),
	onFailure: (context, failure) => fail(context, failure.message)
});

/** After the work is committed: `push` unless the run keeps its commits local. */
const toPush = (context: FixRunState): FixNext =>
	context.push === null ? { target: 'done', context } : { target: 'push', context };

/** Failing checks at the cap fail the run with the commits kept local. */
const afterChecks = (context: FixRunState, output: ChecksOutput): FixNext => {
	const next = { ...context, checks: [...context.checks, ...output.passes] };
	if (output.passed) return toPush(next);
	const failing = (output.passes.at(-1)?.results ?? [])
		.filter((result) => result.exitCode !== 0)
		.map((result) => result.name);
	return fail(next, `Checks still fail after the check fixes: ${failing.join(', ')}`);
};

/**
 * The fix machine. `checks` has `running` and `waiting` substates, like the pipeline's,
 * and commits once the checks pass; `commit` replaces it with `--no-checks`. A resumed
 * `push` that already pushed does not push again.
 */
export const fixMachine = setupEffect({
	schemas: {
		input: FixRunState,
		context: FixRunState,
		events: {
			cancel: Schema.Struct({}),
			'lock.waiting': Schema.Struct({}),
			'lock.acquired': Schema.Struct({}),
			'checks.done': Schema.Struct({ outcome: stepOutcome(ChecksOutput) })
		}
	},
	actors: {
		fix: step((state) =>
			invokePrimitive(fixPrimitive, {
				...implementerScope(state),
				mustFix: state.findings.filter((finding) => finding.severity === 'must-fix'),
				nits: state.findings.filter((finding) => finding.severity === 'nit')
			})
		),
		checks: createEffectEventStreamLogic({
			schemas: { input: FixRunState },
			stream: ({ input }) =>
				checksEvents(
					withCheckpointScope('checks')(
						invokePrimitive(checksPrimitive, {
							...implementerScope(input),
							round: ROUND,
							commitMessage: FIX_COMMIT_MESSAGE,
							// A fix run has no baseline: every failing check is the fix's to fix.
							preexisting: []
						})
					)
				)
		}),
		commit: step((state) =>
			invokePrimitive(commitPrimitive, { ...scopeOf(state), message: FIX_COMMIT_MESSAGE })
		),
		push: step((state) =>
			// The machine enters `push` only when the run pushes.
			state.push === null
				? Effect.die(new Error('A --local fix run has nothing to push'))
				: withCheckpointScope('push')(
						invokePrimitive(pushPrimitive, {
							...scopeOf(state),
							pinnedSha: state.pr.headSha,
							target: state.push
						})
					)
		)
	}
}).createMachine({
	id: 'fix',
	context: ({ input }) => input,
	initial: 'fix',
	on: { cancel: { target: '.cancelled' } },
	states: {
		fix: {
			invoke: {
				src: 'fix',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next) => ({
						target: next.runChecks ? 'checks' : 'commit',
						context: next
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
		commit: {
			invoke: {
				src: 'commit',
				input: stepInput,
				onDone: ({ context, event }) => settle(context, event.output, toPush),
				onError: onDefect
			}
		},
		push: {
			invoke: {
				src: 'push',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next) => ({ target: 'done', context: next })),
				onError: onDefect
			}
		},
		done: { type: 'final' },
		failed: { type: 'final' },
		cancelled: { type: 'final' }
	}
});

/** The fix machine's type, for the driver and the services its steps require. */
export type FixMachine = typeof fixMachine;
