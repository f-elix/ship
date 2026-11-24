/**
 * Groups the daemon's runs into deliverables, what ship produced: a PR, or a branch before
 * it has one. Pure: the inbox regroups the runs as the daemon updates them.
 */
import {
	FindingsSource,
	type ReviewId,
	type ReviewSummary,
	type RunEvent,
	type RunId,
	type RunInfo,
	type UnknownEvent
} from '@ship/core/contract';
import { plural } from '@ship/core/event-lines';
import type { FindingId, VerifiedFinding } from '@ship/core/finding';
import { parsePrUrl } from '@ship/core/pr-url';
import { DateTime, Schema } from 'effect';

/**
 * A deliverable's id: `pr:<url>`, `branch:<project>#<branch>`, `review:<id>` for a
 * `ship post` run whose review has no known PR, or `run:<id>` for a run that belongs to
 * none of these.
 */
export const DeliverableId = Schema.NonEmptyString.pipe(Schema.brand('DeliverableId'));
export type DeliverableId = typeof DeliverableId.Type;

/**
 * Where a deliverable stands for the developer: ship needs a decision, produced something
 * to look at, or is still working; or it is closed, because the developer archived it or
 * because it was cancelled before producing anything.
 */
export type Stage = 'decide' | 'ready' | 'working' | 'closed';

/** What the inbox can do to a deliverable; each maps to a daemon RPC or to the archive. */
export const ActionKind = Schema.Literals([
	'fix',
	'recheck',
	'post',
	'resume',
	'cancel',
	'archive',
	'unarchive'
]);
export type ActionKind = typeof ActionKind.Type;

/** What the UI asks the inbox to do: `action` on deliverable `id`. */
export const ActInput = Schema.Struct({ id: DeliverableId, action: ActionKind });

/** The colour of a deliverable's pill and status card. */
export type Tone = 'must-fix' | 'tradeoff' | 'error' | 'ok' | 'live' | 'neutral';

/** The developer's latest archive or unarchive of a deliverable, and when they did it. */
export interface ArchiveMark {
	readonly archived: boolean;
	readonly at: DateTime.Utc;
}

/** Every deliverable's latest {@link ArchiveMark}, by id. */
export type ArchiveMarks = ReadonlyMap<DeliverableId, ArchiveMark>;

/** The runs that made one deliverable, newest first, and what they were about. */
export interface Deliverable {
	readonly id: DeliverableId;
	readonly projectKey: string;
	/** The branch the runs worked on; `null` when only PR runs, which name none, made it. */
	readonly branch: string | null;
	readonly prUrl: string | null;
	/** Never empty. */
	readonly runs: ReadonlyArray<RunInfo>;
}

/**
 * A deliverable as the inbox lists it. It holds plain values only (ISO timestamps rather
 * than `DateTime`), because it is serialized to the browser.
 */
export interface DeliverableSummary {
	readonly id: DeliverableId;
	readonly projectName: string;
	readonly title: string;
	readonly branch: string | null;
	readonly prUrl: string | null;
	readonly stage: Stage;
	readonly tone: Tone;
	/** A word or two for the list's pill. */
	readonly tag: string;
	/** One sentence about the state of the output. */
	readonly headline: string;
	/** The latest update of any of its runs, as an ISO timestamp. */
	readonly updatedAt: string;
	/** The actions the inbox offers, the primary one first. */
	readonly actions: ReadonlyArray<ActionKind>;
}

/** The findings left for the developer, by severity. */
export interface OpenFindings {
	readonly mustFix: ReadonlyArray<VerifiedFinding>;
	readonly tradeoffs: ReadonlyArray<VerifiedFinding>;
	readonly nits: ReadonlyArray<VerifiedFinding>;
	/** `false` while a run is still reviewing: the findings are verified but not triaged. */
	readonly settled: boolean;
}

/** A run together with its event log, oldest event first. */
export interface RunWithEvents {
	readonly info: RunInfo;
	readonly events: ReadonlyArray<RunEvent | UnknownEvent>;
}

const millis = DateTime.toEpochMillis;
const isActive = (run: RunInfo) => run.status === 'running' || run.status === 'waiting';

/** The PR a URL points into, without a fragment or a trailing path. */
const canonicalPrUrl = (url: string): string | null => {
	const parts = parsePrUrl(url);
	return parts === null
		? null
		: `https://${parts.host}/${parts.owner}/${parts.name}/pull/${parts.number}`;
};

const branchKey = (projectKey: string, branch: string) => `${projectKey}#${branch}`;

/** The review a `ship review` run stored, once it ended. */
const storedReview = (run: RunInfo): ReviewId | null =>
	run.kind === 'review' && run.summary?.reviewId !== undefined ? run.summary.reviewId : null;

/** The PR a run opened or works on, as it says itself. */
const ownPrUrl = (run: RunInfo): string | null => {
	switch (run.kind) {
		case 'ship':
			return run.prUrl;
		case 'review':
		case 'fix':
		case 'recheck':
			return run.prUrl;
		case 'pr':
			return run.url;
		default:
			return null;
	}
};

const branchOf = (run: RunInfo): string | null => {
	switch (run.kind) {
		case 'ship':
			return run.branch;
		case 'review':
		case 'fix':
		case 'recheck':
			return null;
		default:
			return run.branch;
	}
};

/** Runs grouped into deliverables, and the deliverable each run belongs to. */
export interface Grouping {
	/** Newest activity first. */
	readonly deliverables: ReadonlyArray<Deliverable>;
	readonly deliverableOfRun: ReadonlyMap<RunId, DeliverableId>;
}

/**
 * Groups `runs` into deliverables, the one with the newest activity first. A run that
 * names a PR belongs to the PR's deliverable, and so does every run on a branch that a
 * `ship run` or `ship pr` opened that PR from. A `ship post` run belongs to the PR of the
 * review it posts, else to that review. A run with no PR belongs to its branch; review,
 * fix and recheck runs name no branch, so without a PR such a run stands alone.
 */
export const deliverablesOf = (runs: ReadonlyArray<RunInfo>): ReadonlyArray<Deliverable> =>
	groupingOf(runs).deliverables;

/** {@link deliverablesOf}, with the deliverable each run belongs to. */
export const groupingOf = (runs: ReadonlyArray<RunInfo>): Grouping => {
	const reviewPrs = new Map<string, string>();
	const branchPrs = new Map<string, string>();
	for (const run of runs) {
		const pr = ownPrUrl(run);
		const canonical = pr === null ? null : canonicalPrUrl(pr);
		if (canonical === null) continue;
		const review = storedReview(run);
		if (review !== null) reviewPrs.set(review, canonical);
		const branch = branchOf(run);
		if (branch !== null) branchPrs.set(branchKey(run.projectKey, branch), canonical);
	}

	const prOf = (run: RunInfo): string | null => {
		const own = ownPrUrl(run);
		if (own !== null) return canonicalPrUrl(own) ?? own;
		if (run.kind === 'post' && run.review !== null) {
			const reviewed = reviewPrs.get(run.review);
			if (reviewed !== undefined) return reviewed;
			// A posted review's URL points into its PR.
			if (run.url !== null) return canonicalPrUrl(run.url);
		}
		const branch = branchOf(run);
		return branch === null ? null : (branchPrs.get(branchKey(run.projectKey, branch)) ?? null);
	};

	const groups = new Map<DeliverableId, Array<RunInfo>>();
	const keyOf = (run: RunInfo): DeliverableId => {
		const pr = prOf(run);
		if (pr !== null) return DeliverableId.make(`pr:${pr}`);
		const branch = branchOf(run);
		if (branch !== null)
			return DeliverableId.make(`branch:${branchKey(run.projectKey, branch)}`);
		if (run.kind === 'post' && run.review !== null)
			return DeliverableId.make(`review:${run.review}`);
		return DeliverableId.make(`run:${run.runId}`);
	};
	for (const run of runs) {
		const key = keyOf(run);
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [run]);
		else group.push(run);
	}

	const deliverableOfRun = new Map<RunId, DeliverableId>();
	const deliverables = [...groups.entries()]
		.map(([id, group]): Deliverable => {
			for (const run of group) deliverableOfRun.set(run.runId, id);
			const newestFirst = group.toSorted((a, b) => millis(b.createdAt) - millis(a.createdAt));
			const pr = newestFirst.map(prOf).find((url) => url !== null) ?? null;
			return {
				id,
				projectKey: newestFirst[0]!.projectKey,
				branch: newestFirst.map(branchOf).find((branch) => branch !== null) ?? null,
				prUrl: pr,
				runs: newestFirst
			};
		})
		.toSorted(byActivity);
	return { deliverables, deliverableOfRun };
};

/**
 * Everything about a run that {@link groupingOf} reads to place it and its deliverable: its
 * kind, project and creation time, the PR, review and branch it names, and a post run's
 * review and URL. While these stay the same, so does every deliverable's id, membership,
 * run order, project, branch and PR.
 */
const groupingFacts = (run: RunInfo): string =>
	JSON.stringify([
		run.kind,
		run.projectKey,
		millis(run.createdAt),
		ownPrUrl(run),
		storedReview(run),
		branchOf(run),
		run.kind === 'post' ? [run.review, run.url] : null
	]);

/**
 * `grouping` with `run` added or updated: the deliverables grouping every run again gives.
 * Most updates change only a run's status, state or summary details: such a run is swapped
 * in place, and every other deliverable keeps its identity. A new run, or one whose
 * {@link groupingFacts} changed, can move runs between deliverables, so every run is
 * grouped again.
 */
export const withRun = (grouping: Grouping, run: RunInfo): Grouping => {
	const id = grouping.deliverableOfRun.get(run.runId);
	const owner = grouping.deliverables.find((deliverable) => deliverable.id === id);
	const previous = owner?.runs.find((candidate) => candidate.runId === run.runId);
	if (
		owner === undefined ||
		previous === undefined ||
		groupingFacts(previous) !== groupingFacts(run)
	) {
		const others = grouping.deliverables.flatMap((deliverable) =>
			deliverable.runs.filter((candidate) => candidate.runId !== run.runId)
		);
		return groupingOf([...others, run]);
	}
	const updated: Deliverable = {
		...owner,
		runs: owner.runs.map((candidate) => (candidate === previous ? run : candidate))
	};
	const deliverables = grouping.deliverables
		.map((deliverable) => (deliverable === owner ? updated : deliverable))
		.toSorted(byActivity);
	return { deliverables, deliverableOfRun: grouping.deliverableOfRun };
};

/** Newest activity first. */
const byActivity = (a: Deliverable, b: Deliverable): number =>
	millis(lastActivity(b)) - millis(lastActivity(a));

/** The latest update of any of the deliverable's runs. */
const lastActivity = (deliverable: Deliverable): DateTime.Utc =>
	deliverable.runs.reduce(
		(latest, run) => DateTime.max(latest, run.updatedAt),
		deliverable.runs[0]!.updatedAt
	);

const latestRun = (deliverable: Deliverable): RunInfo => deliverable.runs[0]!;

/** How many findings a finished review run found. */
const reviewFindings = (summary: ReviewSummary): number =>
	summary.mustFix.length + summary.tradeoffs.length + summary.nits.length;

/** A review run that stored findings it did not post: `ship post` would post them. */
const isUnposted = (run: RunInfo): boolean =>
	run.kind === 'review' &&
	run.status === 'done' &&
	run.reviewUrl === null &&
	run.summary !== null &&
	run.summary.reviewId !== undefined &&
	reviewFindings(run.summary) > 0;

/**
 * Whether a run left something behind: commits, a PR, a stored or posted review, or
 * resolved threads. A `ship run` has no commit list, so a completed check pass after the
 * baseline, which is followed by the commit, stands for one.
 */
const produced = (run: RunInfo): boolean => {
	switch (run.kind) {
		case 'ship':
			return (
				run.prUrl !== null || (run.summary?.checks.some((pass) => !pass.baseline) ?? false)
			);
		case 'review':
			return run.reviewUrl !== null || storedReview(run) !== null;
		case 'fix':
			return (run.summary?.commits.length ?? 0) > 0;
		case 'recheck':
			return (run.summary?.resolvedThreads.length ?? 0) > 0;
		default:
			return run.url !== null || (run.summary?.commits.length ?? 0) > 0;
	}
};

/** Cancelled before any of its runs produced anything: nothing is left to look at. */
const isAbandoned = (deliverable: Deliverable): boolean =>
	latestRun(deliverable).status === 'cancelled' && !deliverable.runs.some(produced);

/**
 * Whether the deliverable is archived. The developer's latest mark decides until a run
 * changes after it; an abandoned deliverable is archived without one.
 */
const isArchived = (deliverable: Deliverable, marks: ArchiveMarks): boolean => {
	const mark = marks.get(deliverable.id);
	if (mark !== undefined && millis(mark.at) >= millis(lastActivity(deliverable))) {
		return mark.archived;
	}
	return isAbandoned(deliverable);
};

/** Where the deliverable stands; see {@link Stage}. A deliverable ship works on is never closed. */
export const stageOf = (deliverable: Deliverable, marks: ArchiveMarks): Stage => {
	const latest = latestRun(deliverable);
	if (isActive(latest)) return 'working';
	if (isArchived(deliverable, marks)) return 'closed';
	switch (latest.status) {
		case 'escalated':
		case 'failed':
		case 'interrupted':
			return 'decide';
		default:
			return isUnposted(latest) ? 'decide' : 'ready';
	}
};

/** What the run is doing, from the first segment of its machine state. */
const activity = (run: RunInfo): string => {
	if (run.status === 'waiting') return 'Waiting for a check lock.';
	const step = run.state.split('.', 1)[0];
	switch (step) {
		case 'baseline':
			return 'Running the baseline checks.';
		case 'implement':
			return 'Implementing the plan.';
		case 'checks':
			return 'Running the checks.';
		case 'review':
			return run.round > 0 ? `Reviewing, round ${run.round}.` : 'Reviewing.';
		case 'triage':
			return 'Sorting the findings.';
		case 'fix':
			return 'Fixing the findings.';
		case 'escalate':
		case 'pr':
			return 'Opening the PR.';
		case 'post':
			return 'Posting the review.';
		case 'recheck':
			return 'Rechecking the findings.';
		case 'resolve':
			return 'Resolving the fixed threads.';
		case 'commit':
			return 'Committing the work.';
		case 'push':
			return 'Pushing the commits.';
		default:
			return `Working (${run.state}).`;
	}
};

const ESCALATIONS = {
	'check-fix-cap': 'checks still fail after the allowed fix attempts',
	'checks-unrelated': 'checks fail for reasons outside this change',
	'review-cap': 'must-fix findings are left after the last review round',
	stall: 'the same findings came back after a fix',
	timeout: 'a step timed out'
} as const;

/** A finished run's outcome, as one sentence about what it produced. */
const outcome = (run: RunInfo): string => {
	switch (run.kind) {
		case 'ship':
			return run.prUrl === null
				? 'Done, without a PR.'
				: (run.summary?.tradeoffs.length ?? 0) === 0
					? 'The PR is up, with no finding left.'
					: `The PR is up; its body lists ${plural(run.summary!.tradeoffs.length, 'tradeoff')} for you to accept.`;
		case 'review':
			if (run.reviewUrl !== null) return 'The review is posted on the PR.';
			if (run.summary === null || reviewFindings(run.summary) === 0) {
				return 'The review found nothing to fix.';
			}
			return `The review is stored but not posted: ${run.summary.mustFix.length} must-fix, ${plural(run.summary.tradeoffs.length, 'tradeoff')}, ${plural(run.summary.nits.length, 'nit')}.`;
		case 'fix': {
			const commits = run.summary?.commits.length ?? 0;
			if (commits === 0) return 'The fix made no commit.';
			return run.summary?.pushed === true
				? `${plural(commits, 'fix commit')} pushed to the PR.`
				: `${plural(commits, 'fix commit')}, kept local.`;
		}
		case 'recheck': {
			const findings = run.summary?.findings ?? [];
			const fixed = findings.filter((finding) => finding.status === 'fixed').length;
			return `${fixed} of ${plural(findings.length, 'finding')} fixed; ${plural(run.summary?.resolvedThreads.length ?? 0, 'thread')} resolved.`;
		}
		case 'implement':
		case 'checks': {
			const commits = run.summary?.commits.length ?? 0;
			return commits === 0
				? 'Done, with no commit.'
				: `Done in ${plural(commits, 'commit')}.`;
		}
		case 'pr':
			return run.url === null ? 'Done.' : 'The PR is up.';
		case 'post':
			return run.url === null ? 'Nothing was posted.' : 'The review is posted.';
	}
};

/** One sentence about the deliverable's output, from its latest run. */
export const headlineOf = (deliverable: Deliverable): string => {
	const latest = latestRun(deliverable);
	if (isActive(latest)) return activity(latest);
	switch (latest.status) {
		case 'interrupted':
			return 'Interrupted when the daemon stopped. Resume to continue where it was.';
		case 'failed':
			return `Failed: ${latest.summary?.error ?? 'see the run history'}. Resume retries the failed step.`;
		case 'escalated': {
			const reason =
				latest.kind === 'ship' ? (latest.summary?.escalationReason ?? null) : null;
			return `Stopped for you: ${reason === null ? 'ship needs a decision' : ESCALATIONS[reason]}.`;
		}
		case 'cancelled':
			return isAbandoned(deliverable)
				? 'Cancelled before it produced anything.'
				: `Cancelled. ${outcome(latest)}`;
		default:
			return outcome(latest);
	}
};

const toneAndTag = (deliverable: Deliverable, stage: Stage): readonly [Tone, string] => {
	const latest = latestRun(deliverable);
	switch (stage) {
		case 'working':
			return ['live', latest.status === 'waiting' ? 'waiting' : 'working'];
		case 'closed':
			return ['neutral', 'closed'];
		case 'decide':
			if (latest.status === 'failed' || latest.status === 'interrupted') {
				return ['error', latest.status];
			}
			if (latest.status === 'escalated') return ['must-fix', 'escalated'];
			return latest.kind === 'review' && (latest.summary?.mustFix.length ?? 0) > 0
				? ['must-fix', 'not posted']
				: ['tradeoff', 'not posted'];
		case 'ready':
			if (latest.status === 'cancelled') return ['ok', 'cancelled'];
			switch (latest.kind) {
				case 'review':
					return ['ok', latest.reviewUrl === null ? 'reviewed' : 'posted'];
				case 'post':
					return ['ok', 'posted'];
				case 'fix':
					return ['ok', 'fixed'];
				case 'recheck':
					return ['ok', 'rechecked'];
				default:
					return ['ok', deliverable.prUrl === null ? 'done' : 'PR open'];
			}
	}
};

/** An action the inbox offers, with what it acts on. */
export type Offer =
	| { readonly action: 'fix' | 'recheck'; readonly source: FindingsSource }
	| { readonly action: 'post'; readonly review: ReviewId }
	| { readonly action: 'resume' | 'cancel' | 'archive' | 'unarchive' };

/**
 * The actions the inbox offers at `stage`, the primary one first. `cancel` and `resume`
 * act on the latest run; `fix`, `recheck` and `post` start a run from its checkout.
 */
export const offersOf = (deliverable: Deliverable, stage: Stage): ReadonlyArray<Offer> => {
	if (stage === 'working') return [{ action: 'cancel' }];
	if (stage === 'closed') return [{ action: 'unarchive' }];
	const latest = latestRun(deliverable);
	const offers: Array<Offer> = [];
	if (latest.status === 'interrupted') offers.push({ action: 'resume' }, { action: 'cancel' });
	if (latest.status === 'failed') offers.push({ action: 'resume' });
	const review = isUnposted(latest) ? storedReview(latest) : null;
	if (review !== null) offers.push({ action: 'post', review });
	const source = deliverable.prUrl === null ? null : findingsSourceOf(deliverable);
	if (source !== null) {
		const fix = { action: 'fix', source } as const;
		const recheck = { action: 'recheck', source } as const;
		offers.push(...(latest.kind === 'fix' ? [recheck, fix] : [fix, recheck]));
	}
	offers.push({ action: 'archive' });
	return offers;
};

/**
 * Where `fix` and `recheck` take the deliverable's findings from: the latest review ship
 * stored, else the PR's open review threads. `null` without either.
 */
export const findingsSourceOf = (deliverable: Deliverable): FindingsSource | null => {
	const review = deliverable.runs.map(storedReview).find((id) => id !== null);
	if (review !== undefined) return FindingsSource.cases.Review.make({ reviewId: review });
	return deliverable.prUrl === null
		? null
		: FindingsSource.cases.PrThreads.make({ pr: deliverable.prUrl });
};

const planDirOf = (run: RunInfo): string | null => {
	switch (run.kind) {
		case 'review':
		case 'fix':
		case 'recheck':
			return null;
		default:
			return run.planDir;
	}
};

const lastSegment = (path: string) => path.split('/').findLast(Boolean) ?? path;

/** The name the inbox shows: the plan's, else the branch's, else the PR's. */
const titleOf = (deliverable: Deliverable): string => {
	const planDir = deliverable.runs.map(planDirOf).find((dir) => dir !== null);
	if (planDir !== undefined) return lastSegment(planDir);
	if (deliverable.branch !== null) return deliverable.branch;
	if (deliverable.prUrl !== null) {
		const pr = parsePrUrl(deliverable.prUrl);
		if (pr !== null) return `${pr.owner}/${pr.name}#${pr.number}`;
	}
	return deliverable.id.slice(deliverable.id.indexOf(':') + 1);
};

/** The deliverable as the inbox lists it, given the developer's archive marks. */
export const summarize = (deliverable: Deliverable, marks: ArchiveMarks): DeliverableSummary => {
	const stage = stageOf(deliverable, marks);
	const [tone, tag] = toneAndTag(deliverable, stage);
	return {
		id: deliverable.id,
		projectName: lastSegment(deliverable.projectKey),
		title: titleOf(deliverable),
		branch: deliverable.branch,
		prUrl: deliverable.prUrl,
		stage,
		tone,
		tag,
		headline: headlineOf(deliverable),
		updatedAt: DateTime.formatIso(lastActivity(deliverable)),
		actions: offersOf(deliverable, stage).map((offer) => offer.action)
	};
};

const NO_FINDINGS: OpenFindings = { mustFix: [], tradeoffs: [], nits: [], settled: true };

const bySeverity = (findings: ReadonlyArray<VerifiedFinding>, settled: boolean): OpenFindings => ({
	mustFix: findings.filter((finding) => finding.severity === 'must-fix'),
	tradeoffs: findings.filter((finding) => finding.severity === 'tradeoff'),
	nits: findings.filter((finding) => finding.severity === 'nit'),
	settled
});

/** What a run still reviewing found so far: the latest triage, else every verified finding. */
const findingsSoFar = (events: RunWithEvents['events']): OpenFindings | null => {
	const verified = new Map(
		events.flatMap((event) =>
			event._tag === 'FindingsVerified'
				? event.verified.map((finding) => [finding.id, finding] as const)
				: []
		)
	);
	const triaged = events.findLast((event) => event._tag === 'FindingsTriaged');
	if (triaged !== undefined) {
		const lookup = (ids: ReadonlyArray<FindingId>) =>
			ids.flatMap((id) => {
				const finding = verified.get(id);
				return finding === undefined ? [] : [finding];
			});
		return {
			mustFix: lookup(triaged.mustFix),
			tradeoffs: lookup(triaged.tradeoffs),
			nits: lookup(triaged.nits),
			settled: true
		};
	}
	return verified.size === 0 ? null : bySeverity([...verified.values()], false);
};

/**
 * What one run says is left open, or `null` when it says nothing about findings. A ship or
 * review run answers from its summary once it ended, and from its events while it goes; a
 * recheck run only from its summary; a fix run that is done leaves nothing known open.
 */
const findingsOfRun = ({ info, events }: RunWithEvents): OpenFindings | null => {
	switch (info.kind) {
		case 'ship':
			return info.summary === null
				? findingsSoFar(events)
				: {
						mustFix: info.summary.unresolvedMustFix,
						tradeoffs: info.summary.tradeoffs,
						nits: info.summary.nits,
						settled: true
					};
		case 'review':
			return info.summary === null
				? findingsSoFar(events)
				: {
						mustFix: info.summary.mustFix,
						tradeoffs: info.summary.tradeoffs,
						nits: info.summary.nits,
						settled: true
					};
		case 'recheck':
			return info.summary === null
				? null
				: bySeverity(
						info.summary.findings
							.filter((finding) => finding.status === 'unfixed')
							.map((finding) => finding.finding),
						true
					);
		case 'fix':
			// A finished fix leaves nothing known open until a recheck says otherwise.
			return info.status === 'done' ? NO_FINDINGS : null;
		default:
			return null;
	}
};

/** The findings left for the developer: what the newest run that speaks of findings says. */
export const openFindings = (runs: ReadonlyArray<RunWithEvents>): OpenFindings => {
	for (const run of runs.toSorted(
		(a, b) => millis(b.info.createdAt) - millis(a.info.createdAt)
	)) {
		const findings = findingsOfRun(run);
		if (findings !== null) return findings;
	}
	return NO_FINDINGS;
};
