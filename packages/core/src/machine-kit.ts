/**
 * What both pipeline machines share: how a step's outcome settles into the next state,
 * how a defect fails the run, and how a check step's lock waits reach the machine.
 * Each machine passes its own policy for spending and failures.
 */
import { EffectFailure } from '@xstate/effect';
import { Cause, Effect, Queue, Stream } from 'effect';
import type { ChecksOutput } from './check-steps.ts';
import type { AppendableEvent } from './run-journal.ts';
import { RunReporter, type StepFailure, type StepOutcome, type StepSpend } from './run-step.ts';
import type { EscalationReason } from './run.ts';

/**
 * Every step actor gets the run's context as its input, in both machines, and maps it to
 * its step's input itself. The driver relies on this when it restarts a step that
 * finished before the machine took its result.
 */
export const stepInput = <C>({ context }: { readonly context: C }): C => context;

/** The message of a step actor's or the machine's unexpected error. */
export const describeDefect = (error: unknown): string => {
	const cause = EffectFailure.is(error) ? error.cause : null;
	if (cause !== null) {
		const squashed = Cause.squash(cause);
		return squashed instanceof Error ? squashed.message : String(squashed);
	}
	return error instanceof Error ? error.message : String(error);
};

/** What the kit reads and writes of a machine's context. */
export interface KitContext {
	/** Running cost for display while the run is live. */
	readonly costUsd: number;
	/** Why the run failed; set only when it ends `failed`. */
	readonly error: string | null;
}

/** A transition's result: the next state and the context it starts with. */
export interface Next<C, T extends string> {
	readonly target: T;
	readonly context: C;
}

/** Fails the run with `error`. */
export const fail = <C extends KitContext>(context: C, error: string): Next<C, 'failed'> => ({
	target: 'failed',
	context: { ...context, error }
});

/** Moves to `escalate`, which publishes the work as a draft PR that gives `reason`. */
export const escalate = <C extends { readonly escalationReason: EscalationReason | null }>(
	context: C,
	reason: EscalationReason
): Next<C, 'escalate'> => ({
	target: 'escalate',
	context: { ...context, escalationReason: reason }
});

/** Adds a step's cost to the context; the default way to take what a step spent. */
export const addCost = <C extends KitContext>(context: C, spent: StepSpend): C => ({
	...context,
	costUsd: context.costUsd + spent.costUsd
});

/** How a machine takes what its steps spent and where their failures lead. */
export interface MachinePolicy<C extends KitContext, T extends string> {
	readonly spend: (context: C, spent: StepSpend) => C;
	readonly onFailure: (context: C, failure: StepFailure) => Next<C, T>;
}

/**
 * The transitions a machine builds its states from, under `policy`:
 *
 * - `settle` takes a step's outcome: what it spent always joins the context, then an
 *   `Ok` goes to `onOk` and a failure to `policy.onFailure`;
 * - `onDefect` fails the run on an error no step expects.
 */
export const machineKit = <C extends KitContext, T extends string>(
	policy: MachinePolicy<C, T>
) => ({
	settle: <A, U extends string>(
		context: C,
		outcome: StepOutcome<A>,
		onOk: (context: C, output: A) => Next<C, U>
	): Next<C, T | U> => {
		const spent = policy.spend(context, outcome.spent);
		return outcome._tag === 'Ok'
			? onOk(spent, outcome.output)
			: policy.onFailure(spent, outcome.failure);
	},
	onDefect: ({
		context,
		event
	}: {
		readonly context: C;
		readonly event: { readonly error: unknown };
	}): Next<C, 'failed'> => fail(context, describeDefect(event.error))
});

// --- Check steps as events ---

/** What a check step's stream actor sends its machine: lock waits, then the outcome. */
export type ChecksEvent =
	| { readonly type: 'lock.waiting' }
	| { readonly type: 'lock.acquired' }
	| { readonly type: 'checks.done'; readonly outcome: StepOutcome<ChecksOutput> };

/**
 * Runs a check step's invocation as a stream of {@link ChecksEvent}s: every event it
 * reports still goes to the run's reporter, and its lock waits also reach the machine, so
 * it can show the run as waiting.
 */
export const checksEvents = <R>(
	invocation: Effect.Effect<StepOutcome<ChecksOutput>, never, R>
): Stream.Stream<ChecksEvent, never, R | RunReporter> =>
	Stream.callback<ChecksEvent, never, R | RunReporter>((queue) =>
		Effect.gen(function* () {
			const reporter = yield* RunReporter;
			const signal = (event: AppendableEvent) =>
				event._tag === 'LockWaiting'
					? Queue.offer(queue, { type: 'lock.waiting' })
					: event._tag === 'LockAcquired'
						? Queue.offer(queue, { type: 'lock.acquired' })
						: Effect.void;
			const outcome = yield* Effect.provideService(
				invocation,
				RunReporter,
				RunReporter.of({
					report: (event) => Effect.andThen(reporter.report(event), signal(event))
				})
			);
			yield* Queue.offer(queue, { type: 'checks.done', outcome });
			yield* Queue.end(queue);
		})
	);
