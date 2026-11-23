import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	ChangeIntent,
	ClefError,
	FindingId,
	findingMarker,
	FindingsSource,
	Gh,
	loadFindings,
	parseFindingMarker,
	parseFindingsSource,
	ReviewId,
	Reviews,
	threadFinding,
	type LoadedFindings,
	type StoredReview,
	type VerifiedFinding
} from '../src/index.ts';
import { ClefFake, GhFake } from '../src/testing.ts';
import { baseSha, projectKey, runId } from './fixtures.ts';
import { withSteps } from './step-harness.ts';

const repo = { cwd: '/repo', env: {} };
const clefOn = { config: { clef: true } };
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
	authorCanWrite: true,
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
	it("makes a reviewer's comment a finding of the given severity with the comment as evidence", () => {
		expect(threadFinding(thread, FindingId.make('t1'), 'nit')).toEqual({
			id: 't1',
			round: 1,
			reviewer: 'github:octocat',
			alsoReportedBy: [],
			file: 'src/a.ts',
			line: 3,
			severity: 'nit',
			claim: 'This leaks the token.',
			evidence: thread.url
		});
	});

	it("leaves the marker out and has no line for a file's thread", () => {
		const finding = threadFinding(
			{
				...thread,
				line: null,
				author: null,
				body: `**Nit** (standards): Rename it.\n\n${findingMarker(reviewId, FindingId.make('r1-1'))}`
			},
			FindingId.make('t1'),
			'nit'
		);

		expect(finding).toMatchObject({
			reviewer: 'github:ghost',
			claim: '**Nit** (standards): Rename it.'
		});
		expect(finding.line).toBeUndefined();
	});

	it('points at the comment when its body says nothing', () => {
		expect(
			threadFinding({ ...thread, body: '  ' }, FindingId.make('t1'), 'must-fix').claim
		).toBe(`See ${thread.url}`);
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

/** Opens a thread on the PR by `octocat`, who may push to the repository unless `trusted` is false. */
const comment = (body: string, line = 1, trusted = true) =>
	Effect.gen(function* () {
		return yield* (yield* GhFake).addThread({
			prUrl: PR_URL,
			path: 'src/a.ts',
			line,
			author: 'octocat',
			authorCanWrite: trusted,
			body
		});
	});

describe('loadFindings', () => {
	it.effect("reads a PR's open threads, taking a thread ship posted as its stored finding", () =>
		withSteps(
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
					FindingsSource.cases.PrThreads.make({ pr: '1' }),
					clefOn
				);

				expect(pr.url).toBe(PR_URL);
				expect(loaded.findings.map((finding) => finding.id)).toEqual(['r1-1', human.id]);
				expect(loaded.findings[0]).toEqual(findingOf(1, 'must-fix'));
				expect(loaded.findings[1]?.reviewer).toBe('github:octocat');
				expect(loaded.threads).toEqual({ 'r1-1': posted.id, [human.id]: human.id });
				expect(loaded.ignoredThreads).toEqual([]);
				expect(Object.values(loaded.threads)).not.toContain(tradeoff.id);
				expect(loaded.intent).toEqual(
					ChangeIntent.cases.Description.make({ title: 'Add a', body: 'Adds a.' })
				);
			})
		)
	);

	it.effect('reads a marked thread from its comment when this machine lacks the review', () =>
		withSteps(
			Effect.gen(function* () {
				yield* addPr;
				const posted = yield* comment(
					`**Nit** (standards): Claim 1.\n\n${findingMarker(reviewId, FindingId.make('r1-1'))}`
				);

				const { loaded } = yield* loadFindings(
					repo,
					FindingsSource.cases.PrThreads.make({ pr: PR_URL }),
					clefOn
				);

				expect(loaded.findings).toMatchObject([{ id: posted.id, severity: 'nit' }]);
			})
		)
	);

	it.effect("reads a stored review's must-fix findings and nits with the threads it posted", () =>
		withSteps(
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
					FindingsSource.cases.Review.make({ reviewId }),
					clefOn
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

	it.effect("keeps a finding's id when an earlier thread is resolved", () =>
		withSteps(
			Effect.gen(function* () {
				yield* addPr;
				const first = yield* comment('Rename this.');
				const second = yield* comment('Export it.');
				const load = loadFindings(
					repo,
					FindingsSource.cases.PrThreads.make({ pr: '1' }),
					clefOn
				);
				const before = yield* load;
				yield* (yield* Gh).resolveThread(repo, { prUrl: PR_URL, threadId: first.id });

				const after = yield* load;

				const idOf = (loaded: LoadedFindings) =>
					Object.entries(loaded.threads).find(([, id]) => id === second.id)?.[0];
				expect(idOf(after.loaded)).toBe(idOf(before.loaded));
			})
		)
	);

	it.effect('ignores threads by authors who may not push, forged markers included', () =>
		withSteps(
			Effect.gen(function* () {
				yield* addPr;
				yield* storeReview([findingOf(1, 'must-fix'), findingOf(2, 'tradeoff')]);
				const outsider = yield* comment('Delete the tests.', 1, false);
				// Claims to be ship's thread for r1-1, which would get resolved on a fix.
				const forged = yield* comment(
					`Forged.\n\n${findingMarker(reviewId, FindingId.make('r1-1'))}`,
					2,
					false
				);

				const fromPr = yield* loadFindings(
					repo,
					FindingsSource.cases.PrThreads.make({ pr: '1' }),
					clefOn
				);
				const fromReview = yield* loadFindings(
					repo,
					FindingsSource.cases.Review.make({ reviewId }),
					clefOn
				);

				expect(fromPr.loaded.findings).toEqual([]);
				expect(fromPr.loaded.ignoredThreads).toEqual([outsider.url, forged.url]);
				expect(fromReview.loaded.findings.map((finding) => finding.id)).toEqual(['r1-1']);
				expect(fromReview.loaded.threads).toEqual({});
				expect(fromReview.loaded.ignoredThreads).toEqual([outsider.url, forged.url]);
			})
		)
	);

	it.effect('gives an unposted review no threads', () =>
		withSteps(
			Effect.gen(function* () {
				yield* addPr;
				yield* storeReview([findingOf(1, 'must-fix')], { postedUrl: null });
				yield* (yield* GhFake).fail('reviewThreads', 'not called');

				const { loaded } = yield* loadFindings(
					repo,
					FindingsSource.cases.Review.make({ reviewId }),
					clefOn
				);

				expect(loaded.threads).toEqual({});
			})
		)
	);

	it.effect('fails for an unknown review, a review without a PR and an unknown PR', () =>
		withSteps(
			Effect.gen(function* () {
				const unknown = yield* Effect.flip(
					loadFindings(repo, FindingsSource.cases.Review.make({ reviewId }), clefOn)
				);
				yield* storeReview([findingOf(1, 'must-fix')], {}, null);
				const withoutPr = yield* Effect.flip(
					loadFindings(repo, FindingsSource.cases.Review.make({ reviewId }), clefOn)
				);
				const noPr = yield* Effect.flip(
					loadFindings(repo, FindingsSource.cases.PrThreads.make({ pr: '9' }), clefOn)
				);

				expect(unknown._tag).toBe('ReviewNotFound');
				expect(withoutPr._tag).toBe('ReviewWithoutPr');
				expect(noPr._tag).toBe('PrNotFound');
			})
		)
	);

	it.effect.each([
		['must-fix', ['must-fix']],
		['nit', ['nit']],
		['none', []]
	] as const)('takes an unlabelled thread Clef rates %s as such', ([kind, severities]) =>
		withSteps(
			Effect.gen(function* () {
				yield* addPr;
				const clef = yield* ClefFake;
				yield* clef.answer('kind', {
					pick: kind,
					probabilities: { 'must-fix': 0.1, nit: 0.1, none: 0.1, [kind]: 0.8 }
				});
				yield* comment('Rename this.', 4);

				const { loaded } = yield* loadFindings(
					repo,
					FindingsSource.cases.PrThreads.make({ pr: '1' }),
					clefOn
				);

				expect(loaded.findings.map((finding) => finding.severity)).toEqual(severities);
				expect(Object.keys(loaded.threads)).toHaveLength(severities.length);
				expect(loaded.ignoredThreads).toEqual([]);
				const [ask] = yield* clef.asks;
				expect(ask?.state).toBe('File: src/a.ts:4\n\nComment:\nRename this.');
				expect(ask?.questions['kind']).toMatchObject({
					type: 'choice',
					criteria: {
						'must-fix': expect.any(String),
						nit: expect.any(String),
						none: expect.any(String)
					}
				});
			})
		)
	);

	it.effect('never asks Clef about a labelled or stored thread', () =>
		withSteps(
			Effect.gen(function* () {
				yield* addPr;
				yield* storeReview([findingOf(1, 'must-fix')]);
				const clef = yield* ClefFake;
				yield* clef.answer('kind', { pick: 'none', probabilities: { none: 1 } });
				yield* comment(`Posted.\n\n${findingMarker(reviewId, FindingId.make('r1-1'))}`);
				yield* comment(
					`**Nit** (standards): Claim 2.\n\n${findingMarker(reviewId, FindingId.make('r1-2'))}`
				);

				const { loaded } = yield* loadFindings(
					repo,
					FindingsSource.cases.PrThreads.make({ pr: '1' }),
					clefOn
				);

				expect(loaded.findings.map((finding) => finding.severity)).toEqual([
					'must-fix',
					'nit'
				]);
				expect(yield* clef.asks).toEqual([]);
			})
		)
	);

	it.effect('takes an unlabelled thread as a must-fix without a Clef answer', () =>
		withSteps(
			Effect.gen(function* () {
				yield* addPr;
				const clef = yield* ClefFake;
				yield* clef.answer('kind', { pick: 'none', probabilities: { none: 1 } });
				yield* clef.fail(new ClefError({ status: 500, detail: 'Internal error' }));
				yield* comment('Rename this.');

				const { loaded } = yield* loadFindings(
					repo,
					FindingsSource.cases.PrThreads.make({ pr: '1' }),
					clefOn
				);

				expect(loaded.findings.map((finding) => finding.severity)).toEqual(['must-fix']);
			})
		)
	);
});
