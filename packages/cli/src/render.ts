import type {
	FixSummary,
	PrimitiveSummary,
	RecheckSummary,
	ReviewSummary,
	RunInfo,
	RunStatus,
	ShipSummary,
	Summary
} from '@ship/core/contract';
import { shortSha, usd } from '@ship/core/event-lines';
import { DateTime } from 'effect';

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

/**
 * What a run works on: a `ship run`'s branch, the PR a review, fix or recheck is about,
 * the branch of `ship implement`, `ship checks` and `ship pr`, or the review `ship post` posts.
 */
const subject = (run: RunInfo): string => {
	switch (run.kind) {
		case 'ship':
			return run.branch;
		case 'review':
		case 'fix':
		case 'recheck':
			return run.prUrl;
		default:
			return run.branch ?? run.review ?? '-';
	}
};

/**
 * What a run produced: the PR a `ship run` opened, or the review a review run posted.
 * Fix and recheck runs work on a PR that already exists, so they have nothing to show.
 */
const output = (run: RunInfo): string | null => {
	switch (run.kind) {
		case 'ship':
			return run.prUrl;
		case 'review':
			return run.reviewUrl;
		case 'fix':
		case 'recheck':
			return null;
		default:
			return run.url;
	}
};

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
const findingLines = (label: string, list: ShipSummary['nits']): Array<string> =>
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

/** The threads left out as written by someone who may not push to the repository. */
const ignoredLines = (urls: ReadonlyArray<string>): Array<string> =>
	urls.length === 0
		? []
		: ['ignored threads (author may not push):', ...urls.map((url) => `  ${url}`)];

const fixSummaryLines = (summary: FixSummary): Array<string> => [
	`cost: ${usd(summary.costUsd)}`,
	...(summary.error === null ? [] : [`error: ${summary.error}`]),
	`commits: ${summary.commits.length === 0 ? '-' : summary.commits.map(shortSha).join(', ')}`,
	`pushed: ${summary.pushed ? 'yes' : 'no'}`,
	...findingLines('findings', summary.findings),
	...ignoredLines(summary.ignoredThreads)
];

const recheckSummaryLines = (summary: RecheckSummary): Array<string> => {
	const withStatus = (status: 'fixed' | 'unfixed') =>
		summary.findings
			.filter((finding) => finding.status === status)
			.map((finding) => finding.finding);
	return [
		`cost: ${usd(summary.costUsd)}`,
		...(summary.error === null ? [] : [`error: ${summary.error}`]),
		`resolved threads: ${summary.resolvedThreads.length}`,
		...findingLines('fixed', withStatus('fixed')),
		...findingLines('unfixed', withStatus('unfixed')),
		...ignoredLines(summary.ignoredThreads)
	];
};

const primitiveSummaryLines = (summary: PrimitiveSummary): Array<string> => {
	const last = summary.checks.at(-1);
	return [
		`cost: ${usd(summary.costUsd)}`,
		...(summary.error === null ? [] : [`error: ${summary.error}`]),
		`commits: ${summary.commits.length === 0 ? '-' : summary.commits.map(shortSha).join(', ')}`,
		...(last === undefined
			? []
			: [
					`checks: ${last.results.map((result) => `${result.name} ${result.exitCode === 0 ? 'passed' : 'failed'}`).join(', ')}`
				]),
		...(summary.prUrl === null ? [] : [`pr: ${summary.prUrl}`]),
		...(summary.reviewUrl === null ? [] : [`review: ${summary.reviewUrl}`])
	];
};

const summaryLines = (summary: Summary): Array<string> => {
	switch (summary.kind) {
		case 'review':
			return reviewSummaryLines(summary);
		case 'fix':
			return fixSummaryLines(summary);
		case 'recheck':
			return recheckSummaryLines(summary);
		case 'implement':
		case 'checks':
		case 'pr':
		case 'post':
			return primitiveSummaryLines(summary);
		default:
			return shipSummaryLines(summary);
	}
};

/** The lines that tell a run of one kind from another in `ship status <id>`. */
const kindLines = (run: RunInfo): Array<string> => {
	switch (run.kind) {
		case 'review':
			return [`pr: ${run.prUrl}`, `review: ${run.reviewUrl ?? '-'}`];
		case 'fix':
		case 'recheck':
			return [`pr: ${run.prUrl}`];
		case 'ship':
			return [
				`branch: ${run.branch}`,
				`plan: ${run.planDir}`,
				`round: ${run.round}`,
				`pr: ${run.prUrl ?? '-'}`
			];
		default:
			return [
				...(run.branch === null ? [] : [`branch: ${run.branch}`]),
				...(run.planDir === null ? [] : [`plan: ${run.planDir}`]),
				...(run.review === null ? [] : [`review: ${run.review}`]),
				...(run.url === null
					? []
					: [`${run.kind === 'post' ? 'review' : 'pr'} url: ${run.url}`])
			];
	}
};

/** A run's details for `ship status <id>`. */
export const runDetails = (run: RunInfo): string =>
	[
		`run: ${run.runId}`,
		`kind: ${run.kind}`,
		`status: ${run.status}`,
		`state: ${run.state}`,
		`project: ${run.projectKey}`,
		`cwd: ${run.cwd}`,
		...kindLines(run),
		`created: ${when(run.createdAt)}`,
		`updated: ${when(run.updatedAt)}`,
		...(run.summary === null ? [] : summaryLines(run.summary))
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
 * when it verified must-fix findings, and a `ship recheck` run that is done exits 2 when
 * a finding is still unfixed; both exit 0 otherwise. Anything else exits with the code
 * {@link exitCodeFor} gives its status.
 */
export const exitCodeForSummary = (summary: Summary): number => {
	if (summary.status !== 'done') return exitCodeFor(summary.status);
	switch (summary.kind) {
		case 'review':
			return summary.mustFix.length > 0 ? 2 : 0;
		case 'recheck':
			return summary.findings.some((finding) => finding.status === 'unfixed') ? 2 : 0;
		default:
			return exitCodeFor(summary.status);
	}
};

/**
 * Exit code when Ctrl-C (or SIGTERM) ends a command: 130, the shell convention for a command
 * ended by SIGINT, distinct from the run outcomes 0, 1 and 2. Every command that starts or
 * resumes a run detaches from it instead, so it keeps going.
 */
export const DETACHED_EXIT_CODE = 130;
