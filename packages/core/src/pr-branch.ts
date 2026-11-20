/**
 * Steps that put work on a PR's branch: `commit` commits the work as it is, and
 * `push` pushes `HEAD` to the PR's head ref.
 */
import { Effect, Schema } from 'effect';
import { Checkpoint } from './checkpoint.ts';
import { Git } from './git.ts';
import { StepNotReady } from './run-step.ts';
import { stepScopeFields } from './step-scope.ts';
import type { Step } from './step.ts';
import { GitSha } from './values.ts';

export const CommitInput = Schema.Struct({
	...stepScopeFields,
	message: Schema.NonEmptyString
});
export interface CommitInput extends Schema.Schema.Type<typeof CommitInput> {}

/**
 * `commit`: commits the uncommitted work with `message`, without running checks, and
 * reports `CommitCreated`. Returns the commit, or `null` when there was nothing to commit,
 * as on a resumed `commit` that already committed.
 */
export const commitStep = {
	name: 'commit',
	input: CommitInput,
	output: Schema.NullOr(GitSha),
	timeoutMs: () => null,
	run: (input, kit) =>
		Effect.gen(function* () {
			const sha = yield* (yield* Git).commit(input, input.message);
			if (sha !== null) {
				yield* kit.report({ _tag: 'CommitCreated', sha, message: input.message });
			}
			return sha;
		})
} satisfies Step<CommitInput, GitSha | null, unknown>;

/** Where `push` sends `HEAD`: branch `ref` of `remote`, a remote name or URL. */
export const PushTarget = Schema.Struct({
	remote: Schema.NonEmptyString,
	ref: Schema.NonEmptyString
});
export interface PushTarget extends Schema.Schema.Type<typeof PushTarget> {}

export const PushInput = Schema.Struct({
	...stepScopeFields,
	/** The PR's head when the run started; `HEAD` must descend from it. */
	pinnedSha: GitSha,
	target: PushTarget
});
export interface PushInput extends Schema.Schema.Type<typeof PushInput> {}

/**
 * `push`: pushes `HEAD` to `target`, without force, and reports `BranchPushed`. Returns
 * the pushed commit, or `null` when `HEAD` is still `pinnedSha` and there is nothing to
 * push.
 *
 * It refuses when `HEAD` does not descend from `pinnedSha`: the checkout moved to other
 * work since the run started. The push is checkpointed (`push`); one that reached the
 * remote just before a crash is pushed again, which git takes as a no-op.
 */
export const pushStep = {
	name: 'push',
	input: PushInput,
	output: Schema.NullOr(GitSha),
	timeoutMs: () => null,
	run: (input, kit) =>
		Effect.gen(function* () {
			const git = yield* Git;
			const head = yield* git.headSha(input);
			if (head === input.pinnedSha) return null;
			if (!(yield* git.isAncestor(input, input.pinnedSha, head))) {
				return yield* new StepNotReady({
					reason: `HEAD ${head} does not descend from the PR's head ${input.pinnedSha}; pushing nothing`
				});
			}
			return yield* (yield* Checkpoint).once(
				'push',
				GitSha,
				Effect.gen(function* () {
					yield* git.pushHead(input, input.target);
					yield* kit.report({
						_tag: 'BranchPushed',
						sha: head,
						remote: input.target.remote,
						ref: input.target.ref
					});
					return head;
				})
			);
		})
} satisfies Step<PushInput, GitSha | null, unknown>;
