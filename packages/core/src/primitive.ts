/**
 * The primitive contract. A primitive is one of ship's steps as a typed Effect: its input
 * holds everything it reads, so a pipeline state, a test or a later command can call it
 * the same way. Pipelines invoke primitives through {@link invokePrimitive}, which reports
 * the step and turns its errors into an outcome the machine settles.
 *
 * A primitive that keeps sub-work in `Checkpoint.once` makes that value's schema part of
 * the stored run format: changing it requires bumping `SNAPSHOT_VERSION`.
 */
import type { Effect, Schema } from 'effect';
import type { ResolvedConfig } from './config.ts';
import type { PrimitiveScope } from './primitive-scope.ts';
import type { Step } from './primitives.ts';
import { runStep, type StepError, type StepKit } from './run-step.ts';

/** One of ship's steps as a typed Effect. */
export interface Primitive<I extends PrimitiveScope, O, R> {
	/** The step it reports as, in `StepStarted`, `StepEnded` and its failures. */
	readonly name: Step;
	readonly input: Schema.Schema<I>;
	readonly output: Schema.Schema<O>;
	/**
	 * The limit for the whole call, or `null` when its own calls have their limits, e.g.
	 * a primitive that waits for a check lock or runs several agent calls.
	 */
	readonly timeoutMs: (config: ResolvedConfig) => number | null;
	/** Does the work; `kit` reports events and records what it spends. */
	readonly run: (input: I, kit: StepKit) => Effect.Effect<O, StepError, R>;
}

/**
 * Runs `primitive` on `input` as a step: reports `StepStarted` and `StepEnded`, applies its
 * timeout, and returns its outcome with what it spent. See `runStep`.
 */
export const invokePrimitive = <I extends PrimitiveScope, O, R>(
	primitive: Primitive<I, O, R>,
	input: I
) =>
	runStep(primitive.name, input, { timeoutMs: primitive.timeoutMs(input.config) }, (kit) =>
		primitive.run(input, kit)
	);
