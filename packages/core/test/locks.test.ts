import { assert, describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Queue } from 'effect';
import { TestClock } from 'effect/testing';
import { LockEvent, Locks, UnknownLockResource } from '../src/index.ts';

const LocksLayer = Locks.layer({ cpu: 1, db: 2 });

/** Takes a permit and holds it until `release` completes, reporting events to `events`. */
const holder = (
	name: string,
	resource: string,
	release: Deferred.Deferred<void>,
	events: Queue.Queue<readonly [string, LockEvent]>
) =>
	Effect.gen(function* () {
		const locks = yield* Locks;
		return yield* locks.withPermit(
			resource,
			Effect.andThen(Deferred.await(release), Effect.succeed(name)),
			{ onEvent: (event) => Queue.offer(events, [name, event]).pipe(Effect.asVoid) }
		);
	}).pipe(Effect.forkChild);

/** Waits for the next event and returns it as `name:tag`. */
const nextEvent = (events: Queue.Queue<readonly [string, LockEvent]>) =>
	Effect.map(Queue.take(events), ([name, event]) => `${name}:${event._tag}`);

const eventsQueue = Queue.unbounded<readonly [string, LockEvent]>();

describe('Locks', () => {
	it.effect('hands permits to waiters in arrival order and reports queue positions', () =>
		Effect.gen(function* () {
			const locks = yield* Locks;
			const events = yield* eventsQueue;
			const release = yield* Deferred.make<void>();
			const releaseAll = yield* Deferred.make<void>();

			const a = yield* holder('a', 'cpu', release, events);
			expect(yield* nextEvent(events)).toBe('a:Acquired');
			const waiters = [];
			for (const name of ['b', 'c', 'd']) {
				waiters.push(yield* holder(name, 'cpu', releaseAll, events));
				const [, waiting] = yield* Queue.take(events);
				assert(waiting._tag === 'Waiting');
				expect(waiting.position).toBe(waiters.length);
			}
			expect(yield* locks.status('cpu')).toEqual({ permits: 1, available: 0, waiting: 3 });

			yield* Deferred.succeed(release, undefined);
			yield* Deferred.succeed(releaseAll, undefined);
			expect(yield* Fiber.join(a)).toBe('a');
			const order = [];
			for (let i = 0; i < 7; i += 1) order.push(yield* nextEvent(events));
			expect(order).toEqual([
				'a:Released',
				'b:Acquired',
				'b:Released',
				'c:Acquired',
				'c:Released',
				'd:Acquired',
				'd:Released'
			]);
			yield* Fiber.joinAll(waiters);
			expect(yield* locks.status('cpu')).toEqual({ permits: 1, available: 1, waiting: 0 });
		}).pipe(Effect.provide(LocksLayer))
	);

	it.effect('lets as many holders in as there are permits', () =>
		Effect.gen(function* () {
			const locks = yield* Locks;
			const events = yield* eventsQueue;
			const release = yield* Deferred.make<void>();
			const fibers = [
				yield* holder('a', 'db', release, events),
				yield* holder('b', 'db', release, events),
				yield* holder('c', 'db', release, events)
			];
			const seen = [];
			for (let i = 0; i < 3; i += 1) seen.push(yield* nextEvent(events));
			expect(seen).toEqual(['a:Acquired', 'b:Acquired', 'c:Waiting']);
			expect(yield* locks.status('db')).toEqual({ permits: 2, available: 0, waiting: 1 });

			yield* Deferred.succeed(release, undefined);
			expect(yield* Fiber.joinAll(fibers)).toEqual(['a', 'b', 'c']);
			expect(yield* locks.status('db')).toEqual({ permits: 2, available: 2, waiting: 0 });
		}).pipe(Effect.provide(LocksLayer))
	);

	it.effect('measures the wait on the clock', () =>
		Effect.gen(function* () {
			const events = yield* eventsQueue;
			const release = yield* Deferred.make<void>();
			const done = yield* Deferred.make<void>();
			yield* holder('a', 'cpu', release, events);
			yield* nextEvent(events);
			const b = yield* holder('b', 'cpu', done, events);
			expect(yield* nextEvent(events)).toBe('b:Waiting');

			yield* TestClock.adjust('90 seconds');
			yield* Deferred.succeed(release, undefined);
			expect(yield* nextEvent(events)).toBe('a:Released');
			const [, acquired] = yield* Queue.take(events);
			expect(acquired).toEqual(LockEvent.Acquired({ resource: 'cpu', waitedMs: 90_000 }));
			yield* Deferred.succeed(done, undefined);
			yield* Fiber.join(b);
		}).pipe(Effect.provide(LocksLayer))
	);

	it.effect('removes an interrupted waiter from the queue', () =>
		Effect.gen(function* () {
			const locks = yield* Locks;
			const events = yield* eventsQueue;
			const release = yield* Deferred.make<void>();
			const never = yield* Deferred.make<void>();
			const done = yield* Deferred.make<void>();

			const a = yield* holder('a', 'cpu', release, events);
			yield* nextEvent(events);
			const b = yield* holder('b', 'cpu', never, events);
			yield* nextEvent(events);
			const c = yield* holder('c', 'cpu', done, events);
			yield* nextEvent(events);

			yield* Fiber.interrupt(b);
			expect(yield* locks.status('cpu')).toEqual({ permits: 1, available: 0, waiting: 1 });

			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(a);
			expect([yield* nextEvent(events), yield* nextEvent(events)]).toEqual([
				'a:Released',
				'c:Acquired'
			]);
			yield* Deferred.succeed(done, undefined);
			expect(yield* Fiber.join(c)).toBe('c');
		}).pipe(Effect.provide(LocksLayer))
	);

	it.effect('releases the permit of an interrupted or failed holder', () =>
		Effect.gen(function* () {
			const locks = yield* Locks;
			const events = yield* eventsQueue;
			const never = yield* Deferred.make<void>();
			const done = yield* Deferred.make<void>();

			const a = yield* holder('a', 'cpu', never, events);
			yield* nextEvent(events);
			const b = yield* holder('b', 'cpu', done, events);
			yield* nextEvent(events);

			yield* Fiber.interrupt(a);
			expect([yield* nextEvent(events), yield* nextEvent(events)]).toEqual([
				'a:Released',
				'b:Acquired'
			]);
			yield* Deferred.succeed(done, undefined);
			yield* Fiber.join(b);

			const failed = yield* locks.withPermit('cpu', Effect.fail('boom')).pipe(Effect.exit);
			expect(Exit.isFailure(failed)).toBe(true);
			expect(yield* locks.status('cpu')).toEqual({ permits: 1, available: 1, waiting: 0 });
		}).pipe(Effect.provide(LocksLayer))
	);

	it.effect('fails for a resource with no permits', () =>
		Effect.gen(function* () {
			const locks = yield* Locks;
			const error = yield* Effect.flip(locks.withPermit('gpu', Effect.void));
			assert.instanceOf(error, UnknownLockResource);
			expect(error.resource).toBe('gpu');
		}).pipe(Effect.provide(LocksLayer))
	);
});
