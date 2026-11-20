import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	ChangeIntent,
	FindingId,
	postStep,
	ReviewId,
	reviewMarker,
	Reviews,
	type StoredReview,
	type VerifiedFinding
} from '../src/index.ts';
import { fakeSha, GhFake } from '../src/testing.ts';
import { baseSha, projectKey, runId } from './fixtures.ts';
import { CheckpointValues, recordingKit, scopeWith, withSteps } from './step-harness.ts';

const PR_URL = 'https://github.com/f-elix/example/pull/1';
const reviewId = ReviewId.make('run-1-r1');

const findingAt = (
	n: number,
	severity: VerifiedFinding['severity'],
	line: number
): VerifiedFinding => ({
	id: FindingId.make(`r1-${n}`),
	round: 1,
	reviewer: 'standards',
	alsoReportedBy: [],
	file: 'src/a.ts',
	line,
	severity,
	claim: `Claim ${n}.`,
	evidence: 'const a = 1;'
});

/** `src/a.ts` lines 1 to 5 are in the diff. */
const diff = [
	'diff --git a/src/a.ts b/src/a.ts',
	'--- /dev/null',
	'+++ b/src/a.ts',
	'@@ -0,0 +1,5 @@'
].join('\n');

/** The fake repo checked out at the reviewed head. */
const atHead = { headSha: fakeSha(7), diff };

const storeReview = (findings: ReadonlyArray<VerifiedFinding>, prUrl: string | null = PR_URL) =>
	Effect.gen(function* () {
		const review: StoredReview = {
			id: reviewId,
			runId,
			subject: {
				projectKey,
				prUrl,
				baseSha,
				headSha: fakeSha(7),
				intent: ChangeIntent.cases.Description.make({ title: 'Add a', body: '' })
			},
			findings,
			postedUrl: null
		};
		yield* (yield* Reviews).save(review);
	});

const post = Effect.gen(function* () {
	const recorded = yield* recordingKit;
	const url = yield* postStep.run({ ...scopeWith(), review: reviewId }, recorded.kit);
	return { url, recorded };
});

describe('postStep', () => {
	it.effect('comments inline in the diff, lists the rest in the body and requests changes', () =>
		withSteps(
			Effect.gen(function* () {
				yield* storeReview([findingAt(1, 'must-fix', 3), findingAt(2, 'nit', 40)]);

				const { url, recorded } = yield* post;

				const [review] = yield* (yield* GhFake).reviews;
				expect(review).toMatchObject({
					url,
					prUrl: PR_URL,
					commitId: fakeSha(7),
					event: 'REQUEST_CHANGES',
					comments: [{ path: 'src/a.ts', line: 3 }]
				});
				expect(review?.body).toContain('- `src/a.ts:40`: **Nit**');
				expect(review?.body).toContain(reviewMarker(reviewId));
				expect((yield* (yield* Reviews).get(reviewId)).postedUrl).toBe(url);
				expect(yield* recorded.tags).toEqual(['PrReviewPosted']);
			}),
			atHead
		)
	);

	it.effect('only comments when there is no must-fix finding', () =>
		withSteps(
			Effect.gen(function* () {
				yield* storeReview([findingAt(1, 'tradeoff', 2)]);

				yield* post;

				const [review] = yield* (yield* GhFake).reviews;
				expect(review?.event).toBe('COMMENT');
			}),
			atHead
		)
	);

	it.effect('posts nothing for a review without findings', () =>
		withSteps(
			Effect.gen(function* () {
				yield* storeReview([]);

				const { url } = yield* post;

				expect(url).toBeNull();
				expect(yield* (yield* GhFake).reviews).toEqual([]);
			}),
			atHead
		)
	);

	it.effect('takes the review it already posted instead of posting another', () =>
		withSteps(
			Effect.gen(function* () {
				yield* storeReview([findingAt(1, 'nit', 2)]);
				const first = yield* post;
				// As if the run died after GitHub took the review, before the checkpoint.
				(yield* CheckpointValues).clear();

				const again = yield* post;

				expect(again.url).toBe(first.url);
				expect(yield* (yield* GhFake).reviews).toHaveLength(1);
			}),
			atHead
		)
	);

	it.effect('refuses when HEAD moved from the reviewed head', () =>
		withSteps(
			Effect.gen(function* () {
				yield* storeReview([findingAt(1, 'nit', 2)]);

				const error = yield* Effect.flip(post);

				expect(error._tag).toBe('StepNotReady');
				expect(yield* (yield* GhFake).reviews).toEqual([]);
			}),
			{ headSha: fakeSha(8), diff }
		)
	);

	it.effect('refuses a review with no PR to post on', () =>
		withSteps(
			Effect.gen(function* () {
				yield* storeReview([findingAt(1, 'nit', 2)], null);

				const error = yield* Effect.flip(post);

				expect(error._tag).toBe('StepNotReady');
			}),
			atHead
		)
	);
});
