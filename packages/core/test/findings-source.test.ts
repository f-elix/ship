import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	ChangeIntent,
	FindingId,
	findingMarker,
	FindingsSource,
	loadFindings,
	parseFindingMarker,
	parseFindingsSource,
	ReviewId,
	Reviews,
	threadFinding,
	type StoredReview,
	type VerifiedFinding
} from '../src/index.ts';
import { GhFake } from '../src/testing.ts';
import { baseSha, projectKey, runId } from './fixtures.ts';
import { withPrimitives } from './primitive-harness.ts';

const repo = { cwd: '/repo', env: {} };
const PR_URL = 'https://github.com/f-elix/example/pull/1';
const reviewId = ReviewId.make('run-1-r1');

const findingOf = (n: number, severity: VerifiedFinding['severity']): VerifiedFinding => ({
	id: FindingId.make(`r1-${n}`),
	round: 1,
	reviewer: 'standards',
	alsoReportedBy: [],
	file: 'src/a.ts',
	line: n,
	severity,
	claim: `Claim ${n}.`,
	evidence: 'const a = 1;'
});

const thread = {
	id: 'PRRT_1',
	path: 'src/a.ts',
	line: 3,
	author: 'octocat',
	body: 'This leaks the token.',
	url: `${PR_URL}#discussion_r1`
};

describe('parseFindingsSource', () => {
	it('reads a PR number or URL as its threads and anything else as a review id', () => {
		expect(parseFindingsSource('12')).toEqual(
			FindingsSource.cases.PrThreads.make({ pr: '12' })
		);
		expect(parseFindingsSource(` ${PR_URL} `)).toEqual(
			FindingsSource.cases.PrThreads.make({ pr: PR_URL })
		);
		expect(parseFindingsSource('run-1-r1')).toEqual(
			FindingsSource.cases.Review.make({ reviewId })
		);
		expect(parseFindingsSource('  ')).toBeNull();
	});
});

describe('findingMarker', () => {
	it('names the review and the finding, and is found again in a comment', () => {
		const body = `**Nit** (standards): Claim.\n\n${findingMarker(reviewId, FindingId.make('r1-2'))}`;

		expect(parseFindingMarker(body)).toEqual({ reviewId, findingId: 'r1-2' });
		expect(parseFindingMarker('No marker here.')).toBeNull();
	});
});

describe('threadFinding', () => {
	it("makes a reviewer's comment a must-fix finding with the comment as evidence", () => {
		expect(threadFinding(thread, FindingId.make('t1'))).toEqual({
			id: 't1',
			round: 1,
			reviewer: 'github:octocat',
			alsoReportedBy: [],
			file: 'src/a.ts',
			line: 3,
			severity: 'must-fix',
			claim: 'This leaks the token.',
			evidence: thread.url
		});
	});

	it("keeps the severity ship labelled it with, leaves the marker out and has no line for a file's thread", () => {
		const finding = threadFinding(
			{
				...thread,
				line: null,
				author: null,
				body: `**Nit** (standards): Rename it.\n\n${findingMarker(reviewId, FindingId.make('r1-1'))}`
			},
			FindingId.make('t1')
		);

		expect(finding).toMatchObject({
			reviewer: 'github:ghost',
			severity: 'nit',
			claim: '**Nit** (standards): Rename it.'
		});
		expect(finding.line).toBeUndefined();
	});

	it('points at the comment when its body says nothing', () => {
		expect(threadFinding({ ...thread, body: '  ' }, FindingId.make('t1')).claim).toBe(
			`See ${thread.url}`
		);
	});
});

const storeReview = (
	findings: ReadonlyArray<VerifiedFinding>,
	overrides: Partial<StoredReview> = {},
	prUrl: string | null = PR_URL
) =>
	Effect.gen(function* () {
		yield* (yield* Reviews).save({
			id: reviewId,
			runId,
			subject: {
				projectKey,
				prUrl,
				baseSha,
				headSha: baseSha,
				intent: ChangeIntent.cases.Plan.make({
					specPath: '/plans/a/spec.md',
					planPath: '/plans/a/plan.md'
				})
			},
			findings,
			postedUrl: `${PR_URL}#pullrequestreview-1`,
			...overrides
		});
	});

const addPr = Effect.gen(function* () {
	return yield* (yield* GhFake).addPr({
		base: 'main',
		head: 'feature',
		title: 'Add a',
		body: 'Adds a.',
		draft: false
	});
});

/** Opens a thread on the PR, by `octocat` unless `author` says otherwise. */
const comment = (body: string, line = 1) =>
	Effect.gen(function* () {
		return yield* (yield* GhFake).addThread({
			prUrl: PR_URL,
			path: 'src/a.ts',
			line,
			author: 'octocat',
			body
		});
	});

describe('loadFindings', () => {
	it.effect("reads a PR's open threads, taking a thread ship posted as its stored finding", () =>
		withPrimitives(
			Effect.gen(function* () {
				yield* addPr;
				yield* storeReview([findingOf(1, 'must-fix'), findingOf(2, 'tradeoff')]);
				const posted = yield* comment(
					`Posted.\n\n${findingMarker(reviewId, FindingId.make('r1-1'))}`
				);
				const tradeoff = yield* comment(
					`**Tradeoff** (standards): Claim 2.\n\n${findingMarker(reviewId, FindingId.make('r1-2'))}`
				);
				const human = yield* comment('Rename this.', 4);
				yield* (yield* GhFake).addThread({
					prUrl: PR_URL,
					path: 'src/a.ts',
					line: 5,
					author: 'octocat',
					body: 'Old.',
					outdated: true
				});

				const { pr, loaded } = yield* loadFindings(
					repo,
					FindingsSource.cases.PrThreads.make({ pr: '1' })
				);

				expect(pr.url).toBe(PR_URL);
				expect(loaded.findings.map((finding) => finding.id)).toEqual(['r1-1', 't3']);
				expect(loaded.findings[0]).toEqual(findingOf(1, 'must-fix'));
				expect(loaded.findings[1]?.reviewer).toBe('github:octocat');
				expect(loaded.threads).toEqual({ 'r1-1': posted.id, t3: human.id });
				expect(Object.values(loaded.threads)).not.toContain(tradeoff.id);
				expect(loaded.intent).toEqual(
					ChangeIntent.cases.Description.make({ title: 'Add a', body: 'Adds a.' })
				);
			})
		)
	);

	it.effect('reads a marked thread from its comment when this machine lacks the review', () =>
		withPrimitives(
			Effect.gen(function* () {
				yield* addPr;
				yield* comment(
					`**Nit** (standards): Claim 1.\n\n${findingMarker(reviewId, FindingId.make('r1-1'))}`
				);

				const { loaded } = yield* loadFindings(
					repo,
					FindingsSource.cases.PrThreads.make({ pr: PR_URL })
				);

				expect(loaded.findings).toMatchObject([{ id: 't1', severity: 'nit' }]);
			})
		)
	);

	it.effect("reads a stored review's must-fix findings and nits with the threads it posted", () =>
		withPrimitives(
			Effect.gen(function* () {
				yield* addPr;
				yield* storeReview([
					findingOf(1, 'must-fix'),
					findingOf(2, 'tradeoff'),
					findingOf(3, 'nit')
				]);
				const posted = yield* comment(
					`Posted.\n\n${findingMarker(reviewId, FindingId.make('r1-1'))}`
				);
				// Another review's finding with the same id, and a human's thread.
				yield* comment(
					`Other.\n\n${findingMarker(ReviewId.make('run-2-r1'), FindingId.make('r1-3'))}`
				);
				yield* comment('Rename this.');

				const { loaded } = yield* loadFindings(
					repo,
					FindingsSource.cases.Review.make({ reviewId })
				);

				expect(loaded.findings.map((finding) => finding.id)).toEqual(['r1-1', 'r1-3']);
				expect(loaded.threads).toEqual({ 'r1-1': posted.id });
				expect(loaded.intent).toEqual(
					ChangeIntent.cases.Plan.make({
						specPath: '/plans/a/spec.md',
						planPath: '/plans/a/plan.md'
					})
				);
			})
		)
	);

	it.effect('gives an unposted review no threads', () =>
		withPrimitives(
			Effect.gen(function* () {
				yield* addPr;
				yield* storeReview([findingOf(1, 'must-fix')], { postedUrl: null });
				yield* (yield* GhFake).fail('reviewThreads', 'not called');

				const { loaded } = yield* loadFindings(
					repo,
					FindingsSource.cases.Review.make({ reviewId })
				);

				expect(loaded.threads).toEqual({});
			})
		)
	);

	it.effect('fails for an unknown review, a review without a PR and an unknown PR', () =>
		withPrimitives(
			Effect.gen(function* () {
				const unknown = yield* Effect.flip(
					loadFindings(repo, FindingsSource.cases.Review.make({ reviewId }))
				);
				yield* storeReview([findingOf(1, 'must-fix')], {}, null);
				const withoutPr = yield* Effect.flip(
					loadFindings(repo, FindingsSource.cases.Review.make({ reviewId }))
				);
				const noPr = yield* Effect.flip(
					loadFindings(repo, FindingsSource.cases.PrThreads.make({ pr: '9' }))
				);

				expect(unknown._tag).toBe('ReviewNotFound');
				expect(withoutPr._tag).toBe('ReviewWithoutPr');
				expect(noPr._tag).toBe('PrNotFound');
			})
		)
	);
});
