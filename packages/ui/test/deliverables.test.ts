import {
	DeliverableId,
	deliverablesOf,
	findingsSourceOf,
	groupingOf,
	openFindings,
	summarize,
	withRun,
	type ArchiveMarks,
	type Deliverable
} from '#lib/server/deliverables.ts';
import { describe, expect, it } from '@effect/vitest';
import { ReviewId, type RunEvent, type RunInfo } from '@ship/core/contract';
import { FindingId } from '@ship/core/finding';
import {
	at,
	FEATURE_ID,
	finding,
	fixRun,
	PR_URL,
	primitiveRun,
	PROJECT,
	recheckRun,
	reviewRun,
	shipRun,
	shipSummary
} from './support.ts';

const NO_MARKS: ArchiveMarks = new Map();
const PR_ID = DeliverableId.make(`pr:${PR_URL}`);
const REVIEW = ReviewId.make('review-1');

const only = (runs: ReadonlyArray<RunInfo>): Deliverable => {
	const [deliverable, ...rest] = deliverablesOf(runs);
	expect(rest).toEqual([]);
	return deliverable!;
};

const summaryOf = (runs: ReadonlyArray<RunInfo>, marks = NO_MARKS) => summarize(only(runs), marks);

describe('deliverablesOf', () => {
	it('groups the runs about one PR, newest first', () => {
		const ship = shipRun(1, { prUrl: PR_URL });
		const review = reviewRun(2, {
			summary: {
				kind: 'review',
				runId: reviewRun(2).runId,
				status: 'done',
				prUrl: PR_URL,
				reviewUrl: null,
				reviewId: REVIEW,
				costUsd: 0,
				mustFix: [],
				tradeoffs: [],
				nits: [],
				error: null
			}
		});
		// The post names only the review; the review names the PR.
		const post = primitiveRun(3, 'post', { review: REVIEW });
		const fix = fixRun(4);
		// A later `ship implement` on the PR's branch belongs to the PR too.
		const implement = primitiveRun(5, 'implement');

		const deliverable = only([ship, review, post, fix, implement]);

		expect(deliverable.id).toBe(FEATURE_ID);
		expect(deliverable.prUrl).toBe(PR_URL);
		expect(deliverable.branch).toBe('feature');
		expect(deliverable.runs.map((run) => run.runId)).toEqual(
			[implement, fix, post, review, ship].map((run) => run.runId)
		);
	});

	it('keys a branch without a PR by project and branch, and sorts by latest activity', () => {
		const older = shipRun(1, { branch: 'older', updatedAt: at(10) });
		const newer = shipRun(2, { branch: 'newer' });

		expect(deliverablesOf([newer, older]).map((deliverable) => deliverable.id)).toEqual([
			`branch:${PROJECT}#older`,
			`branch:${PROJECT}#newer`
		]);
	});

	it('keys a PR that no run names a branch of by its URL', () => {
		expect(only([reviewRun(1), fixRun(2)]).id).toBe(PR_ID);
	});

	it('keeps the PR a branch opened before under its URL, apart from the branch’s PR', () => {
		const OLD_PR = 'https://github.com/f-elix/example/pull/6';
		const old = shipRun(1, { prUrl: OLD_PR });
		const current = shipRun(2, { prUrl: PR_URL });

		expect(deliverablesOf([old, current]).map((deliverable) => deliverable.id)).toEqual([
			FEATURE_ID,
			`pr:${OLD_PR}`
		]);
	});

	it('canonicalizes a PR URL with a fragment', () => {
		const deliverable = only([fixRun(1, { prUrl: `${PR_URL}#discussion_r1` })]);
		expect(deliverable.id).toBe(PR_ID);
	});
});

describe('withRun', () => {
	const ids = (deliverables: ReadonlyArray<Deliverable>) =>
		deliverables.map((deliverable) => deliverable.id);

	it('swaps an updated run in place, keeping every other deliverable', () => {
		const feature = shipRun(1, { status: 'running', updatedAt: at(1) });
		const other = shipRun(2, { branch: 'other', updatedAt: at(2) });
		const before = groupingOf([feature, other]);

		const done = { ...feature, status: 'done' as const, updatedAt: at(3) };
		const after = withRun(before, done);

		expect(after.deliverables).toEqual(deliverablesOf([done, other]));
		expect(ids(after.deliverables)).toEqual([
			`branch:${PROJECT}#feature`,
			`branch:${PROJECT}#other`
		]);
		expect(after.deliverables[1]).toBe(before.deliverables[0]);
	});

	it('regroups when a run opens the PR its branch’s runs then belong to', () => {
		const ship = shipRun(1);
		const implement = primitiveRun(2, 'implement');
		const fix = fixRun(3);
		const before = groupingOf([ship, implement, fix]);
		expect(before.deliverables).toHaveLength(2);

		const opened = { ...ship, prUrl: PR_URL };
		const after = withRun(before, opened);

		expect(after.deliverables).toEqual(deliverablesOf([opened, implement, fix]));
		expect(ids(after.deliverables)).toEqual([FEATURE_ID]);
		expect(after.deliverableOfRun.get(fix.runId)).toBe(FEATURE_ID);
	});

	it('keeps a branch’s id and archive mark when its PR opens', () => {
		const ship = shipRun(1, { updatedAt: at(2) });
		const before = groupingOf([ship]);
		const archived: ArchiveMarks = new Map([
			[before.deliverables[0]!.id, { archived: true, at: at(5) }]
		]);
		expect(summarize(before.deliverables[0]!, archived).stage).toBe('closed');

		// The run reports the PR it opened without its update time moving past the mark.
		const after = withRun(before, { ...ship, prUrl: PR_URL });

		expect(ids(after.deliverables)).toEqual([FEATURE_ID]);
		expect(summarize(after.deliverables[0]!, archived)).toMatchObject({
			stage: 'closed',
			prUrl: PR_URL
		});
	});

	it('adds a new run to its deliverable', () => {
		const ship = shipRun(1, { prUrl: PR_URL });
		const recheck = recheckRun(2);

		const after = withRun(groupingOf([ship]), recheck);

		expect(after.deliverables).toEqual(deliverablesOf([ship, recheck]));
		expect(after.deliverableOfRun.get(recheck.runId)).toBe(FEATURE_ID);
	});
});

describe('summarize', () => {
	it('is working while the latest run is, with cancel only', () => {
		const summary = summaryOf([shipRun(1, { status: 'running', state: 'implement.agent' })]);

		expect(summary).toMatchObject({
			stage: 'working',
			tone: 'live',
			tag: 'working',
			headline: 'Implementing the plan.',
			actions: ['cancel'],
			title: 'feature',
			projectName: 'example'
		});
	});

	it('asks for a decision on a failed run, offering resume', () => {
		const run = shipRun(1, { status: 'failed' });
		const summary = summaryOf([
			{ ...run, summary: shipSummary(run, { status: 'failed', error: 'agent crashed' }) }
		]);

		expect(summary).toMatchObject({
			stage: 'decide',
			tone: 'error',
			tag: 'failed',
			actions: ['resume', 'archive']
		});
		expect(summary.headline).toContain('agent crashed');
	});

	it('asks for a decision on an interrupted run, offering resume then cancel', () => {
		const summary = summaryOf([shipRun(1, { status: 'interrupted' })]);
		expect(summary.actions).toEqual(['resume', 'cancel', 'archive']);
	});

	it('explains an escalation', () => {
		const run = shipRun(1, { status: 'escalated', prUrl: PR_URL });
		const summary = summaryOf([
			{
				...run,
				summary: shipSummary(run, { status: 'escalated', escalationReason: 'stall' })
			}
		]);

		expect(summary).toMatchObject({ stage: 'decide', tone: 'must-fix', tag: 'escalated' });
		expect(summary.headline).toBe('Stopped for you: the same findings came back after a fix.');
		expect(summary.actions).toEqual(['fix', 'recheck', 'archive']);
	});

	it('asks to post a stored review that was not posted', () => {
		const run = reviewRun(1);
		const summary = summaryOf([
			{
				...run,
				summary: {
					kind: 'review',
					runId: run.runId,
					status: 'done',
					prUrl: PR_URL,
					reviewUrl: null,
					reviewId: REVIEW,
					costUsd: 0,
					mustFix: [finding('f1', 'must-fix')],
					tradeoffs: [],
					nits: [],
					error: null
				}
			}
		]);

		expect(summary).toMatchObject({
			stage: 'decide',
			tone: 'must-fix',
			tag: 'not posted',
			actions: ['post', 'fix', 'recheck', 'archive']
		});
	});

	it('is ready once the PR is up, and offers recheck first after a fix', () => {
		expect(summaryOf([shipRun(1, { prUrl: PR_URL })])).toMatchObject({
			stage: 'ready',
			tone: 'ok',
			tag: 'PR open',
			actions: ['fix', 'recheck', 'archive']
		});
		expect(summaryOf([shipRun(1, { prUrl: PR_URL }), fixRun(2)]).actions).toEqual([
			'recheck',
			'fix',
			'archive'
		]);
	});

	it('archives a deliverable cancelled before it produced anything', () => {
		expect(summaryOf([shipRun(1, { status: 'cancelled' })])).toMatchObject({
			stage: 'closed',
			tag: 'closed',
			actions: ['unarchive']
		});
		// Cancelled after it opened the PR: what it produced is still there to look at.
		expect(summaryOf([shipRun(1, { status: 'cancelled', prUrl: PR_URL })]).stage).toBe('ready');
	});

	it('follows the latest mark until a run changes after it', () => {
		const run = shipRun(1, { prUrl: PR_URL });
		const archived: ArchiveMarks = new Map([[FEATURE_ID, { archived: true, at: at(5) }]]);

		expect(summaryOf([run], archived).stage).toBe('closed');
		expect(summaryOf([run, fixRun(6)], archived).stage).toBe('ready');
	});

	it('lets an unarchive override archiving a cancelled deliverable', () => {
		const run = shipRun(1, { status: 'cancelled' });
		const unarchived: ArchiveMarks = new Map([[FEATURE_ID, { archived: false, at: at(5) }]]);

		expect(summaryOf([run], unarchived).stage).toBe('ready');
	});

	it('never closes a deliverable ship works on', () => {
		const run = shipRun(1, { status: 'running', state: 'review.running' });
		const archived: ArchiveMarks = new Map([[FEATURE_ID, { archived: true, at: at(5) }]]);

		expect(summaryOf([run], archived).stage).toBe('working');
	});
});

describe('findingsSourceOf', () => {
	it('takes the latest stored review, else the PR threads', () => {
		const prOnly = only([shipRun(1, { prUrl: PR_URL })]);
		expect(findingsSourceOf(prOnly)).toEqual({ _tag: 'PrThreads', pr: PR_URL });

		const review = reviewRun(2);
		const reviewed = only([
			shipRun(1, { prUrl: PR_URL }),
			{
				...review,
				summary: {
					kind: 'review',
					runId: review.runId,
					status: 'done',
					prUrl: PR_URL,
					reviewUrl: null,
					reviewId: REVIEW,
					costUsd: 0,
					mustFix: [],
					tradeoffs: [],
					nits: [],
					error: null
				}
			}
		]);
		expect(findingsSourceOf(reviewed)).toEqual({ _tag: 'Review', reviewId: REVIEW });
	});
});

describe('openFindings', () => {
	const mustFix = finding('f1', 'must-fix');
	const tradeoff = finding('f2', 'tradeoff');
	const verified: RunEvent = {
		_tag: 'FindingsVerified',
		at: at(1),
		round: 1,
		verified: [mustFix, tradeoff],
		disproved: []
	};

	it('shows verified findings of a review in progress as unsettled', () => {
		const run = shipRun(1, { status: 'running' });
		expect(openFindings([{ info: run, events: [verified] }])).toEqual({
			mustFix: [mustFix],
			tradeoffs: [tradeoff],
			nits: [],
			settled: false
		});
	});

	it('shows what triage left once it ran', () => {
		const run = shipRun(1, { status: 'running' });
		const triaged: RunEvent = {
			_tag: 'FindingsTriaged',
			at: at(2),
			round: 1,
			mustFix: [],
			tradeoffs: [FindingId.make('f2')],
			nits: []
		};
		expect(openFindings([{ info: run, events: [verified, triaged] }])).toEqual({
			mustFix: [],
			tradeoffs: [tradeoff],
			nits: [],
			settled: true
		});
	});

	it('takes the newest run that speaks of findings', () => {
		const ship = shipRun(1, { prUrl: PR_URL });
		const shipped = { ...ship, summary: shipSummary(ship, { unresolvedMustFix: [mustFix] }) };
		const recheck = recheckRun(3);
		const rechecked = {
			...recheck,
			summary: {
				kind: 'recheck' as const,
				runId: recheck.runId,
				status: 'done' as const,
				prUrl: PR_URL,
				findings: [
					{ finding: mustFix, status: 'unfixed' as const, evidence: 'still there' }
				],
				resolvedThreads: [],
				ignoredThreads: [],
				costUsd: 0,
				error: null
			}
		};

		expect(openFindings([{ info: shipped, events: [] }]).mustFix).toEqual([mustFix]);
		// A finished fix leaves nothing known open; the recheck after it finds one unfixed.
		expect(
			openFindings([
				{ info: shipped, events: [] },
				{ info: fixRun(2), events: [] }
			]).mustFix
		).toEqual([]);
		expect(
			openFindings([
				{ info: rechecked, events: [] },
				{ info: fixRun(2), events: [] },
				{ info: shipped, events: [] }
			]).mustFix
		).toEqual([mustFix]);
	});
});
