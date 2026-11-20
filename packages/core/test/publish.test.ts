import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	escalateStep,
	FindingId,
	prStep,
	type PrInput,
	type VerifiedFinding
} from '../src/index.ts';
import { AgentFake, fakeSha, GhFake, GitFake, opensPr } from '../src/testing.ts';
import { resolvedConfig } from './fixtures.ts';
import { recordingKit, scopeWith, withSteps } from './step-harness.ts';

const tradeoff: VerifiedFinding = {
	id: FindingId.make('r1-2'),
	round: 1,
	reviewer: 'performance',
	alsoReportedBy: [],
	file: 'src/a.ts',
	line: 4,
	severity: 'tradeoff',
	claim: 'An extra query per request.',
	evidence: 'await db.query()'
};

const prInput = (pr: Partial<typeof resolvedConfig.pr> = {}): PrInput => ({
	...scopeWith({ pr: { ...resolvedConfig.pr, ...pr } }),
	planDir: '/plans/feature',
	branch: 'feature',
	squashMessage: 'Add a',
	checks: [],
	unresolved: { mustFix: [], tradeoffs: [tradeoff], nits: [] }
});

/** Two commits on the branch, so a squash leaves one. */
const twoCommits = {
	commits: [
		{ sha: fakeSha(1), subject: 'Start a', message: 'Start a' },
		{ sha: fakeSha(2), subject: 'Finish a', message: 'Finish a' }
	],
	headSha: fakeSha(2)
};

const scriptText = Effect.gen(function* () {
	const text = { title: 'Add a', body: '## Summary\n\nAdds a.', costUsd: 0.05 };
	yield* (yield* AgentFake).script({ step: 'pr' }, yield* opensPr(text));
	yield* (yield* AgentFake).script({ step: 'escalate' }, yield* opensPr(text));
});

describe('prStep', () => {
	it.effect('squashes, pushes and opens the PR with the tradeoffs listed', () =>
		withSteps(
			Effect.gen(function* () {
				yield* scriptText;
				const recorded = yield* recordingKit;

				const url = yield* prStep.run(
					prInput({ squash: true, draft: false }),
					recorded.kit
				);

				const git = yield* (yield* GitFake).state;
				expect(git.commits.map((commit) => commit.message)).toEqual(['Add a']);
				expect(git.pushes).toEqual(['feature']);
				const [pr] = yield* (yield* GhFake).prs;
				expect(pr).toMatchObject({ url, head: 'feature', base: 'main', draft: false });
				expect(pr?.body).toContain(tradeoff.claim);
				expect(yield* recorded.tags).toEqual(['PrOpened']);
				expect(yield* recorded.costs).toEqual([0.05]);
			}),
			twoCommits
		)
	);

	it.effect('updates the branch PR a previous attempt opened instead of opening another', () =>
		withSteps(
			Effect.gen(function* () {
				yield* scriptText;
				const gh = yield* GhFake;
				const existing = yield* gh.addPr({
					base: 'main',
					head: 'feature',
					title: 'Old',
					body: 'Old',
					draft: true
				});
				const recorded = yield* recordingKit;

				const url = yield* prStep.run(prInput({ squash: false }), recorded.kit);

				expect(url).toBe(existing.url);
				const prs = yield* gh.prs;
				expect(prs).toHaveLength(1);
				expect(prs[0]?.title).toBe('Add a');
				const git = yield* (yield* GitFake).state;
				expect(git.commits).toHaveLength(2);
			}),
			twoCommits
		)
	);
});

describe('escalateStep', () => {
	it.effect('commits unfinished work and opens a draft that says why', () =>
		withSteps(
			Effect.gen(function* () {
				yield* scriptText;
				const recorded = yield* recordingKit;

				yield* escalateStep.run(
					{ ...prInput({ squash: false, draft: false }), reason: 'review-cap' },
					recorded.kit
				);

				const git = yield* (yield* GitFake).state;
				expect(git.commits.at(-1)?.message).toBe(
					'WIP: unfinished work (ship escalated: review-cap)'
				);
				const [pr] = yield* (yield* GhFake).prs;
				expect(pr?.draft).toBe(true);
				expect(yield* recorded.tags).toEqual(['Escalated', 'CommitCreated', 'PrOpened']);
			}),
			{ ...twoCommits, dirty: true }
		)
	);

	it.effect('refuses to escalate without a reason, publishing nothing', () =>
		withSteps(
			Effect.gen(function* () {
				const recorded = yield* recordingKit;

				const error = yield* Effect.flip(
					escalateStep.run({ ...prInput(), reason: null }, recorded.kit)
				);

				expect(error._tag).toBe('StepNotReady');
				expect((yield* (yield* GitFake).state).pushes).toEqual([]);
				expect(yield* (yield* GhFake).prs).toEqual([]);
			})
		)
	);
});
