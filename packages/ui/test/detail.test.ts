import { deliverablesOf, type Deliverable } from '#lib/server/deliverables.ts';
import { changeRange, detailOf } from '#lib/server/detail.ts';
import { describe, expect, it } from '@effect/vitest';
import { SessionId, type RunEvent, type RunInfo } from '@ship/core/contract';
import {
	at,
	finding,
	fixRun,
	PR_URL,
	primitiveRun,
	PROJECT,
	recheckRun,
	reviewRun,
	sha,
	shipRun,
	shipSummary
} from './support.ts';

const only = (runs: ReadonlyArray<RunInfo>): Deliverable => {
	const [deliverable, ...rest] = deliverablesOf(runs);
	expect(rest).toEqual([]);
	return deliverable!;
};

const created = (n: number): RunEvent => ({
	_tag: 'RunCreated',
	at: at(n),
	projectKey: PROJECT,
	cwd: '/repo',
	planDir: '/plans/feature',
	branch: 'feature',
	baseSha: sha(n)
});
const committed = (n: number, message = 'Add it'): RunEvent => ({
	_tag: 'CommitCreated',
	at: at(n),
	sha: sha(n),
	message
});
const reviewStarted = (round: number, reviewers: ReadonlyArray<string>): RunEvent => ({
	_tag: 'ReviewStarted',
	at: at(round),
	round,
	fromSha: sha(1),
	toSha: sha(2),
	reviewers
});
const verified = (round: number, disproved: number): RunEvent => ({
	_tag: 'FindingsVerified',
	at: at(round),
	round,
	verified: [],
	disproved: Array.from({ length: disproved }, (_, i) => ({
		finding: finding(`d${round}-${i}`, 'nit'),
		reason: 'Not reproducible'
	}))
});
const cost = (n: number, costUsd: number): RunEvent => ({
	_tag: 'AgentCost',
	at: at(n),
	step: 'review',
	model: 'opus',
	sessionId: SessionId.make(`session-${n}`),
	costUsd
});

describe('changeRange', () => {
	it('has no range when no run says where it started', () => {
		expect(changeRange([{ info: shipRun(1), events: [committed(2)] }])).toBeNull();
	});

	it('spans from the base to the last commit made or pushed', () => {
		const pushed: RunEvent = {
			_tag: 'BranchPushed',
			at: at(4),
			sha: sha(4),
			remote: 'origin',
			ref: 'feature'
		};
		const events = [created(1), committed(2), committed(3), pushed];
		expect(changeRange([{ info: shipRun(1), events }])).toEqual({ from: sha(1), to: sha(4) });
	});

	it('starts at the oldest run and ends at the head the newest one pinned', () => {
		const review: RunEvent = {
			_tag: 'ReviewRunCreated',
			at: at(1),
			projectKey: PROJECT,
			repoDir: '/repo',
			prUrl: PR_URL,
			prNumber: 7,
			baseSha: sha(1),
			headSha: sha(2)
		};
		const fix: RunEvent = {
			_tag: 'PrRunCreated',
			at: at(3),
			kind: 'fix',
			projectKey: PROJECT,
			repoDir: '/repo',
			prUrl: PR_URL,
			prNumber: 7,
			baseSha: sha(5),
			headSha: sha(6),
			source: { _tag: 'PrThreads', pr: PR_URL },
			findings: [],
			ignoredThreads: []
		};
		const runs = [
			{ info: fixRun(3), events: [fix] },
			{ info: reviewRun(1), events: [review] }
		];
		expect(changeRange(runs)).toEqual({ from: sha(1), to: sha(6) });
	});

	it('has no end while nothing was committed: the change is the working tree’s', () => {
		const implement: RunEvent = {
			_tag: 'PrimitiveRunCreated',
			at: at(1),
			kind: 'implement',
			projectKey: PROJECT,
			repoDir: '/repo',
			baseSha: sha(1),
			branch: 'feature',
			planDir: '/plans/feature',
			review: null
		};
		expect(changeRange([{ info: primitiveRun(1, 'implement'), events: [implement] }])).toEqual({
			from: sha(1)
		});
	});
});

describe('detailOf', () => {
	const fixed = finding('f1', 'must-fix');
	const unfixed = finding('f2', 'must-fix');

	const ship = shipRun(1, { prUrl: PR_URL, round: 2 });
	const shipped = {
		...ship,
		summary: shipSummary(ship, {
			rounds: 2,
			checks: [
				{
					baseline: true,
					round: 0,
					attempt: 0,
					results: [
						{ name: 'lint', exitCode: 1, durationMs: 10, outputTail: 'lint broke' },
						{ name: 'test', exitCode: 0, durationMs: 10 }
					]
				},
				// A check the run broke and fixed is not the baseline's.
				{
					baseline: false,
					round: 1,
					attempt: 0,
					results: [{ name: 'types', exitCode: 2, durationMs: 10 }]
				}
			]
		})
	};
	const shipEvents = [
		created(1),
		reviewStarted(1, ['correctness', 'security']),
		verified(1, 1),
		cost(2, 0.25),
		committed(3, 'Fix the finding'),
		reviewStarted(2, ['correctness']),
		verified(2, 2)
	];

	const recheck = recheckRun(4, { status: 'failed' });
	const rechecked = {
		...recheck,
		summary: {
			kind: 'recheck' as const,
			runId: recheck.runId,
			status: 'failed' as const,
			prUrl: PR_URL,
			findings: [],
			resolvedThreads: [],
			ignoredThreads: [],
			costUsd: 0.5,
			error: 'gh is not logged in'
		}
	};
	const recheckEvents: ReadonlyArray<RunEvent> = [
		{
			_tag: 'FindingsRechecked',
			at: at(4),
			findings: [
				{ finding: fixed, status: 'fixed', evidence: 'gone' },
				{ finding: unfixed, status: 'unfixed', evidence: 'still there' }
			]
		},
		cost(5, 0.5)
	];

	const detail = detailOf(
		only([rechecked, shipped]),
		[
			{ info: rechecked, events: recheckEvents },
			{ info: shipped, events: shipEvents }
		],
		new Map(),
		null
	);

	it('rolls the review up over every run', () => {
		expect(detail).toMatchObject({
			rounds: 2,
			reviewers: ['correctness', 'security'],
			disproved: 3,
			resolved: [fixed],
			commits: [{ sha: sha(3), message: 'Fix the finding' }]
		});
	});

	it('keeps the failing baseline checks only', () => {
		expect(detail.preexistingChecks).toEqual([{ name: 'lint', outputTail: 'lint broke' }]);
	});

	it('lists each run’s command, cost and log, newest first', () => {
		expect(detail.runs.map((run) => [run.command, run.status, run.costUsd])).toEqual([
			['ship recheck', 'failed', 0.5],
			['ship run', 'done', 0.25]
		]);
		expect(detail.runs[1]?.lines).toContainEqual(
			expect.stringContaining(`commit ${sha(3).slice(0, 7)} Fix the finding`)
		);
	});

	it('says why the latest run failed, and only the latest', () => {
		expect(detail.error).toBe('gh is not logged in');

		const later = shipRun(6, { prUrl: PR_URL });
		const after = detailOf(
			only([later, rechecked, shipped]),
			[{ info: later, events: [] }],
			new Map(),
			null
		);
		expect(after.error).toBeNull();
	});
});
