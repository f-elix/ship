import {
	InvalidRunStatus,
	type PipelineServices,
	type RunHandle,
	type RunId,
	type RunJournal
} from '@ship/core';
import { RunStore } from '@ship/store';
import { Cause, Context, Deferred, Effect, Exit, FiberMap, Layer, type Scope } from 'effect';

/** What a run's machine needs while it runs. */
export type RunServices = PipelineServices | RunJournal;

export interface RunHostShape {
	/**
	 * Runs `start` (`startRun` or `resumeRun`) in the background, in a scope of its own that
	 * lasts until the run ends or the host stops. Returns once the run started, so a failure
	 * to start reaches the caller. Fails with `InvalidRunStatus` (`running`) when the run is
	 * claimed here already. A run left `running` without a machine, because it failed to start
	 * or its machine stopped without finishing it (a defect), is marked `interrupted`.
	 */
	readonly launch: <E>(
		runId: RunId,
		start: Effect.Effect<RunHandle, E, RunServices | Scope.Scope>
	) => Effect.Effect<void, E | InvalidRunStatus>;
	/**
	 * Runs `effect` on a run no machine runs, holding the run's claim meanwhile so it cannot
	 * be launched (`active` waits for it). Returns `false`, without running it, when the run
	 * is claimed already or the host shut down.
	 */
	readonly exclusive: <A, E, R>(
		runId: RunId,
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<boolean, E, R>;
	/**
	 * The run's handle while its machine runs in this daemon, else `undefined`. Waits for a
	 * run that is still starting, and for an `exclusive` effect on it to end.
	 */
	readonly active: (runId: RunId) => Effect.Effect<RunHandle | undefined>;
	/** Whether runs are still launched: until `shutdown`. */
	readonly accepting: Effect.Effect<boolean>;
	/** Runs claimed in this daemon: starting, running or being finished from their log. */
	readonly activeCount: Effect.Effect<number>;
	/**
	 * Stops taking runs (`launch` is interrupted from then on), then interrupts every run and
	 * waits for each to save what it got to. The runs are left `running` in the store, for the
	 * caller to mark `interrupted`.
	 */
	readonly shutdown: Effect.Effect<void>;
}

/** Hosts the daemon's runs: each one's fiber, scope and handle. */
export class RunHost extends Context.Service<RunHost, RunHostShape>()('@ship/daemon/RunHost') {
	static readonly layer: Layer.Layer<RunHost, never, RunServices | RunStore> = Layer.effect(
		this,
		Effect.gen(function* () {
			const services = yield* Effect.context<RunServices>();
			const store = yield* RunStore;
			const fibers = yield* FiberMap.make<RunId>();
			/**
			 * Every claimed run, with an effect that waits for its handle: `undefined`, once the
			 * claim is released, when the run failed to start or has no machine. Claiming is
			 * synchronous, so two claims of one run never race. None are taken once the host
			 * shuts down.
			 */
			const claims = new Map<RunId, Effect.Effect<RunHandle | undefined>>();
			let closing = false;
			/** Claims the run; `released` is a waiter for the claim's end. */
			const claim = (
				runId: RunId,
				handle: (released: Effect.Effect<undefined>) => Effect.Effect<RunHandle | undefined>
			) =>
				Effect.flatMap(Deferred.make<void>(), (done) =>
					Effect.sync(() => {
						if (closing || claims.has(runId)) return undefined;
						claims.set(runId, handle(Effect.as(Deferred.await(done), undefined)));
						return Effect.sync(() => claims.delete(runId)).pipe(
							Effect.andThen(Deferred.succeed(done, undefined))
						);
					})
				);

			/** Waits for the run to end; one its machine could not finish is marked interrupted. */
			const awaitEnd = (runId: RunId, handle: RunHandle) =>
				handle.await.pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.void
							: Effect.logError(`Run ${runId} stopped without finishing`, cause).pipe(
									Effect.andThen(store.interrupt(runId)),
									Effect.ignore({ log: true })
								)
					)
				);

			const launch = Effect.fn('RunHost.launch')(function* <E>(
				runId: RunId,
				start: Effect.Effect<RunHandle, E, RunServices | Scope.Scope>
			) {
				const started = yield* Deferred.make<RunHandle, E>();
				const run = (release: Effect.Effect<void>) =>
					Effect.gen(function* () {
						const exit = yield* Effect.exit(start);
						if (Exit.isFailure(exit)) {
							// `resumeRun` may have set it `running` before failing. Marked before the
							// caller hears of the failure, so the caller reads the end state.
							yield* store.interrupt(runId).pipe(Effect.ignore);
						}
						yield* Deferred.done(started, exit);
						if (Exit.isSuccess(exit)) yield* awaitEnd(runId, exit.value);
					}).pipe(
						Effect.scoped,
						// Interrupted while starting (the daemon stops): the caller stops waiting.
						Effect.onInterrupt(() => Deferred.interrupt(started)),
						Effect.ensuring(release),
						Effect.provide(services)
					);
				// Claimed and forked as one step, so the claim is always released.
				const claimed = yield* Effect.uninterruptible(
					Effect.flatMap(
						claim(runId, (released) =>
							Deferred.await(started).pipe(Effect.catchCause(() => released))
						),
						(release) =>
							release === undefined
								? Effect.succeed(false)
								: // The run itself stays interruptible.
									Effect.as(
										FiberMap.run(
											fibers,
											runId,
											Effect.interruptible(run(release))
										),
										true
									)
					)
				);
				if (!claimed) {
					if (closing) return yield* Effect.interrupt;
					return yield* new InvalidRunStatus({ runId, status: 'running' });
				}
				yield* Deferred.await(started);
			});

			const exclusive = <A, E, R>(runId: RunId, effect: Effect.Effect<A, E, R>) =>
				Effect.uninterruptibleMask((restore) =>
					Effect.flatMap(
						claim(runId, (released) => released),
						(release) =>
							release === undefined
								? Effect.succeed(false)
								: restore(effect).pipe(Effect.as(true), Effect.ensuring(release))
					)
				);

			return RunHost.of({
				launch,
				exclusive,
				active: (runId) =>
					Effect.suspend(() => claims.get(runId) ?? Effect.succeed(undefined)),
				accepting: Effect.sync(() => !closing),
				activeCount: Effect.sync(() => claims.size),
				shutdown: Effect.suspend(() => {
					closing = true;
					return FiberMap.clear(fibers);
				})
			});
		})
	);
}
