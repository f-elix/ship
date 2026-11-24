import { make, PrStates, type PrToRead } from '#lib/server/pr-states.ts';
import { describe, expect, it } from '@effect/vitest';
import { GhFake } from '@ship/core/testing';
import { Effect, Layer, Queue, Stream } from 'effect';
import { TestClock } from 'effect/testing';

/** The real `PrStates` over the fake GitHub, which stays in context. */
const withPrStatesTest = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.provide(effect, Layer.effect(PrStates, make).pipe(Layer.provideMerge(GhFake.layer)));

/** Opens a PR in the fake GitHub, in `f-elix/example`, and returns its URL. */
const openPr = (head: string) =>
	Effect.gen(function* () {
		const github = yield* GhFake;
		const pr = yield* github.addPr({ base: 'main', head, title: head, body: '', draft: false });
		return pr.url;
	});

const OTHER_REPO_PR = 'https://github.com/f-elix/other/pull/1';

describe('PrStates.refresh', () => {
	it.effect('reads every PR in one call per repository', () =>
		Effect.gen(function* () {
			const prStates = yield* PrStates;
			const github = yield* GhFake;
			const merged = yield* openPr('a');
			const open = yield* openPr('b');
			yield* github.setState(merged, 'merged');

			yield* prStates.refresh([
				{ prUrl: merged, cwd: '/repo' },
				{ prUrl: OTHER_REPO_PR, cwd: '/other' },
				{ prUrl: open, cwd: '/repo' }
			]);

			// The fake GitHub has no PR in the other repository, so it gives no state for it.
			expect(yield* prStates.current).toEqual(
				new Map([
					[merged, 'merged'],
					[open, 'open']
				])
			);
			expect(yield* github.prStatesCalls).toEqual([[merged, open], [OTHER_REPO_PR]]);
		}).pipe(withPrStatesTest)
	);

	it.effect('never reads a merged PR again, but reads a closed one, which can reopen', () =>
		Effect.gen(function* () {
			const prStates = yield* PrStates;
			const github = yield* GhFake;
			const merged = yield* openPr('a');
			const closed = yield* openPr('b');
			yield* github.setState(merged, 'merged');
			yield* github.setState(closed, 'closed');
			const prs = [
				{ prUrl: merged, cwd: '/repo' },
				{ prUrl: closed, cwd: '/repo' }
			];
			yield* prStates.refresh(prs);

			yield* github.setState(closed, 'open');
			yield* prStates.refresh(prs);

			expect(yield* prStates.current).toEqual(
				new Map([
					[merged, 'merged'],
					[closed, 'open']
				])
			);
			expect((yield* github.prStatesCalls).at(-1)).toEqual([closed]);
		}).pipe(withPrStatesTest)
	);

	it.effect('keeps the last known states when gh fails', () =>
		Effect.gen(function* () {
			const prStates = yield* PrStates;
			const github = yield* GhFake;
			const pr = yield* openPr('a');
			const prs = [{ prUrl: pr, cwd: '/repo' }];
			yield* prStates.refresh(prs);

			yield* github.setState(pr, 'merged');
			yield* github.fail('prStates', 'gh: not logged in');
			yield* prStates.refresh(prs);

			expect(yield* prStates.current).toEqual(new Map([[pr, 'open']]));
		}).pipe(withPrStatesTest)
	);
});

/**
 * Moves the test clock on by `seconds`, a tenth of a second at a time, so that each timer
 * started on the way fires in order, as it would on a real clock.
 */
const advance = (seconds: number) =>
	Effect.repeat(TestClock.adjust('100 millis'), { times: seconds * 10 - 1 });

/** Has `PrStates` follow the lists offered to the returned queue, for the test's scope. */
const followQueue = Effect.gen(function* () {
	const prStates = yield* PrStates;
	const lists = yield* Queue.unbounded<ReadonlyArray<PrToRead>>();
	yield* prStates.follow(Stream.fromQueue(lists));
	return lists;
});

// The test clock drives the 60-second reads and the wait after a change.
describe('PrStates.follow', () => {
	it.effect('reads nothing before the first list, then reads it at once', () =>
		Effect.gen(function* () {
			const github = yield* GhFake;
			const pr = yield* openPr('a');
			const lists = yield* followQueue;
			yield* advance(90);
			expect(yield* github.prStatesCalls).toEqual([]);

			yield* Queue.offer(lists, [{ prUrl: pr, cwd: '/repo' }]);
			yield* advance(0.1);

			expect(yield* github.prStatesCalls).toEqual([[pr]]);
		}).pipe(Effect.scoped, withPrStatesTest)
	);

	it.effect('reads the latest list again every 60 seconds', () =>
		Effect.gen(function* () {
			const prStates = yield* PrStates;
			const github = yield* GhFake;
			const pr = yield* openPr('a');
			const lists = yield* followQueue;
			yield* Queue.offer(lists, [{ prUrl: pr, cwd: '/repo' }]);
			yield* advance(0.1);

			yield* github.setState(pr, 'closed');
			yield* advance(59.8);
			expect(yield* github.prStatesCalls).toHaveLength(1);
			yield* advance(0.2);
			expect(yield* github.prStatesCalls).toHaveLength(2);
			expect(yield* prStates.current).toEqual(new Map([[pr, 'closed']]));
			yield* advance(60);
			expect(yield* github.prStatesCalls).toHaveLength(3);
		}).pipe(Effect.scoped, withPrStatesTest)
	);

	it.effect('reads the latest list 2 seconds after a burst of changes ends', () =>
		Effect.gen(function* () {
			const github = yield* GhFake;
			const first = yield* openPr('a');
			const second = yield* openPr('b');
			const lists = yield* followQueue;
			yield* Queue.offer(lists, [{ prUrl: first, cwd: '/repo' }]);
			yield* advance(0.1);

			yield* Queue.offer(lists, [{ prUrl: first, cwd: '/repo' }]);
			yield* advance(1);
			yield* Queue.offer(lists, [
				{ prUrl: first, cwd: '/repo' },
				{ prUrl: second, cwd: '/repo' }
			]);
			yield* advance(1.9);
			expect(yield* github.prStatesCalls).toHaveLength(1);
			yield* advance(0.2);

			// The two changes of the burst give one read, of the latest list.
			expect(yield* github.prStatesCalls).toEqual([[first], [first, second]]);
		}).pipe(Effect.scoped, withPrStatesTest)
	);

	it.effect('stops reading when its scope closes', () =>
		Effect.gen(function* () {
			const github = yield* GhFake;
			const pr = yield* openPr('a');
			yield* Effect.scoped(
				Effect.gen(function* () {
					const lists = yield* followQueue;
					yield* Queue.offer(lists, [{ prUrl: pr, cwd: '/repo' }]);
					yield* advance(0.1);
				})
			);

			yield* advance(120);

			expect(yield* github.prStatesCalls).toHaveLength(1);
		}).pipe(withPrStatesTest)
	);
});
