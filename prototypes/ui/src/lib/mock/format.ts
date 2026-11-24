import { NOW } from './data.ts';
import type { RunEvent } from './types.ts';

export const relTime = (iso: string): string => {
	const s = Math.round((NOW.getTime() - new Date(iso).getTime()) / 1000);
	if (s < 60) return `${Math.max(s, 0)}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
};

export const duration = (ms: number): string => {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

export const clock = (iso: string): string => new Date(iso).toISOString().slice(11, 19);

export const usd = (n: number): string => `$${n.toFixed(2)}`;

export const shortSha = (sha: string): string => sha.slice(0, 7);

export const elapsed = (fromIso: string, toIso: string): string =>
	duration(new Date(toIso).getTime() - new Date(fromIso).getTime());

/** One line per event, the way `ship logs` prints them on stderr. */
export const describe = (e: RunEvent): string => {
	switch (e._tag) {
		case 'RunCreated':
			return `run created on ${e.branch} from ${e.planDir}`;
		case 'ReviewRunCreated':
			return `review of PR #${e.prNumber} at ${shortSha(e.headSha)}`;
		case 'StateChanged':
			return `${e.from} → ${e.to}`;
		case 'StepStarted':
			return `${e.step} started`;
		case 'StepEnded':
			return `${e.step} ${e.outcome} in ${duration(e.durationMs)}${e.error ? `: ${e.error}` : ''}`;
		case 'CheckStarted':
			return `${e.baseline ? 'baseline ' : ''}${e.check}${e.command === 'fix' ? ' (fix)' : ''}: ${e.commandLine}`;
		case 'CheckFinished':
			return `${e.baseline ? 'baseline ' : ''}${e.check}${e.command === 'fix' ? ' (fix)' : ''} ${e.exitCode === 0 ? 'passed' : `failed (exit ${e.exitCode})`} in ${duration(e.durationMs)}`;
		case 'LockWaiting':
			return `${e.check} waiting for ${e.resource}${e.position ? ` (#${e.position} in queue)` : ''}`;
		case 'LockAcquired':
			return `${e.check} acquired ${e.resource}${e.waitedMs ? ` after ${duration(e.waitedMs)}` : ''}`;
		case 'LockReleased':
			return `${e.check} released ${e.resource}`;
		case 'ReviewStarted':
			return `review round ${e.round}: ${e.reviewers.join(', ')}`;
		case 'FindingsReported':
			return `${e.reviewer} reported ${e.count} finding${e.count === 1 ? '' : 's'}`;
		case 'FindingsVerified':
			return `verifier kept ${e.verified.length}, disproved ${e.disproved}`;
		case 'FindingsTriaged':
			return `triage: ${e.mustFix.length} must-fix, ${e.tradeoffs.length} tradeoff, ${e.nits.length} nit`;
		case 'ClefDecision':
			return `clef ${e.decision}: ${e.detail}`;
		case 'Escalated':
			return `escalated: ${e.reason}`;
		case 'AgentCost':
			return `${e.step} cost $${e.costUsd.toFixed(2)} (${e.model})`;
		case 'CommitCreated':
			return `commit ${shortSha(e.sha)} ${e.message}`;
		case 'BranchPushed':
			return `pushed ${shortSha(e.sha)} to ${e.remote}/${e.ref}`;
		case 'PrOpened':
			return `${e.draft ? 'draft ' : ''}PR opened: ${e.url}`;
		case 'ReviewStored':
			return `review stored: ${e.reviewId}`;
		case 'PrReviewPosted':
			return `review posted (${e.event}): ${e.inline} inline, ${e.inBody} in body`;
		case 'RunFinished':
			return `run finished: ${e.status}`;
		case 'RunInterrupted':
			return 'run interrupted (daemon stopped)';
		case 'RunResumed':
			return 'run resumed';
		case 'RunCancelled':
			return 'run cancelled';
	}
};

/** The `ship` command line that started a run. */
export const commandFor = (r: {
	kind: string;
	planDir: string | null;
	prNumber: number | null;
	reviewId: string | null;
}): string => {
	switch (r.kind) {
		case 'ship':
			return `ship run ${r.planDir}`;
		case 'implement':
			return `ship implement ${r.planDir}`;
		case 'review':
		case 'fix':
		case 'recheck':
			return `ship ${r.kind} ${r.prNumber}`;
		case 'post':
			return `ship post ${r.reviewId}`;
		default:
			return `ship ${r.kind}`;
	}
};
