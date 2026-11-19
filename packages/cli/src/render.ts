import type { RunEvent, RunInfo, RunStatus, Summary, UnknownEvent } from '@ship/core/contract';
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
			case 'RunFinished':
				return `run ${event.summary.status}${event.summary.prUrl === null ? '' : `: ${event.summary.prUrl}`}`;
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

/** One row per run, most recent first, as the daemon lists them. */
export const runTable = (runs: ReadonlyArray<RunInfo>): string =>
	table([
		['RUN', 'STATUS', 'STATE', 'BRANCH', 'UPDATED', 'PR'],
		...runs.map((run) => [
			run.runId,
			run.status,
			run.state,
			run.branch,
			when(run.updatedAt),
			run.prUrl ?? '-'
		])
	]);

const summaryLines = (summary: Summary): Array<string> => {
	const lines = [`cost: ${usd(summary.costUsd)}`, `review rounds: ${summary.rounds}`];
	if (summary.escalationReason !== null) lines.push(`escalated: ${summary.escalationReason}`);
	if (summary.error !== null) lines.push(`error: ${summary.error}`);
	const findings = (label: string, list: Summary['nits']) => {
		if (list.length === 0) return;
		lines.push(`${label}:`);
		for (const finding of list) {
			lines.push(
				`  ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`} ${finding.claim}`
			);
		}
	};
	findings('unresolved must-fix', summary.unresolvedMustFix);
	findings('tradeoffs', summary.tradeoffs);
	findings('unresolved nits', summary.nits);
	return lines;
};

/** A run's details for `ship status <id>`. */
export const runDetails = (run: RunInfo): string =>
	[
		`run: ${run.runId}`,
		`status: ${run.status}`,
		`state: ${run.state}`,
		`project: ${run.projectKey}`,
		`branch: ${run.branch}`,
		`cwd: ${run.cwd}`,
		`plan: ${run.planDir}`,
		`round: ${run.round}`,
		`pr: ${run.prUrl ?? '-'}`,
		`created: ${when(run.createdAt)}`,
		`updated: ${when(run.updatedAt)}`,
		...(run.summary === null ? [] : summaryLines(run.summary))
	].join('\n');

/**
 * The exit code of `ship run` and `ship resume` for the status the run ended with: 0 done,
 * 2 escalated (a draft PR is up), 1 otherwise. A run still active when its event stream
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
 * Exit code when Ctrl-C (or SIGTERM) ends a command: 130, the shell convention for a command
 * ended by SIGINT, distinct from the run outcomes 0, 1 and 2. `ship run` and `ship resume`
 * detach from a run that already started, so it keeps going.
 */
export const DETACHED_EXIT_CODE = 130;
