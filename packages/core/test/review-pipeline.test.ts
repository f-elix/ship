import { describe, expect, it } from '@effect/vitest';
import { Struct } from 'effect';
import {
	buildReviewSummary,
	commentableLines,
	FindingId,
	parseFindingMarker,
	ReviewId,
	reviewToPost,
	RunEvent,
	type VerifiedFinding
} from '../src/index.ts';
import {
	at,
	baseSha,
	headSha,
	nit,
	projectKey,
	runId,
	sessionId,
	verifiedFinding
} from './fixtures.ts';

const diff = [
	'diff --git a/src/a.ts b/src/a.ts',
	'--- a/src/a.ts',
	'+++ b/src/a.ts',
	'@@ -10,3 +10,4 @@ export const a = 1;',
	' context',
	'+added',
	' context',
	' context',
	'@@ -40,0 +41 @@',
	'+one more',
	'diff --git a/old.ts b/old.ts',
	'--- a/old.ts',
	'+++ /dev/null',
	'@@ -1,2 +0,0 @@',
	'-gone',
	'-gone',
	'diff --git a/src/b.ts b/src/b.ts',
	'--- a/src/b.ts',
	'+++ b/src/b.ts',
	'@@ -5,2 +5,0 @@',
	'-removed',
	'-removed'
].join('\n');

const findingAt = (
	file: string,
	line: number | undefined,
	severity: VerifiedFinding['severity']
) => {
	return {
		...Struct.omit(verifiedFinding, ['line']),
		...(line === undefined ? {} : { line }),
		file,
		severity,
		id: FindingId.make(`r1-${file}-${line}`)
	};
};

describe('commentableLines', () => {
	it('lists the new-side range of each hunk, skipping deleted files and pure deletions', () => {
		expect(commentableLines(diff)).toEqual(
			new Map([
				[
					'src/a.ts',
					[
						[10, 13],
						[41, 41]
					]
				]
			])
		);
	});

	it('reads quoted paths, paths with a space and renamed files by their new path', () => {
		const unusual = [
			'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
			'--- "a/caf\\303\\251.ts"',
			'+++ "b/caf\\303\\251.ts"',
			'@@ -1 +1 @@',
			'diff --git a/my file.ts b/my file.ts',
			'--- a/my file.ts\t',
			'+++ b/my file.ts\t',
			'@@ -2,0 +3,2 @@',
			'diff --git a/old.ts b/new.ts',
			'similarity index 90%',
			'rename from old.ts',
			'rename to new.ts',
			'--- a/old.ts',
			'+++ b/new.ts',
			'@@ -7 +7 @@'
		].join('\n');

		expect(commentableLines(unusual)).toEqual(
			new Map([
				['café.ts', [[1, 1]]],
				['my file.ts', [[3, 4]]],
				['new.ts', [[7, 7]]]
			])
		);
	});
});

describe('reviewToPost', () => {
	const storedId = ReviewId.make('run-1-r1');

	it('comments inline on lines in the diff and lists the rest in the body', () => {
		const inline = findingAt('src/a.ts', 11, 'tradeoff');
		const outside = findingAt('src/a.ts', 30, 'nit');
		const deleted = findingAt('src/b.ts', 5, 'nit');
		const lineless = findingAt('README.md', undefined, 'nit');

		const review = reviewToPost(storedId, [inline, outside, deleted, lineless], diff);

		expect(review.event).toBe('COMMENT');
		expect(review.comments).toEqual([
			{ path: 'src/a.ts', line: 11, body: expect.stringContaining(inline.claim) }
		]);
		// The marker ties the thread the comment opens to its stored finding.
		expect(parseFindingMarker(review.comments[0]?.body ?? '')).toEqual({
			reviewId: storedId,
			findingId: inline.id
		});
		expect(review.inBody).toBe(3);
		expect(review.body).toContain('0 must-fix findings, 1 tradeoff and 3 nits.');
		expect(review.body).toContain('- `src/a.ts:30`: **Nit**');
		expect(review.body).toContain('- `src/b.ts:5`: **Nit**');
		expect(review.body).toContain('- `README.md`: **Nit**');
		expect(review.body).not.toContain('src/a.ts:11');
	});

	it('requests changes when a must-fix finding was verified, wherever it is', () => {
		const review = reviewToPost(storedId, [findingAt('src/z.ts', 3, 'must-fix'), nit], diff);

		expect(review.event).toBe('REQUEST_CHANGES');
		expect(review.comments).toEqual([]);
		expect(review.body).toContain('1 must-fix finding, 0 tradeoffs and 1 nit.');
	});

	it('leaves the body a one-line count when every finding is inline', () => {
		const review = reviewToPost(storedId, [findingAt('src/a.ts', 41, 'must-fix')], diff);

		expect(review.body).toBe('ship review found 1 must-fix finding, 0 tradeoffs and 0 nits.');
		expect(review.comments).toHaveLength(1);
		expect(review.inBody).toBe(0);
	});
});

describe('buildReviewSummary', () => {
	const prUrl = 'https://github.com/f-elix/ship/pull/7';
	const created = RunEvent.cases.ReviewRunCreated.make({
		at,
		projectKey,
		repoDir: '/repo',
		prUrl,
		prNumber: 7,
		baseSha,
		headSha
	});

	it('sorts the verified findings by severity and links the posted review', () => {
		const summary = buildReviewSummary({
			runId,
			status: 'done',
			error: null,
			events: [
				created,
				RunEvent.cases.AgentCost.make({
					at,
					step: 'review',
					model: 'sonnet',
					sessionId,
					costUsd: 0.25
				}),
				RunEvent.cases.FindingsVerified.make({
					at,
					round: 1,
					verified: [verifiedFinding, nit],
					disproved: []
				}),
				RunEvent.cases.PrReviewPosted.make({
					at,
					url: `${prUrl}#pullrequestreview-1`,
					event: 'REQUEST_CHANGES',
					inline: 1,
					inBody: 1
				})
			]
		});

		expect(summary).toEqual({
			kind: 'review',
			runId,
			status: 'done',
			prUrl,
			reviewUrl: `${prUrl}#pullrequestreview-1`,
			costUsd: 0.25,
			mustFix: [verifiedFinding],
			tradeoffs: [],
			nits: [nit],
			error: null
		});
	});

	it('keeps the error only for a failed run', () => {
		const summary = (status: 'failed' | 'cancelled') =>
			buildReviewSummary({ runId, status, error: 'gh failed', events: [created] });

		expect(summary('failed')).toMatchObject({ error: 'gh failed', reviewUrl: null });
		expect(summary('cancelled').error).toBeNull();
	});
});
