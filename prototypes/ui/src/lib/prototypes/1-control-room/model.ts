import type { Run, RunEvent, RunEventTag, RunKind, RunStatus } from '#lib';

export type Group = 'state' | 'checks' | 'locks' | 'review' | 'cost' | 'git';

export const GROUPS: Group[] = ['state', 'checks', 'locks', 'review', 'cost', 'git'];

const TAG_GROUP: Record<RunEventTag, Group> = {
	RunCreated: 'state',
	ReviewRunCreated: 'state',
	StateChanged: 'state',
	StepStarted: 'state',
	StepEnded: 'state',
	Escalated: 'state',
	RunFinished: 'state',
	RunInterrupted: 'state',
	RunResumed: 'state',
	RunCancelled: 'state',
	CheckStarted: 'checks',
	CheckFinished: 'checks',
	LockWaiting: 'locks',
	LockAcquired: 'locks',
	LockReleased: 'locks',
	ReviewStarted: 'review',
	FindingsReported: 'review',
	FindingsVerified: 'review',
	FindingsTriaged: 'review',
	ClefDecision: 'review',
	ReviewStored: 'review',
	PrReviewPosted: 'review',
	AgentCost: 'cost',
	CommitCreated: 'git',
	BranchPushed: 'git',
	PrOpened: 'git'
};

export const groupOf = (tag: RunEventTag): Group => TAG_GROUP[tag];

/** Events that deserve a louder colour than their group's. */
export const toneOf = (e: RunEvent): 'ok' | 'bad' | 'warn' | 'clef' | null => {
	switch (e._tag) {
		case 'CheckFinished':
			return e.exitCode === 0 ? 'ok' : 'bad';
		case 'StepEnded':
			return e.outcome === 'ok' ? null : 'bad';
		case 'Escalated':
		case 'RunCancelled':
			return 'bad';
		case 'RunInterrupted':
		case 'LockWaiting':
			return 'warn';
		case 'RunFinished':
			return e.status === 'done' ? 'ok' : 'bad';
		case 'PrOpened':
			return 'ok';
		case 'ClefDecision':
			return 'clef';
		default:
			return null;
	}
};

export const ACTIVE: RunStatus[] = ['running', 'waiting'];
export const isActive = (s: RunStatus) => ACTIVE.includes(s);

/** Exit code the CLI would return for a finished run. */
export const exitCodeFor = (s: RunStatus): number | null =>
	s === 'done' ? 0 : s === 'escalated' ? 2 : isActive(s) ? null : 1;

/** Pipeline stages each kind of run visits, in order. */
export const stagesFor = (kind: RunKind): string[] => {
	switch (kind) {
		case 'ship':
			return ['baseline', 'implement', 'checks', 'review', 'triage', 'fix', 'pr'];
		case 'implement':
			return ['baseline', 'implement', 'checks'];
		case 'review':
			return ['review', 'triage', 'post'];
		case 'fix':
			return ['fix', 'checks', 'push'];
		case 'recheck':
			return ['recheck', 'resolve'];
		case 'checks':
			return ['checks', 'check-fix', 'commit'];
		case 'pr':
			return ['push', 'pr'];
		case 'post':
			return ['post'];
	}
};

export const topState = (state: string) => state.split('.')[0];

// --- Check matrix -------------------------------------------------------------------------

export type CellState = 'pass' | 'fail' | 'running' | 'waiting' | 'stopped';
export interface Cell {
	state: CellState;
	exitCode?: number;
	durationMs?: number;
	outputTail?: string;
	commandLine?: string;
	fixed?: boolean;
}
export interface Column {
	key: string;
	label: string;
	title: string;
}
export interface Matrix {
	columns: Column[];
	rows: { name: string; cells: Record<string, Cell> }[];
}

export function buildMatrix(run: Run): Matrix {
	const columns: Column[] = [];
	const rows = new Map<string, Record<string, Cell>>();
	let current: string | null = null;
	const live = isActive(run.status);

	const ensureColumn = (baseline: boolean, round: number, attempt: number) => {
		const key = `${baseline ? 'b' : 'r'}${round}.${attempt}`;
		if (!columns.some((c) => c.key === key)) {
			columns.push({
				key,
				label: baseline ? 'base' : `r${round}${attempt ? `·${attempt}` : ''}`,
				title: baseline
					? 'baseline, before any change'
					: `round ${round}, attempt ${attempt}${attempt ? ' (after check-fix)' : ''}`
			});
		}
		current = key;
		return key;
	};
	const row = (name: string) => {
		let r = rows.get(name);
		if (!r) rows.set(name, (r = {}));
		return r;
	};

	for (const e of run.events) {
		if (e._tag === 'CheckStarted') {
			const key = ensureColumn(e.baseline, e.round, e.attempt);
			const r = row(e.check);
			if (e.command === 'fix') r[key] = { ...(r[key] ?? { state: 'running' }), fixed: true };
			else r[key] = { ...r[key], state: live ? 'running' : 'stopped', commandLine: e.commandLine };
		} else if (e._tag === 'CheckFinished' && e.command === 'run') {
			const key = ensureColumn(e.baseline, e.round, e.attempt);
			const r = row(e.check);
			r[key] = {
				...r[key],
				state: e.exitCode === 0 ? 'pass' : 'fail',
				exitCode: e.exitCode,
				durationMs: e.durationMs,
				outputTail: e.outputTail
			};
		} else if (e._tag === 'LockWaiting' && current) {
			row(e.check)[current] = { state: live ? 'waiting' : 'stopped' };
		}
	}
	return { columns, rows: [...rows].map(([name, cells]) => ({ name, cells })) };
}

// --- Cost ---------------------------------------------------------------------------------

export function costByStep(run: Run) {
	const map = new Map<string, { step: string; cost: number; models: Set<string> }>();
	for (const e of run.events) {
		if (e._tag !== 'AgentCost') continue;
		const s = map.get(e.step) ?? { step: e.step, cost: 0, models: new Set<string>() };
		s.cost += e.costUsd;
		s.models.add(e.model.replace('claude-', ''));
		map.set(e.step, s);
	}
	return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function lockActivity(run: Run) {
	let acquired = 0;
	let waitedMs = 0;
	for (const e of run.events) {
		if (e._tag === 'LockAcquired') {
			acquired++;
			waitedMs += e.waitedMs;
		}
	}
	return { acquired, waitedMs };
}

/** A short random run id in ship's style. */
export const newRunId = () =>
	`r-${Math.floor(Math.random() * 10)}${'abcdefghjkmnpqrstuvwxyz'[Math.floor(Math.random() * 23)]}${Math.floor(Math.random() * 10)}${'abcdefghjkmnpqrstuvwxyz'[Math.floor(Math.random() * 23)]}`;
