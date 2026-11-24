/**
 * One-line descriptions of run events, as `ship run` and `ship logs` print them and the UI's
 * run history lists them.
 */
import { DateTime } from 'effect';
import type { RunEvent, UnknownEvent } from './event.ts';
import type { Summary } from './run.ts';

/** A duration in milliseconds as seconds with one decimal, e.g. `1.5s`. */
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
/** A cost in US dollars, e.g. `$0.42`. */
export const usd = (cost: number) => `$${cost.toFixed(2)}`;
/** The first seven characters of a commit sha. */
export const shortSha = (sha: string) => sha.slice(0, 7);
/** `count` and `word`, with an `s` unless the count is one, e.g. `2 rounds`. */
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** Keeps event lines to one line; `ship logs --json` has the full text. */
const firstLine = (text: string) => text.split('\n', 1)[0] ?? '';
/** Notes the review threads a fix or recheck left out, written by someone who may not push. */
const ignoredNote = (urls: ReadonlyArray<string>) =>
	urls.length === 0
		? ''
		: `; ignored ${plural(urls.length, 'thread')} by authors who may not push`;
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
			case 'PrRunCreated':
				return `${event.kind} of ${plural(event.findings.length, 'finding')} on ${event.prUrl} created at ${shortSha(event.headSha)}${ignoredNote(event.ignoredThreads)}`;
			case 'PrimitiveRunCreated':
				return `${event.kind} created${event.branch === null ? '' : ` on ${event.branch}`} at ${shortSha(event.baseSha)}${event.review === null ? '' : ` for review ${event.review}`}`;
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
			case 'ReviewStored':
				return `review stored as ${event.reviewId}`;
			case 'PrReviewPosted':
				return `review posted (${event.event === 'REQUEST_CHANGES' ? 'changes requested' : 'comment'}, ${plural(event.inline, 'inline comment')}, ${event.inBody} in the body): ${event.url}`;
			case 'FindingsRechecked': {
				const fixed = event.findings.filter((finding) => finding.status === 'fixed');
				return `rechecked ${plural(event.findings.length, 'finding')}: ${fixed.length} fixed, ${event.findings.length - fixed.length} unfixed`;
			}
			case 'ThreadResolved':
				return `resolved the thread of ${event.findingId}`;
			case 'BranchPushed':
				return `pushed ${shortSha(event.sha)} to ${event.ref}`;
			case 'RunFinished': {
				const url = summaryUrl(event.summary);
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

/** The URL a finished run points to: the review it posted, or its PR. */
const summaryUrl = (summary: Summary): string | null => {
	switch (summary.kind) {
		case 'review':
			return summary.reviewUrl;
		case 'implement':
		case 'checks':
		case 'pr':
		case 'post':
			return summary.reviewUrl ?? summary.prUrl;
		default:
			return summary.prUrl;
	}
};
