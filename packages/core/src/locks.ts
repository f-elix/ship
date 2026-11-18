import { Clock, Context, Data, Deferred, Effect, Layer, Schema } from 'effect';

/** What happens to one holder of a lock resource, in order: maybe `Waiting`, `Acquired`, `Released`. */
export type LockEvent = Data.TaggedEnum<{
	/** No permit was free. `position` is the 1-based place in the resource's queue. */
	Waiting: { readonly resource: string; readonly position: number };
	Acquired: { readonly resource: string; readonly waitedMs: number };
	Released: { readonly resource: string };
}>;
export const LockEvent = Data.taggedEnum<LockEvent>();

/** The resource has no permits configured. */
export class UnknownLockResource extends Schema.TaggedError<UnknownLockResource>()(
	'UnknownLockResource',
	{ resource: Schema.String }
) {}

export interface LockStatus {
	readonly permits: number;
	readonly available: number;
	readonly waiting: number;
}

export interface LocksShape {
	/**
	 * Runs `effect` while holding one permit of `resource`. Waiters get permits in arrival
	 * order. Interrupting a waiter removes it from the queue; the permit is released when
	 * `effect` ends, however it ends. `onEvent` sees each step as it happens.
	 */
	readonly withPermit: <A, E, R>(
		resource: string,
		effect: Effect.Effect<A, E, R>,
		options?: { readonly onEvent?: (event: LockEvent) => Effect.Effect<void> }
	) => Effect.Effect<A, E | UnknownLockResource, R>;
	readonly status: (resource: string) => Effect.Effect<LockStatus, UnknownLockResource>;
}

interface Waiter {
	readonly granted: Deferred.Deferred<void>;
	/** Set when a release handed this waiter a permit. */
	hasPermit: boolean;
}

interface Resource {
	readonly permits: number;
	available: number;
	readonly queue: Array<Waiter>;
}

const make = (permits: Readonly<Record<string, number>>) =>
	Effect.sync(() => {
		const resources = new Map<string, Resource>(
			Object.entries(permits).map(([name, count]) => [
				name,
				{ permits: count, available: count, queue: [] }
			])
		);

		const lookup = (resource: string) => {
			const found = resources.get(resource);
			return found === undefined
				? Effect.fail(new UnknownLockResource({ resource }))
				: Effect.succeed(found);
		};

		// The permit goes straight to the next waiter, so no newcomer can overtake the queue.
		const release = (state: Resource) => {
			const next = state.queue.shift();
			if (next === undefined) {
				state.available += 1;
				return;
			}
			next.hasPermit = true;
			Deferred.doneUnsafe(next.granted, Effect.void);
		};

		const leaveQueue = (state: Resource, waiter: Waiter) => {
			if (waiter.hasPermit) release(state);
			else state.queue.splice(state.queue.indexOf(waiter), 1);
		};

		const withPermit: LocksShape['withPermit'] = (resource, effect, options) => {
			const emit = options?.onEvent ?? (() => Effect.void);
			return Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const state = yield* lookup(resource);
					const startedAt = yield* Clock.currentTimeMillis;
					if (state.available > 0 && state.queue.length === 0) {
						state.available -= 1;
					} else {
						const waiter: Waiter = { granted: Deferred.makeUnsafe(), hasPermit: false };
						state.queue.push(waiter);
						const position = state.queue.length;
						yield* restore(
							Effect.andThen(
								emit(LockEvent.Waiting({ resource, position })),
								Deferred.await(waiter.granted)
							)
						).pipe(
							Effect.onInterrupt(() => Effect.sync(() => leaveQueue(state, waiter)))
						);
					}
					const waitedMs = (yield* Clock.currentTimeMillis) - startedAt;
					return yield* restore(
						Effect.andThen(emit(LockEvent.Acquired({ resource, waitedMs })), effect)
					).pipe(
						// Reported before the hand-off, so the log shows the release before the next acquire.
						Effect.ensuring(
							emit(LockEvent.Released({ resource })).pipe(
								Effect.ensuring(Effect.sync(() => release(state)))
							)
						)
					);
				})
			).pipe(Effect.withSpan('Locks.withPermit', { attributes: { resource } }));
		};

		const status = Effect.fn('Locks.status')(function* (resource: string) {
			const state = yield* lookup(resource);
			return {
				permits: state.permits,
				available: state.available,
				waiting: state.queue.length
			};
		});

		return Locks.of({ withPermit, status });
	});

/**
 * One FIFO semaphore per lock resource, shared by every run in the daemon. Only check
 * execution takes a permit; agent work never does.
 */
export class Locks extends Context.Service<Locks, LocksShape>()('@ship/core/Locks') {
	/** Semaphores with the given permits per resource, e.g. the global config's `locks`. */
	static readonly layer = (permits: Readonly<Record<string, number>>) =>
		Layer.effect(this, make(permits));
}
