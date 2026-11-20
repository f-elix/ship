/**
 * The `resolve` step: resolves the GitHub review threads of fixed findings. It posts
 * no replies and no review.
 */
import { Effect, Schema } from 'effect';
import { Checkpoint } from './checkpoint.ts';
import { FindingId } from './finding.ts';
import { Gh } from './gh.ts';
import { Git } from './git.ts';
import { StepNotReady } from './run-step.ts';
import { stepScopeFields } from './step-scope.ts';
import type { Step } from './step.ts';
import { GitSha, Url } from './values.ts';

/** A fixed finding and the review thread it was posted as. */
export const FindingThread = Schema.Struct({ findingId: FindingId, threadId: Schema.String });
export interface FindingThread extends Schema.Schema.Type<typeof FindingThread> {}

export const ResolveInput = Schema.Struct({
	...stepScopeFields,
	prUrl: Url,
	/** The PR's head the findings were found fixed at, pinned when the run started. */
	headSha: GitSha,
	threads: Schema.Array(FindingThread)
});
export interface ResolveInput extends Schema.Schema.Type<typeof ResolveInput> {}

/**
 * `resolve`: resolves each thread of `threads` on the PR and reports `ThreadResolved` for
 * it. Returns the resolved thread ids, in order.
 *
 * It refuses when `HEAD` moved from `headSha`, since the findings were found fixed there.
 * Each thread is checkpointed (`thread/<id>`), so a resumed `resolve` skips the threads it
 * resolved; one resolved on GitHub just before a crash is resolved again, which GitHub
 * takes as a no-op.
 */
export const resolveStep = {
	name: 'resolve',
	input: ResolveInput,
	output: Schema.Array(Schema.String),
	timeoutMs: () => null,
	run: (input, kit) =>
		Effect.gen(function* () {
			const head = yield* (yield* Git).headSha(input);
			if (head !== input.headSha) {
				return yield* new StepNotReady({
					reason: `HEAD moved from the PR's head ${input.headSha} to ${head}; resolving no threads`
				});
			}
			const checkpoint = yield* Checkpoint;
			const gh = yield* Gh;
			return yield* Effect.forEach(input.threads, ({ findingId, threadId }) =>
				checkpoint.once(
					`thread/${threadId}`,
					Schema.String,
					Effect.gen(function* () {
						yield* gh.resolveThread(input, { prUrl: input.prUrl, threadId });
						yield* kit.report({ _tag: 'ThreadResolved', findingId, threadId });
						return threadId;
					})
				)
			);
		})
} satisfies Step<ResolveInput, ReadonlyArray<string>, unknown>;
