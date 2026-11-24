/**
 * Keeps the state of the deliverables' PRs on GitHub, which it reads through `gh`. Ship's
 * run store records only that a PR was opened; whether it was merged or closed since is
 * GitHub's.
 */
import { Gh } from '@ship/core/gh';
import { prRepoKey } from '@ship/core/pr-url';
import { processEnv } from '@ship/daemon/client';
import { Context, Effect, Layer, Option, Stream, SubscriptionRef } from 'effect';
import type { KnownPrStates } from './deliverables.ts';

/** A deliverable's PR, and a checkout of its repository to run `gh` in. */
export interface PrToRead {
	readonly prUrl: string;
	readonly cwd: string;
}

export interface PrStatesApi {
	/** Emits the known states, then emits them again after each change. */
	readonly states: Stream.Stream<KnownPrStates>;
	/** Gets the known states as they are now. */
	readonly current: Effect.Effect<KnownPrStates>;
	/**
	 * Reads the state of every PR in `prs` that is not known as merged, which is final, in
	 * one `gh` call per repository and per 50 PRs. When `gh` fails, the failure is logged
	 * and the states of that repository's PRs stay as they were known.
	 */
	readonly refresh: (prs: ReadonlyArray<PrToRead>) => Effect.Effect<void>;
}

/**
 * Returns `known` with the states in `read` laid over it, or `None` when `read` changes
 * nothing.
 */
const withRead = (known: KnownPrStates, read: KnownPrStates): Option.Option<KnownPrStates> => {
	const changed = [...read].filter(([url, state]) => known.get(url) !== state);
	return changed.length === 0 ? Option.none() : Option.some(new Map([...known, ...changed]));
};

/** PR states read through the `Gh` in context. */
export const make = Effect.gen(function* () {
	const gh = yield* Gh;
	const ref = yield* SubscriptionRef.make<KnownPrStates>(new Map());

	/** The PRs to read, by repository, with the checkout of any of them. */
	const byRepository = (known: KnownPrStates, prs: ReadonlyArray<PrToRead>) => {
		const repositories = new Map<string, { cwd: string; urls: Set<string> }>();
		for (const { prUrl, cwd } of prs) {
			const key = prRepoKey(prUrl);
			if (key === null || known.get(prUrl) === 'merged') continue;
			const repository = repositories.get(key);
			if (repository === undefined) repositories.set(key, { cwd, urls: new Set([prUrl]) });
			else repository.urls.add(prUrl);
		}
		return [...repositories.values()];
	};

	const refresh = Effect.fn('PrStates.refresh')(function* (prs: ReadonlyArray<PrToRead>) {
		const repositories = byRepository(yield* SubscriptionRef.get(ref), prs);
		const reads = yield* Effect.forEach(
			repositories,
			({ cwd, urls }) =>
				gh.prStates({ cwd, env: processEnv() }, [...urls]).pipe(
					Effect.tapError((error) =>
						Effect.logWarning('Cannot read the PR states', error)
					),
					Effect.orElseSucceed((): KnownPrStates => new Map())
				),
			{ concurrency: 4 }
		);
		const read = new Map(reads.flatMap((states) => Array.from(states)));
		yield* SubscriptionRef.updateSome(ref, (known) => withRead(known, read));
	});

	return {
		states: SubscriptionRef.changes(ref),
		current: SubscriptionRef.get(ref),
		refresh
	} satisfies PrStatesApi;
});

/** The deliverables' PR states, as GitHub last gave them. */
export class PrStates extends Context.Service<PrStates, PrStatesApi>()('@ship/ui/PrStates') {
	/** States read with the `gh` CLI. It still needs the platform services. */
	static readonly layer = Layer.effect(this, make).pipe(Layer.provide(Gh.layer));
}
