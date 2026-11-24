import { make, PrStates } from '#lib/server/pr-states.ts';
import { describe, expect, it } from '@effect/vitest';
import { GhFake } from '@ship/core/testing';
import { Effect, Layer } from 'effect';

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
