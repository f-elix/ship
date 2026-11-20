/**
 * The `ship recheck` machine: the verifier checks a PR's earlier findings against its
 * head, then the threads of the fixed ones are resolved on GitHub unless the run is
 * `--local`.
 */
import { createEffectLogic, setupEffect } from '@xstate/effect';
import { Schema, type Effect } from 'effect';
import { withCheckpointScope } from './checkpoint.ts';
import { FindingId } from './finding.ts';
import { addCost, fail, machineKit, stepInput, type Next } from './machine-kit.ts';
import { RecheckRunState } from './pr-run.ts';
import type { PrimitiveScope } from './primitive-scope.ts';
import { invokePrimitive } from './primitive.ts';
import { recheckPrimitive } from './recheck.ts';
import { resolvePrimitive, type FindingThread } from './resolve.ts';
import type { StepOutcome } from './run-step.ts';
import type { RecheckedFinding } from './run.ts';

const scopeOf = (state: RecheckRunState): PrimitiveScope => ({
	runId: state.runId,
	projectKey: state.projectKey,
	cwd: state.cwd,
	env: state.env,
	baseSha: state.baseSha,
	config: state.config
});

/** The open threads of the findings `recheck` found fixed. */
export const fixedThreads = (
	rechecked: ReadonlyArray<RecheckedFinding>,
	threads: Readonly<Record<string, string>>
): ReadonlyArray<FindingThread> =>
	rechecked.flatMap(({ finding, status }) => {
		const threadId = threads[finding.id];
		return status === 'fixed' && threadId !== undefined
			? [{ findingId: FindingId.make(finding.id), threadId }]
			: [];
	});

const step = <A, R>(run: (state: RecheckRunState) => Effect.Effect<StepOutcome<A>, never, R>) =>
	createEffectLogic({ schemas: { input: RecheckRunState }, effect: ({ input }) => run(input) });

type RecheckNext = Next<RecheckRunState, 'resolve' | 'done' | 'failed'>;

/** Any failed step fails the run; it never escalates. */
const { settle, onDefect } = machineKit<RecheckRunState, 'failed'>({
	spend: addCost,
	onFailure: (context, failure) => fail(context, failure.message)
});

/** After `recheck`: `resolve` when the run resolves threads and a fixed finding has one. */
const afterRecheck = (
	context: RecheckRunState,
	rechecked: ReadonlyArray<RecheckedFinding>
): RecheckNext => {
	const next = { ...context, rechecked };
	return next.resolve && fixedThreads(rechecked, next.threads).length > 0
		? { target: 'resolve', context: next }
		: { target: 'done', context: next };
};

/**
 * The recheck machine. A resumed `recheck` takes its checkpointed verdicts, and a resumed
 * `resolve` skips the threads it already resolved.
 */
export const recheckMachine = setupEffect({
	schemas: {
		input: RecheckRunState,
		context: RecheckRunState,
		events: { cancel: Schema.Struct({}) }
	},
	actors: {
		recheck: step((state) =>
			withCheckpointScope('recheck')(
				invokePrimitive(recheckPrimitive, {
					...scopeOf(state),
					intent: state.intent,
					findings: state.findings
				})
			)
		),
		resolve: step((state) =>
			withCheckpointScope('resolve')(
				invokePrimitive(resolvePrimitive, {
					...scopeOf(state),
					prUrl: state.pr.url,
					headSha: state.pr.headSha,
					threads: fixedThreads(state.rechecked ?? [], state.threads)
				})
			)
		)
	}
}).createMachine({
	id: 'recheck',
	context: ({ input }) => input,
	initial: 'recheck',
	on: { cancel: { target: '.cancelled' } },
	states: {
		recheck: {
			invoke: {
				src: 'recheck',
				input: stepInput,
				onDone: ({ context, event }) => settle(context, event.output, afterRecheck),
				onError: onDefect
			}
		},
		resolve: {
			invoke: {
				src: 'resolve',
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

/** The recheck machine's type, for the driver and the services its steps require. */
export type RecheckMachine = typeof recheckMachine;
