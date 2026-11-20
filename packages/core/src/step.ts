/**
 * The step contract. A step is one unit of ship's work as a typed Effect: its input
 * holds everything it reads, so a pipeline state, a test or a later command can call it
 * the same way. Pipelines invoke steps through {@link invokeStep}, which reports
 * the step and turns its errors into an outcome the machine settles.
 *
 * A step that keeps sub-work in `Checkpoint.once` makes that value's schema part of
 * the stored run format: changing it requires bumping `SNAPSHOT_VERSION`.
 */
import type { Effect, Schema } from 'effect';
import type { ResolvedConfig } from './config.ts';
import { runStep, type StepError, type StepKit } from './run-step.ts';
import type { StepScope } from './step-scope.ts';
import type { StepName } from './values.ts';

/** One of ship's steps as a typed Effect. */
export interface Step<I extends StepScope, O, R> {
	/** The step it reports as, in `StepStarted`, `StepEnded` and its failures. */
	readonly name: StepName;
	readonly input: Schema.Schema<I>;
	readonly output: Schema.Schema<O>;
	/**
	 * The limit for the whole call, or `null` when its own calls have their limits, e.g.
	 * a step that waits for a check lock or runs several agent calls.
	 */
	readonly timeoutMs: (config: ResolvedConfig) => number | null;
	/** Does the work; `kit` reports events and records what it spends. */
	readonly run: (input: I, kit: StepKit) => Effect.Effect<O, StepError, R>;
}

/**
 * Runs `step` on `input`: reports `StepStarted` and `StepEnded`, applies its
 * timeout, and returns its outcome with what it spent. See `runStep`.
 */
export const invokeStep = <I extends StepScope, O, R>(step: Step<I, O, R>, input: I) =>
	runStep(step.name, input, { timeoutMs: step.timeoutMs(input.config) }, (kit) =>
		step.run(input, kit)
	);
