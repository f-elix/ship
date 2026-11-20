/**
 * The `ship review` machine: one review over a pull request, in the caller's checkout at
 * the PR's head. `review` runs the review primitive and stores the review; `post` posts
 * it as one GitHub review when the run was started with `--post`.
 */
import { createEffectLogic, setupEffect } from '@xstate/effect';
import { DateTime, Effect, Schema } from 'effect';
import { withCheckpointScope } from './checkpoint.ts';
import { addCost, fail, machineKit, stepInput, type Next } from './machine-kit.ts';
import { postPrimitive } from './post.ts';
import type { PrimitiveScope } from './primitive-scope.ts';
import { invokePrimitive } from './primitive.ts';
import { reviewPrimitive, type ReviewPrimitiveInput } from './review-primitive.ts';
import { ReviewRunState } from './review-run.ts';
import { ChangeIntent } from './reviewers.ts';
import { RunReporter, type StepOutcome } from './run-step.ts';
import type { ReviewRound } from './run.ts';
import { reviewIdFor, Reviews } from './stored-review.ts';

/** A review run reviews once, as round 1. */
const ROUND = 1;

const scopeOf = (state: ReviewRunState): PrimitiveScope => ({
	runId: state.runId,
	projectKey: state.projectKey,
	cwd: state.cwd,
	env: state.env,
	baseSha: state.baseSha,
	config: state.config
});

/** The id the run stores its review under. */
const reviewIdOf = (state: ReviewRunState) => reviewIdFor(state.runId, ROUND);

/** The review over the PR, against its description; nothing carries over. */
const reviewInput = (state: ReviewRunState): ReviewPrimitiveInput => ({
	...scopeOf(state),
	round: ROUND,
	intent: ChangeIntent.cases.Description.make({ title: state.pr.title, body: state.pr.body }),
	followUp: null
});

/**
 * Runs the review primitive, then stores its review and reports `ReviewStored`. The
 * review must be of the PR's pinned head: one of another commit, after `HEAD` moved
 * during the review, fails the run before anything is stored.
 */
const reviewAndStore = (state: ReviewRunState) =>
	Effect.gen(function* () {
		const input = reviewInput(state);
		const outcome = yield* withCheckpointScope('review')(
			invokePrimitive(reviewPrimitive, input)
		);
		if (outcome._tag === 'Failed') return outcome;
		const round = outcome.output;
		if (round.toSha !== state.pr.headSha) {
			return {
				_tag: 'Failed',
				spent: outcome.spent,
				failure: {
					step: 'review',
					message: `HEAD moved from the PR's head ${state.pr.headSha} to ${round.toSha} during the review`,
					timedOut: false,
					hasCommits: false
				}
			} satisfies StepOutcome<ReviewRound>;
		}
		const reviews = yield* Reviews;
		const reporter = yield* RunReporter;
		const reviewId = reviewIdOf(state);
		yield* reviews.save({
			id: reviewId,
			runId: state.runId,
			subject: {
				projectKey: state.projectKey,
				prUrl: state.pr.url,
				baseSha: state.baseSha,
				headSha: round.toSha,
				intent: input.intent
			},
			findings: round.findings,
			postedUrl: null
		});
		yield* reporter.report({ _tag: 'ReviewStored', at: yield* DateTime.now, reviewId });
		return outcome;
	});

const step = <A, R>(run: (state: ReviewRunState) => Effect.Effect<StepOutcome<A>, never, R>) =>
	createEffectLogic({ schemas: { input: ReviewRunState }, effect: ({ input }) => run(input) });

type ReviewNext = Next<ReviewRunState, 'post' | 'done' | 'failed'>;

/** Any failed step fails the run: a review run never escalates. */
const { settle, onDefect } = machineKit<ReviewRunState, 'failed'>({
	spend: addCost,
	onFailure: (context, failure) => fail(context, failure.message)
});

/** After `review`: `post` when asked to and there is something to post, else `done`. */
const afterReview = (context: ReviewRunState, round: ReviewRound): ReviewNext =>
	context.post && round.findings.length > 0
		? { target: 'post', context }
		: { target: 'done', context };

/**
 * The review machine: one state per primitive, like the pipeline. A resumed `review`
 * re-runs only the reviewers that had not reported, and a resumed `post` finds the review
 * it already posted instead of posting another.
 */
export const reviewMachine = setupEffect({
	schemas: {
		input: ReviewRunState,
		context: ReviewRunState,
		events: { cancel: Schema.Struct({}) }
	},
	actors: {
		review: step(reviewAndStore),
		post: step((state) =>
			withCheckpointScope('post')(
				invokePrimitive(postPrimitive, { ...scopeOf(state), review: reviewIdOf(state) })
			)
		)
	}
}).createMachine({
	id: 'review',
	context: ({ input }) => input,
	initial: 'review',
	on: { cancel: { target: '.cancelled' } },
	states: {
		review: {
			invoke: {
				src: 'review',
				input: stepInput,
				onDone: ({ context, event }) => settle(context, event.output, afterReview),
				onError: onDefect
			}
		},
		post: {
			invoke: {
				src: 'post',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, reviewUrl) => ({
						target: 'done',
						context: { ...next, reviewUrl }
					})),
				onError: onDefect
			}
		},
		done: { type: 'final' },
		failed: { type: 'final' },
		cancelled: { type: 'final' }
	}
});

/** The review machine's type, for the driver and the services its steps require. */
export type ReviewMachine = typeof reviewMachine;
