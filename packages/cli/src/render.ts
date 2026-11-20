import type {
	ReviewSummary,
	RunEvent,
	RunInfo,
	RunStatus,
	ShipSummary,
	Summary,
	UnknownEvent
} from '@ship/core/contract';
import { DateTime } from 'effect';

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const usd = (cost: number) => `$${cost.toFixed(2)}`;
const shortSha = (sha: string) => sha.slice(0, 7);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** Keeps event lines to one line; `ship logs --json` has the full text. */
const firstLine = (text: string) => text.split('\n', 1)[0] ?? '';
const clock = (at: DateTime.Utc) => DateTime.formatIso(at).slice(11, 19);

/**
 * Turns a run's events into one-line descriptions, or `null` for events not worth a line
 * (step starts, lock releases, uncontended lock acquisitions). Keeps the running cost
 * total, so use one formatter per run, fed every event in order.
 */
export const makeEventFormatter = () => {
	let totalCost = 0;
	const describe = (event: RunEvent | UnknownEvent): string | null => {
		switch (event._tag) {
			case 'RunCreated':
				return `run created on ${event.branch} at ${shortSha(event.baseSha)}`;
			case 'ReviewRunCreated':
				return `review of ${event.prUrl} created for ${shortSha(event.baseSha)}..${shortSha(event.headSha)}`;
			case 'StateChanged':
				return `state ${event.from} -> ${event.to}`;
			case 'StepStarted':
				return null;
			case 'StepEnded':
				return event.outcome === 'ok' || event.outcome === 'interrupted'
					? null
					: `step ${event.step} ${event.outcome} after ${seconds(event.durationMs)}${event.error === undefined ? '' : `: ${firstLine(event.error)}`}`;
			case 'CheckStarted':
				return null;
			case 'CheckFinished': {
				const what = `${event.baseline ? 'baseline ' : ''}${event.command === 'fix' ? 'fix for ' : ''}check ${event.check}`;
				return event.exitCode === 0
					? `${what} passed (${seconds(event.durationMs)})`
					: `${what} failed with exit code ${event.exitCode} (${seconds(event.durationMs)})`;
			}
			case 'LockWaiting':
				return `check ${event.check} waiting for lock ${event.resource}${event.position === undefined ? '' : ` (position ${event.position})`}`;
			case 'LockAcquired':
				return event.waitedMs === 0
					? null
					: `check ${event.check} got lock ${event.resource} after ${seconds(event.waitedMs)}`;
			case 'LockReleased':
				return null;
			case 'ReviewStarted':
				return `review round ${event.round} of ${shortSha(event.fromSha)}..${shortSha(event.toSha)}: ${event.reviewers.length === 0 ? 'no reviewers' : event.reviewers.join(', ')}`;
			case 'FindingsReported':
				return `${event.reviewer} reported ${plural(event.findings.length, 'finding')}`;
			case 'FindingsVerified':
				return `verified ${plural(event.verified.length, 'finding')}, disproved ${event.disproved.length}`;
			case 'FindingsTriaged':
				return `round ${event.round}: ${event.mustFix.length} must-fix, ${plural(event.tradeoffs.length, 'tradeoff')}, ${plural(event.nits.length, 'nit')}`;
			case 'Escalated':
				return `escalated: ${event.reason}`;
			case 'AgentCost':
				totalCost += event.costUsd;
				return `${event.step} cost ${usd(event.costUsd)} (total ${usd(totalCost)})`;
			case 'CommitCreated':
				return `commit ${shortSha(event.sha)} ${firstLine(event.message)}`;
			case 'PrOpened':
				return `${event.draft ? 'draft ' : ''}PR opened: ${event.url}`;
			case 'PrReviewPosted':
				return `review posted (${event.event === 'REQUEST_CHANGES' ? 'changes requested' : 'comment'}, ${plural(event.inline, 'inline comment')}, ${event.inBody} in the body): ${event.url}`;
			case 'RunFinished': {
				const url =
					event.summary.kind === 'review' ? event.summary.reviewUrl : event.summary.prUrl;
				return `run ${event.summary.status}${url === null ? '' : `: ${url}`}`;
			}
			case 'RunInterrupted':
				return 'run interrupted';
			case 'RunResumed':
				return 'run resumed';
			case 'RunCancelled':
				return 'run cancelled';
			case 'UnknownEvent':
				return `unknown event ${event.type}`;
		}
	};
	return (event: RunEvent | UnknownEvent): string | null => {
		const line = describe(event);
		if (line === null) return null;
		return 'at' in event ? `${clock(event.at)} ${line}` : line;
	};
};

/** Pads columns to their widest cell; the last column is not padded. */
export const table = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
	const widths: Array<number> = [];
	for (const row of rows) {
		row.forEach((cell, index) => {
			widths[index] = Math.max(widths[index] ?? 0, cell.length);
		});
	}
	return rows
		.map((row) =>
			row
				.map((cell, index) =>
					index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)
				)
				.join('  ')
		)
		.join('\n');
};

const when = (at: DateTime.Utc) => DateTime.formatIso(at).slice(0, 19).replace('T', ' ');

/** What a run works on: a `ship run`'s branch, or the PR a review run reviews. */
const subject = (run: RunInfo): string => (run.kind === 'review' ? run.prUrl : run.branch);

/** What a run produced: the PR a `ship run` opened, or the review a review run posted. */
const output = (run: RunInfo): string | null => (run.kind === 'review' ? run.reviewUrl : run.prUrl);

/** One row per run, most recent first, as the daemon lists them. */
export const runTable = (runs: ReadonlyArray<RunInfo>): string =>
	table([
		['RUN', 'KIND', 'STATUS', 'STATE', 'SUBJECT', 'UPDATED', 'PR'],
		...runs.map((run) => [
			run.runId,
			run.kind,
			run.status,
			run.state,
			subject(run),
			when(run.updatedAt),
			output(run) ?? '-'
		])
	]);

/** `label:` and one line per finding; nothing when there are none. */
const findingLines = (label: string, list: Summary['nits']): Array<string> =>
	list.length === 0
		? []
		: [
				`${label}:`,
				...list.map(
					(finding) =>
						`  ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`} ${finding.claim}`
				)
			];

const shipSummaryLines = (summary: ShipSummary): Array<string> => [
	`cost: ${usd(summary.costUsd)}`,
	`review rounds: ${summary.rounds}`,
	...(summary.escalationReason === null ? [] : [`escalated: ${summary.escalationReason}`]),
	...(summary.error === null ? [] : [`error: ${summary.error}`]),
	...findingLines('unresolved must-fix', summary.unresolvedMustFix),
	...findingLines('tradeoffs', summary.tradeoffs),
	...findingLines('unresolved nits', summary.nits)
];

const reviewSummaryLines = (summary: ReviewSummary): Array<string> => [
	`cost: ${usd(summary.costUsd)}`,
	...(summary.error === null ? [] : [`error: ${summary.error}`]),
	...findingLines('must-fix', summary.mustFix),
	...findingLines('tradeoffs', summary.tradeoffs),
	...findingLines('nits', summary.nits)
];

/** A run's details for `ship status <id>`. */
export const runDetails = (run: RunInfo): string =>
	[
		`run: ${run.runId}`,
		`kind: ${run.kind}`,
		`status: ${run.status}`,
		`state: ${run.state}`,
		`project: ${run.projectKey}`,
		`cwd: ${run.cwd}`,
		...(run.kind === 'review'
			? [`pr: ${run.prUrl}`, `review: ${run.reviewUrl ?? '-'}`]
			: [
					`branch: ${run.branch}`,
					`plan: ${run.planDir}`,
					`round: ${run.round}`,
					`pr: ${run.prUrl ?? '-'}`
				]),
		`created: ${when(run.createdAt)}`,
		`updated: ${when(run.updatedAt)}`,
		...(run.summary === null
			? []
			: run.summary.kind === 'review'
				? reviewSummaryLines(run.summary)
				: shipSummaryLines(run.summary))
	].join('\n');

/**
 * The exit code for the status a run ended with: 0 done, 2 escalated (a draft PR is
 * up), 1 otherwise. A review run that is done exits by its findings instead; see
 * {@link exitCodeForSummary}. A run still active when its event stream
 * ended did not end at all, so that is 1 too.
 */
export const exitCodeFor = (status: RunStatus): number => {
	switch (status) {
		case 'done':
			return 0;
		case 'escalated':
			return 2;
		case 'failed':
		case 'cancelled':
		case 'interrupted':
		case 'running':
		case 'waiting':
			return 1;
	}
};

/**
 * The exit code for the summary a run ended with. A `ship review` run that is done exits 2
 * when it verified must-fix findings and 0 otherwise; anything else exits with the code
 * {@link exitCodeFor} gives its status.
 */
export const exitCodeForSummary = (summary: Summary): number =>
	summary.kind === 'review' && summary.status === 'done'
		? summary.mustFix.length > 0
			? 2
			: 0
		: exitCodeFor(summary.status);

/**
 * Exit code when Ctrl-C (or SIGTERM) ends a command: 130, the shell convention for a command
 * ended by SIGINT, distinct from the run outcomes 0, 1 and 2. `ship run`, `ship review`
 * and `ship resume` detach from a run that already started, so it keeps going.
 */
export const DETACHED_EXIT_CODE = 130;
