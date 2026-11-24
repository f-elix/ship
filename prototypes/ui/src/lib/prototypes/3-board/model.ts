import { PIPELINE_STATES, projectByKey, relTime } from '#lib';
import type { EscalationReason, Project, Run, RunEvent, RunEventTag, Severity } from '#lib';

export type ColumnId =
	| 'baseline'
	| 'implement'
	| 'checks'
	| 'review'
	| 'fix'
	| 'pr'
	| 'needs'
	| 'shipped';

export interface Column {
	id: ColumnId;
	label: string;
	color: string;
	terminal: boolean;
}

export const COLUMNS: Column[] = [
	{ id: 'baseline', label: 'Baseline', color: '#64748b', terminal: false },
	{ id: 'implement', label: 'Implement', color: '#7c5cff', terminal: false },
	{ id: 'checks', label: 'Checks', color: '#e08a00', terminal: false },
	{ id: 'review', label: 'Review', color: '#0a8ad2', terminal: false },
	{ id: 'fix', label: 'Fix', color: '#e5603b', terminal: false },
	{ id: 'pr', label: 'PR', color: '#12a36b', terminal: false },
	{ id: 'needs', label: 'Needs you', color: '#e5484d', terminal: true },
	{ id: 'shipped', label: 'Shipped', color: '#8a8fa3', terminal: true }
];

export const STAGE_COLOR: Record<string, string> = {
	baseline: '#64748b',
	implement: '#7c5cff',
	checks: '#e08a00',
	review: '#0a8ad2',
	triage: '#3f6ee8',
	fix: '#e5603b',
	pr: '#12a36b'
};

export const PROJECT_COLOR: Record<string, string> = {
	ship: '#3e63dd',
	storefront: '#d6409f',
	'billing-api': '#0f9b8e'
};

export const SEVERITIES: Severity[] = ['must-fix', 'tradeoff', 'nit'];
export const SEVERITY_COLOR: Record<Severity, string> = {
	'must-fix': '#e5484d',
	tradeoff: '#e08a00',
	nit: '#9298ad'
};

export const projectOf = (run: Run): Project => projectByKey(run.projectKey)!;
export const projectColor = (run: Run): string => PROJECT_COLOR[projectOf(run).name] ?? '#5b4bff';

const isStage = (s: string): boolean => (PIPELINE_STATES as readonly string[]).includes(s);

/** The pipeline stage a dotted machine state belongs to, or null for terminal states. */
export const topStage = (state: string): string | null => {
	const s = state.split('.')[0];
	if (s === 'recheck') return 'review';
	return isStage(s) ? s : null;
};

export const columnOf = (run: Run): ColumnId => {
	if (run.status === 'done' || run.status === 'cancelled') return 'shipped';
	if (run.status === 'escalated' || run.status === 'failed' || run.status === 'interrupted')
		return 'needs';
	const top = run.state.split('.')[0];
	switch (top) {
		case 'baseline':
			return 'baseline';
		case 'implement':
			return 'implement';
		case 'checks':
			return 'checks';
		case 'review':
		case 'triage':
		case 'recheck':
			return 'review';
		case 'fix':
			return 'fix';
		case 'pr':
			return 'pr';
		default:
			return 'needs';
	}
};

export type DotState = 'done' | 'current' | 'waiting' | 'blocked' | 'skip' | 'todo';

export const stageDots = (run: Run): { stage: string; state: DotState }[] => {
	const visited = new Set<string>();
	for (const e of run.events) {
		if (e._tag !== 'StateChanged') continue;
		const t = topStage(e.to);
		if (t) visited.add(t);
	}
	const cur = topStage(run.state);
	if (cur) visited.add(cur);
	const active = run.status === 'running' || run.status === 'waiting';
	const blocked =
		run.status === 'failed' || run.status === 'escalated' || run.status === 'interrupted';
	const finished = run.status === 'done' || run.status === 'cancelled';
	let last = -1;
	PIPELINE_STATES.forEach((s, i) => {
		if (visited.has(s)) last = i;
	});
	return PIPELINE_STATES.map((stage, i) => {
		let state: DotState;
		if (active && stage === cur) state = run.status === 'waiting' ? 'waiting' : 'current';
		else if (blocked && i === last) state = 'blocked';
		else if (visited.has(stage)) state = 'done';
		else if (i < last || finished) state = 'skip';
		else state = 'todo';
		return { stage, state };
	});
};

export const latestRound = (run: Run): number =>
	run.findings.reduce((m, f) => Math.max(m, f.round), 0);

export const severityCounts = (run: Run): Record<Severity, number> => {
	const round = latestRound(run);
	const counts: Record<Severity, number> = { 'must-fix': 0, tradeoff: 0, nit: 0 };
	for (const f of run.findings) if (f.round === round) counts[f.severity]++;
	return counts;
};

export const roundLabel = (run: Run): string | null => {
	if (run.round <= 0) return null;
	if (run.kind === 'ship') return `round ${run.round}/${projectOf(run).caps.reviewRounds}`;
	return `round ${run.round}`;
};

export const lockWait = (run: Run): { resource: string; position?: number } | null => {
	if (run.state !== 'checks.waiting') return null;
	const e = run.events.findLast((x) => x._tag === 'LockWaiting');
	return e?._tag === 'LockWaiting' ? { resource: e.resource, position: e.position } : null;
};

export const REASON: Record<EscalationReason, { label: string; detail: string }> = {
	'review-cap': {
		label: 'Review cap reached',
		detail:
			'Must-fix findings were still open after the last review round. ship opened a draft PR that lists the unresolved findings.'
	},
	'check-fix-cap': {
		label: 'Check-fix attempts used up',
		detail: 'Checks still failed after the last check-fix attempt.'
	},
	'checks-unrelated': {
		label: 'Checks look unrelated',
		detail:
			'Clef rated every failing check as unrelated to the change (≥ 0.7), and a clean re-run failed again.'
	},
	stall: { label: 'Agent stalled', detail: 'The agent stopped making progress.' },
	timeout: { label: 'Timed out', detail: 'A step ran past its timeout.' }
};

export const attention = (run: Run): { label: string; detail: string } | null => {
	if (run.status === 'escalated' && run.escalationReason) return REASON[run.escalationReason];
	if (run.status === 'failed')
		return { label: 'Failed', detail: run.error ?? 'The run failed. ship resume retries the failed step.' };
	if (run.status === 'interrupted')
		return {
			label: 'Interrupted',
			detail: 'The daemon stopped mid-run. ship resume continues from the last checkpoint.'
		};
	return null;
};

export const ago = (iso: string): string => {
	const t = relTime(iso);
	return t === '0s ago' ? 'just now' : t;
};

export const lastEvent = (run: Run): RunEvent => run.events.at(-1)!;

export type Tone =
	| 'state'
	| 'check'
	| 'fail'
	| 'lock'
	| 'review'
	| 'clef'
	| 'cost'
	| 'git'
	| 'warn'
	| 'run'
	| 'step';

export const eventTone = (e: RunEvent): Tone => {
	const tag: RunEventTag = e._tag;
	switch (tag) {
		case 'StateChanged':
			return 'state';
		case 'CheckStarted':
			return 'check';
		case 'CheckFinished':
			return e._tag === 'CheckFinished' && e.exitCode !== 0 ? 'fail' : 'check';
		case 'LockWaiting':
		case 'LockAcquired':
		case 'LockReleased':
			return 'lock';
		case 'ReviewStarted':
		case 'FindingsReported':
		case 'FindingsVerified':
		case 'FindingsTriaged':
		case 'ReviewStored':
		case 'PrReviewPosted':
			return 'review';
		case 'ClefDecision':
			return 'clef';
		case 'AgentCost':
			return 'cost';
		case 'CommitCreated':
		case 'BranchPushed':
		case 'PrOpened':
			return 'git';
		case 'Escalated':
		case 'RunInterrupted':
		case 'RunCancelled':
			return 'warn';
		case 'StepEnded':
			return e._tag === 'StepEnded' && e.outcome !== 'ok' ? 'fail' : 'step';
		case 'StepStarted':
			return 'step';
		default:
			return 'run';
	}
};

export const TONE_COLOR: Record<Tone, string> = {
	state: '#5b4bff',
	check: '#12a36b',
	fail: '#e5484d',
	lock: '#e08a00',
	review: '#0a8ad2',
	clef: '#b44ad6',
	cost: '#8a90a6',
	git: '#1f2937',
	warn: '#e5484d',
	run: '#5b4bff',
	step: '#7c5cff'
};

export interface ConfirmRequest {
	title: string;
	body: string;
	command: string;
	confirmLabel: string;
	tone: 'danger' | 'primary';
	action: () => void;
}

export const STATUS_STYLE: Record<string, { fg: string; bg: string }> = {
	running: { fg: '#4b3bf0', bg: '#eeecff' },
	waiting: { fg: '#8a5300', bg: '#fff4dc' },
	done: { fg: '#0d6b47', bg: '#e6f7ef' },
	escalated: { fg: '#b42328', bg: '#ffeceb' },
	failed: { fg: '#b42328', bg: '#ffeceb' },
	interrupted: { fg: '#8a5300', bg: '#fff4dc' },
	cancelled: { fg: '#5b6178', bg: '#eef0f5' }
};
