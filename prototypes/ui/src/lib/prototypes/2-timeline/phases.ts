import type { EscalationReason, Finding, Project, Run, RunEvent } from '#lib';
import { duration, usd } from '#lib';

export type PhaseKind = 'baseline' | 'implement' | 'checks' | 'review' | 'triage' | 'fix' | 'pr' | 'recheck';
export type PhaseStatus = 'done' | 'current' | 'waiting' | 'failed' | 'escalated' | 'interrupted' | 'cancelled';

export interface Phase {
	type: 'phase';
	id: string;
	kind: PhaseKind;
	round: number | null;
	title: string;
	start: string;
	end: string;
	events: RunEvent[];
	cost: number;
	status: PhaseStatus;
	/** The draft PR an escalation opens. */
	escalation: boolean;
	/** For a fix phase: the must-fix ids the previous triage handed over. */
	addresses: string[];
}

export interface Marker {
	type: 'marker';
	id: string;
	event: Extract<RunEvent, { _tag: 'RunInterrupted' | 'RunResumed' | 'RunCancelled' }>;
}

export type Item = Phase | Marker;

const TERMINAL = new Set(['done', 'failed', 'escalated', 'cancelled', 'idle', 'interrupted']);
const top = (state: string) => state.split('.')[0];
const ms = (iso: string) => new Date(iso).getTime();

const TITLES: Record<PhaseKind, string> = {
	baseline: 'Baseline',
	implement: 'Implement',
	checks: 'Checks',
	review: 'Review',
	triage: 'Triage',
	fix: 'Fix',
	pr: 'Pull request',
	recheck: 'Recheck'
};

/** Splits a run's event log into the phases a reader cares about, in order. */
export function derivePhases(run: Run, now: string): Item[] {
	const items: Item[] = [];
	let cur: Phase | null = null;
	let checksRound = 1;
	let reviewRound = 0;
	let triageRound = 0;
	let lastMustFix: string[] = [];

	const open = (kind: PhaseKind, at: string, escalation: boolean): Phase => {
		const phase: Phase = {
			type: 'phase',
			id: `p${items.length}`,
			kind,
			round: null,
			title: TITLES[kind],
			start: at,
			end: at,
			events: [],
			cost: 0,
			status: escalation ? 'escalated' : 'done',
			escalation,
			addresses: kind === 'fix' ? lastMustFix : []
		};
		items.push(phase);
		return phase;
	};

	for (const e of run.events) {
		if (e._tag === 'StateChanged') {
			const to = top(e.to);
			if (cur && top(e.from) === to) {
				cur.events.push(e);
				continue;
			}
			if (cur) cur.end = e.at;
			cur = TERMINAL.has(to) ? null : open(to === 'escalate' ? 'pr' : (to as PhaseKind), e.at, to === 'escalate');
			continue;
		}
		if (e._tag === 'RunInterrupted' || e._tag === 'RunCancelled' || e._tag === 'RunResumed') {
			if (cur && e._tag !== 'RunResumed') {
				cur.status = e._tag === 'RunInterrupted' ? 'interrupted' : 'cancelled';
				cur.end = e.at;
				cur = null;
			}
			items.push({ type: 'marker', id: `m${items.length}`, event: e });
			continue;
		}
		if (!cur) continue;
		cur.events.push(e);
		cur.end = e.at;
		if (e._tag === 'AgentCost') cur.cost += e.costUsd;
		if (e._tag === 'StepEnded' && e.outcome !== 'ok') cur.status = 'failed';
		if (e._tag === 'CheckStarted' && cur.round === null) cur.round = checksRound = e.round;
		if (e._tag === 'ReviewStarted') cur.round = reviewRound = e.round;
		if (e._tag === 'FindingsTriaged') {
			cur.round = triageRound = e.round;
			lastMustFix = e.mustFix;
		}
	}

	if (cur) {
		cur.end = now;
		if (run.status === 'running') cur.status = 'current';
		if (run.status === 'waiting') cur.status = 'waiting';
		if (run.status === 'interrupted') cur.status = 'interrupted';
	}

	for (const item of items) {
		if (item.type !== 'phase') continue;
		if (item.kind === 'checks' && item.round === null) item.round = checksRound;
		if (item.kind === 'triage' && item.round === null) item.round = reviewRound;
		if (item.kind === 'fix') item.round = triageRound || null;
		const roundTitled = item.kind !== 'baseline' && item.kind !== 'implement' && item.kind !== 'pr' && item.kind !== 'recheck';
		if (roundTitled && item.round) item.title = `${TITLES[item.kind]} · round ${item.round}`;
		if (item.escalation) item.title = 'Draft pull request';
	}
	return items;
}

export const phaseDuration = (p: Phase) => ms(p.end) - ms(p.start);

/** The latest moment the run is known at: a live run's events run ahead of the mock clock. */
export const runNow = (run: Run, mockNow: Date) =>
	new Date(Math.max(mockNow.getTime(), ms(run.events.at(-1)?.at ?? run.createdAt))).toISOString();

// --- Checks ---------------------------------------------------------------------------------

export interface CheckRow {
	name: string;
	commandLine: string;
	status: 'passed' | 'failed' | 'running' | 'waiting';
	exitCode: number | null;
	durationMs: number | null;
	outputTail: string;
	lock: string | null;
	waitedMs: number;
	position: number | null;
	fixCommand: string | null;
}

export interface Attempt {
	attempt: number;
	rows: CheckRow[];
	fixer: { durationMs: number | null; cost: number; model: string | null; outcome: string | null } | null;
}

export function checkAttempts(phase: Phase): Attempt[] {
	const attempts = new Map<number, Attempt>();
	let curAttempt = 0;
	const attemptOf = (n: number) => {
		let a = attempts.get(n);
		if (!a) {
			a = { attempt: n, rows: [], fixer: null };
			attempts.set(n, a);
		}
		return a;
	};
	const rowOf = (n: number, name: string) => {
		const a = attemptOf(n);
		let row = a.rows.find((r) => r.name === name);
		if (!row) {
			row = { name, commandLine: '', status: 'running', exitCode: null, durationMs: null, outputTail: '', lock: null, waitedMs: 0, position: null, fixCommand: null };
			a.rows.push(row);
		}
		return row;
	};

	for (const e of phase.events) {
		switch (e._tag) {
			case 'CheckStarted':
				curAttempt = e.attempt;
				if (e.command === 'fix') rowOf(e.attempt, e.check).fixCommand = e.commandLine;
				else {
					const row = rowOf(e.attempt, e.check);
					row.commandLine = e.commandLine;
					row.status = 'running';
				}
				break;
			case 'CheckFinished':
				if (e.command === 'run') {
					const row = rowOf(e.attempt, e.check);
					row.status = e.exitCode === 0 ? 'passed' : 'failed';
					row.exitCode = e.exitCode;
					row.durationMs = e.durationMs;
					row.outputTail = e.outputTail;
				}
				break;
			case 'LockWaiting': {
				const row = rowOf(curAttempt, e.check);
				row.status = 'waiting';
				row.lock = e.resource;
				row.position = e.position ?? null;
				break;
			}
			case 'LockAcquired': {
				const row = rowOf(curAttempt, e.check);
				row.lock = e.resource;
				row.waitedMs = e.waitedMs;
				row.position = null;
				if (row.status === 'waiting') row.status = 'running';
				break;
			}
			case 'StepStarted':
				if (e.step === 'check-fix') attemptOf(curAttempt).fixer = { durationMs: null, cost: 0, model: null, outcome: null };
				break;
			case 'AgentCost': {
				const fixer = attempts.get(curAttempt)?.fixer;
				if (e.step === 'check-fix' && fixer) {
					fixer.cost = e.costUsd;
					fixer.model = e.model;
				}
				break;
			}
			case 'StepEnded': {
				const fixer = attempts.get(curAttempt)?.fixer;
				if (e.step === 'check-fix' && fixer) {
					fixer.durationMs = e.durationMs;
					fixer.outcome = e.outcome;
					curAttempt += 1;
				}
				break;
			}
		}
	}
	return [...attempts.values()].filter((a) => a.rows.some((r) => r.commandLine) || a.fixer);
}

// --- Steps ----------------------------------------------------------------------------------

export interface StepInfo {
	model: string | null;
	cost: number;
	durationMs: number | null;
	outcome: string | null;
	error: string | null;
}

export function stepInfo(phase: Phase, step: string): StepInfo | null {
	let info: StepInfo | null = null;
	for (const e of phase.events) {
		if (e._tag === 'StepStarted' && e.step === step) info = { model: null, cost: 0, durationMs: null, outcome: null, error: null };
		if (!info) continue;
		if (e._tag === 'AgentCost' && e.step === step) {
			info.model = e.model;
			info.cost += e.costUsd;
		}
		if (e._tag === 'StepEnded' && e.step === step) {
			info.durationMs = e.durationMs;
			info.outcome = e.outcome;
			info.error = e.error ?? null;
		}
	}
	return info;
}

export const shortModel = (model: string | null) => (model ? model.replace(/^claude-/, '').replace(/-\d.*$/, '') : 'agent');

// --- Words ----------------------------------------------------------------------------------

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export const count = (n: number, noun: string, plural = `${noun}s`) => `${WORDS[n] ?? n} ${n === 1 ? noun : plural}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const findingById = (run: Run, id: string): Finding | undefined => run.findings.find((f) => f.id === id);

/** One quiet line shown beside a collapsed phase. */
export function phaseGist(run: Run, p: Phase): string {
	switch (p.kind) {
		case 'baseline': {
			const rows = checkAttempts(p).flatMap((a) => a.rows);
			const failed = rows.filter((r) => r.status === 'failed');
			if (!failed.length) return `All ${count(rows.length, 'check')} passed before any change`;
			return `${failed.map((r) => r.name).join(', ')} already failing on the base; the change isn't held to it`;
		}
		case 'checks': {
			const attempts = checkAttempts(p);
			const rows = attempts.at(-1)?.rows ?? [];
			const waiting = rows.find((r) => r.status === 'waiting');
			if (waiting) return `${waiting.name} is waiting for the ${waiting.lock} lock`;
			if (p.status === 'current') return `Running ${rows.find((r) => r.status === 'running')?.name ?? 'checks'}`;
			if (attempts.length > 1) return `Passed on attempt ${attempts.length} after a check fix`;
			if (rows.some((r) => r.status === 'failed')) return `${rows.filter((r) => r.status === 'failed').length} failing`;
			return `All ${count(rows.length, 'check')} passed`;
		}
		case 'implement':
		case 'fix':
		case 'recheck': {
			const s = stepInfo(p, p.kind);
			if (!s) return 'Not started';
			if (s.outcome && s.outcome !== 'ok') return s.error ?? `${p.kind} ${s.outcome}`;
			const who = `${cap(shortModel(s.model))} worked ${s.durationMs ? duration(s.durationMs) : 'for a while'}`;
			if (p.kind === 'fix' && p.addresses.length) return `${who} on ${p.addresses.join(', ')}`;
			return s.durationMs === null ? `${cap(shortModel(s.model))} is working` : who;
		}
		case 'review': {
			const started = p.events.find((e) => e._tag === 'ReviewStarted');
			const verified = p.events.find((e) => e._tag === 'FindingsVerified');
			const n = started?._tag === 'ReviewStarted' ? started.reviewers.length : 0;
			if (verified?._tag !== 'FindingsVerified') return `${count(n, 'reviewer')} reading the diff`;
			const kept = verified.verified.length;
			return cap(`${count(n, 'reviewer')} · kept ${kept} of ${kept + verified.disproved} findings`);
		}
		case 'triage': {
			const t = p.events.find((e) => e._tag === 'FindingsTriaged');
			if (t?._tag !== 'FindingsTriaged') return 'Sorting findings';
			return `${t.mustFix.length} must-fix, ${t.tradeoffs.length} tradeoff, ${t.nits.length} nit`;
		}
		case 'pr': {
			const pr = p.events.find((e) => e._tag === 'PrOpened');
			if (pr?._tag === 'PrOpened') return `${pr.draft ? 'Draft PR' : 'PR'} #${pr.url.split('/').at(-1)} opened`;
			return 'Pushing the branch';
		}
	}
}

const phaseWord = (p: Phase) => p.title.replace(/ · round \d+/, '').toLowerCase();

/** The run's abstract: two or three sentences a person reads before the timeline. */
export function summarize(run: Run, items: Item[]): string {
	const phases = items.filter((i): i is Phase => i.type === 'phase');
	const reviews = phases.filter((p) => p.kind === 'review');
	const fixes = phases.filter((p) => p.kind === 'fix' && p.status === 'done');
	const fixed = new Set(fixes.flatMap((p) => p.addresses));
	const parts: string[] = [];

	const checkFixes = phases
		.filter((p) => p.kind === 'checks')
		.reduce((n, p) => n + checkAttempts(p).filter((a) => a.fixer?.outcome === 'ok').length, 0);

	if (run.kind === 'review') {
		const reported = reviews.flatMap((p) => p.events).filter((e) => e._tag === 'FindingsReported');
		const total = reported.reduce((n, e) => n + (e._tag === 'FindingsReported' ? e.count : 0), 0);
		parts.push(`A review of PR #${run.prNumber}; ${count(reported.length, 'reviewer')} ${reported.length === 1 ? 'has' : 'have'} reported ${count(total, 'finding')} so far, none verified yet.`);
	} else if (reviews.length) {
		const rounds = count(reviews.length, 'review round');
		const kept = run.findings.length;
		const fixedClause = fixed.size ? `, ${WORDS[fixed.size] ?? fixed.size} fixed` : '';
		parts.push(`${cap(rounds)}, ${count(kept, 'finding')} kept${fixedClause}.`);
	} else if (phases.some((p) => p.kind === 'implement')) {
		const impl = phases.find((p) => p.kind === 'implement')!;
		parts.push(`Baseline, then ${impl.status === 'done' ? `${duration(phaseDuration(impl))} of implementation` : 'implementation'}.`);
	} else if (phases[0]) {
		parts.push(`A single ${phaseWord(phases[0])} pass${run.prNumber ? ` on PR #${run.prNumber}` : ''}.`);
	}
	if (checkFixes) parts.push(`The checks failed ${count(checkFixes, 'time', 'times').replace(/^one time/, 'once').replace(/^two times/, 'twice')} and the check-fix agent repaired them.`);

	const last = phases.at(-1);
	switch (run.status) {
		case 'running':
			if (last?.kind === 'review' && !last.events.some((e) => e._tag === 'FindingsVerified')) parts.push('Waiting on reviewers.');
			else if (last) parts.push(`Now in ${phaseWord(last)}.`);
			break;
		case 'waiting': {
			const row = last ? checkAttempts(last).at(-1)?.rows.find((r) => r.status === 'waiting') : undefined;
			parts.push(row ? `Waiting for the ${row.lock} lock (#${row.position ?? 1} in queue) to run ${row.name}.` : 'Waiting.');
			break;
		}
		case 'escalated': {
			const triage = phases.findLast((p) => p.kind === 'triage');
			const t = triage?.events.find((e) => e._tag === 'FindingsTriaged');
			const open = t?._tag === 'FindingsTriaged' ? t.mustFix.length : 0;
			parts.push(`Escalated (${run.escalationReason}); draft PR #${run.prNumber} lists ${count(open, 'open must-fix finding')} for a human.`);
			break;
		}
		case 'done':
			if (run.kind === 'fix') parts.push(`Done; the fixes are pushed to PR #${run.prNumber}.`);
			else if (run.kind === 'recheck') parts.push(`Done; every finding on PR #${run.prNumber} checks out as fixed.`);
			else parts.push(run.prNumber ? `Done; PR #${run.prNumber} is up.` : 'Done.');
			break;
		case 'failed':
			parts.push(`Failed in ${last ? phaseWord(last) : 'a step'}: ${run.error ?? 'see the log'}.`);
			break;
		case 'interrupted':
			parts.push('Interrupted when the daemon stopped; it can be resumed where it left off.');
			break;
		case 'cancelled':
			parts.push(`Cancelled during ${last ? phaseWord(last) : 'the run'}.`);
			break;
	}
	const live = run.status === 'running' || run.status === 'waiting';
	if (run.costUsd > 0) parts.push(`${usd(run.costUsd)} spent ${live ? 'so far' : 'in total'}.`);
	return parts.join(' ');
}

export const ESCALATION: Record<EscalationReason, { headline: string; body: (caps: Project['caps']) => string }> = {
	'review-cap': {
		headline: 'The review loop ran out of rounds',
		body: (c) =>
			`Reviewers still had must-fix findings after ${count(c.reviewRounds, 'round')}, which is this project's cap (caps.reviewRounds). ship stopped fixing, pushed the branch and opened a draft PR that lists what is left. A person decides what happens next.`
	},
	stall: {
		headline: 'The fixes stopped making progress',
		body: () =>
			'A review round reported the same problem the previous round did, so another fix pass would likely repeat itself. ship pushed the branch and opened a draft PR with the repeated findings.'
	},
	'check-fix-cap': {
		headline: 'The checks would not go green',
		body: (c) =>
			`The check-fix agent tried ${count(c.checkFixAttempts, 'time')} (caps.checkFixAttempts) and the checks still failed. ship opened a draft PR with the failing output.`
	},
	'checks-unrelated': {
		headline: 'The failing checks look unrelated to this change',
		body: () =>
			'Clef rated every failure as unrelated (0.7 or more). ship ran the checks once more without a fix, they failed again, and it opened a draft PR saying so.'
	},
	timeout: {
		headline: 'A step ran out of time',
		body: () => 'A step hit its timeout. ship pushed what it had and opened a draft PR.'
	}
};
