import { createContext } from 'svelte';
import { activeRuns, locks } from '#lib';
import type { Finding, Run, RunEvent, Severity } from '#lib';
import { fakeRunIds, initialItems, inboxRun, prThreads, type InboxFinding, type InboxItem } from './data.ts';

/** The human's call on one finding. `leave` keeps the triaged severity. */
export type Decision = 'leave' | 'tradeoff' | 'nit' | 'dismiss' | 'fix';
export type Folder = 'decision' | 'snoozed' | 'done' | 'running';
export type ItemStatus = 'open' | 'snoozed' | 'archived';

export type Entry = InboxItem & { status: ItemStatus; resolution: string | null };

export interface Toast {
	id: number;
	text: string;
	command?: string;
	undo?: () => void;
}

export interface ConfirmRequest {
	title: string;
	command: string;
	lines: string[];
	note?: string;
	confirmLabel: string;
	onConfirm: () => void;
}

export interface RunRow {
	runId: string;
	title: string;
	projectKey: string;
	kind: string;
	state: string;
	status: string;
	updatedAt: string;
	lastLine: RunEvent | null;
	live: boolean;
	command?: string;
}

export interface Action {
	key: string;
	label: string;
	command?: string;
	run: () => void;
	primary?: boolean;
	disabled?: string;
}

interface Live {
	readonly run: Run;
	readonly lastEvent: RunEvent;
}

export const effectiveSeverity = (f: Finding, d: Decision): Severity | 'dismissed' =>
	d === 'leave' ? f.severity : d === 'dismiss' ? 'dismissed' : d === 'fix' ? 'must-fix' : d;

export class InboxState {
	entries = $state<Entry[]>(initialItems.map((i) => ({ ...i, status: 'open', resolution: null })));
	folder = $state<Folder>('decision');
	project = $state<string | null>(null);
	selectedId = $state<string | null>(null);
	mode = $state<'list' | 'detail'>('list');
	findingCursor = $state(0);
	decisions = $state<Record<string, Decision>>({});
	toasts = $state<Toast[]>([]);
	confirm = $state<ConfirmRequest | null>(null);
	showKeys = $state(false);
	runningOpen = $state(false);
	started = $state<RunRow[]>([]);
	posted = $state<Record<string, boolean>>({});

	#live: Live;
	#toastId = 0;
	#fakeIdx = 0;
	#onSelect: (id: string | null) => void;

	constructor(live: Live, initialSelected: string | null, onSelect: (id: string | null) => void) {
		this.#live = live;
		this.#onSelect = onSelect;
		const known = initialSelected && (this.entries.some((e) => e.id === initialSelected) || initialSelected.startsWith('run:'));
		if (known) {
			if (initialSelected.startsWith('run:')) this.folder = 'running';
			const entry = this.entries.find((e) => e.id === initialSelected);
			if (entry) entry.unread = false;
			this.selectedId = initialSelected;
		} else {
			this.selectedId = initialItems[0]?.id ?? null;
		}
	}

	get live() {
		return this.#live;
	}

	/** A run as the inbox sees it, with r-7k2m replaced by its live copy. */
	run = (id: string | null): Run | undefined =>
		id === this.#live.run.runId ? this.#live.run : inboxRun(id);

	runningRows = $derived.by((): RunRow[] => {
		const startedIds = new Set(this.started.map((s) => s.runId));
		const base = activeRuns()
			.filter((r) => !startedIds.has(r.runId))
			.map((r) => {
				const run = this.run(r.runId)!;
				return {
					runId: run.runId,
					title: run.title,
					projectKey: run.projectKey,
					kind: run.kind,
					state: run.state,
					status: run.status,
					updatedAt: run.updatedAt,
					lastLine: run.events.at(-1) ?? null,
					live: run.runId === this.#live.run.runId
				};
			});
		return [...this.started, ...base];
	});

	runningCount = $derived(this.runningRows.filter((r) => r.status === 'running').length);
	waitingCount = $derived(this.runningRows.filter((r) => r.status === 'waiting').length);
	dbQueue = $derived(locks.find((l) => l.name === 'db')?.queue.length ?? 0);

	inFolder = (e: Entry, folder: Folder) =>
		folder === 'decision' ? e.status === 'open' : folder === 'snoozed' ? e.status === 'snoozed' : folder === 'done' ? e.status === 'archived' : false;

	visible = $derived(
		this.entries.filter((e) => this.inFolder(e, this.folder) && (!this.project || e.projectKey === this.project))
	);

	visibleIds = $derived(
		this.folder === 'running'
			? this.runningRows.filter((r) => !this.project || r.projectKey === this.project).map((r) => `run:${r.runId}`)
			: this.visible.map((e) => e.id)
	);

	selected = $derived(this.entries.find((e) => e.id === this.selectedId) ?? null);

	count = (folder: Folder, project: string | null = null) =>
		this.entries.filter((e) => this.inFolder(e, folder) && (!project || e.projectKey === project)).length;

	unreadCount = $derived(this.entries.filter((e) => e.status === 'open' && e.unread).length);

	// --- navigation ---------------------------------------------------------------------------

	select(id: string | null, open = false) {
		this.selectedId = id;
		this.findingCursor = 0;
		this.mode = open ? 'detail' : 'list';
		const entry = this.entries.find((e) => e.id === id);
		if (entry && open) entry.unread = false;
		this.#onSelect(id);
	}

	move(delta: number) {
		const ids = this.visibleIds;
		if (!ids.length) return;
		const i = this.selectedId ? ids.indexOf(this.selectedId) : -1;
		const next = ids[Math.min(ids.length - 1, Math.max(0, i + delta))];
		this.select(next);
		// Superhuman-style: moving onto an item reads it.
		const entry = this.entries.find((e) => e.id === next);
		if (entry) entry.unread = false;
	}

	setFolder(folder: Folder) {
		this.folder = folder;
		if (folder === 'running') this.runningOpen = true;
		this.select(this.visibleIds[0] ?? null);
	}

	setProject(key: string | null) {
		this.project = this.project === key ? null : key;
		if (this.folder === 'running') this.folder = 'decision';
		this.select(this.visibleIds[0] ?? null);
	}

	/** After the selected entry leaves the current list, select its neighbour. */
	#advanceFrom(id: string, ids: string[]) {
		if (this.selectedId !== id) return;
		const i = ids.indexOf(id);
		const rest = ids.filter((x) => x !== id);
		this.select(rest[Math.min(i, rest.length - 1)] ?? null);
	}

	// --- entry actions ------------------------------------------------------------------------

	#setStatus(id: string, status: ItemStatus, resolution: string | null, verb: string) {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) return;
		const before = { status: entry.status, resolution: entry.resolution };
		const ids = this.visibleIds;
		entry.status = status;
		entry.resolution = resolution;
		entry.unread = false;
		this.#advanceFrom(id, ids);
		this.toast(`${verb} · ${entry.title}`, undefined, () => {
			entry.status = before.status;
			entry.resolution = before.resolution;
			this.select(id);
		});
	}

	archive(id = this.selectedId) {
		if (!id || id.startsWith('run:')) return;
		const entry = this.entries.find((e) => e.id === id);
		if (entry?.status === 'archived') return this.#setStatus(id, 'open', null, 'Moved to inbox');
		this.#setStatus(id, 'archived', 'Archived', 'Archived');
	}

	snooze(id = this.selectedId) {
		if (!id || id.startsWith('run:')) return;
		const entry = this.entries.find((e) => e.id === id);
		if (entry?.status === 'snoozed') return this.#setStatus(id, 'open', null, 'Unsnoozed');
		this.#setStatus(id, 'snoozed', 'Until tomorrow 09:00', 'Snoozed until tomorrow 09:00');
	}

	toggleUnread(id = this.selectedId) {
		const entry = this.entries.find((e) => e.id === id);
		if (entry) entry.unread = !entry.unread;
	}

	#resolve(id: string, resolution: string) {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) return;
		const ids = this.visibleIds;
		entry.status = 'archived';
		entry.resolution = resolution;
		entry.unread = false;
		this.#advanceFrom(id, ids);
	}

	#startRun(row: Omit<RunRow, 'runId' | 'updatedAt' | 'lastLine' | 'live' | 'status'>, runId?: string) {
		const id = runId ?? fakeRunIds[this.#fakeIdx++ % fakeRunIds.length];
		this.started = [
			{ ...row, runId: id, status: 'running', updatedAt: new Date().toISOString(), lastLine: null, live: false },
			...this.started.filter((s) => s.runId !== id)
		];
		return id;
	}

	// --- findings -----------------------------------------------------------------------------

	decision = (runId: string, f: Finding): Decision => this.decisions[`${runId}:${f.id}`] ?? 'leave';

	decide(runId: string, f: Finding, d: Decision) {
		const key = `${runId}:${f.id}`;
		const prev = this.decisions[key] ?? 'leave';
		this.decisions[key] = prev === d ? 'leave' : d;
	}

	/** The findings the detail pane lists for a run: its latest triaged round, by severity. */
	currentFindings(run: Run): InboxFinding[] {
		const round = Math.max(0, ...run.findings.map((f) => f.round));
		const rank: Record<Severity, number> = { 'must-fix': 0, tradeoff: 1, nit: 2 };
		return run.findings.filter((f) => f.round === round).sort((a, b) => rank[a.severity] - rank[b.severity]);
	}

	tally(run: Run) {
		const t = { 'must-fix': 0, tradeoff: 0, nit: 0, dismissed: 0 };
		for (const f of this.currentFindings(run)) t[effectiveSeverity(f, this.decision(run.runId, f))]++;
		return t;
	}

	// --- per-item primary actions ------------------------------------------------------------

	actions(entry: Entry | null): Action[] {
		if (!entry || entry.status === 'archived') return [];
		const run = this.run(entry.runId);
		switch (entry.kind) {
			case 'escalated':
			case 'review': {
				if (!run) return [];
				const t = this.tally(run);
				const source = entry.kind === 'review' ? run.reviewId! : String(entry.prNumber);
				const fixLabel = `Fix ${t['must-fix']} must-fix${t.nit ? ` + ${t.nit} nit${t.nit > 1 ? 's' : ''}` : ''}`;
				const fix: Action = {
					key: 'f',
					label: fixLabel,
					command: `ship fix ${source}`,
					primary: entry.kind === 'escalated',
					disabled: t['must-fix'] + t.nit === 0 ? 'Nothing left to fix' : undefined,
					run: () => this.askFix(entry, run, source)
				};
				const recheck: Action = {
					key: 'c',
					label: 'Recheck',
					command: `ship recheck ${entry.prNumber}`,
					run: () => this.askRecheck(entry)
				};
				const post: Action = {
					key: 'p',
					label: this.posted[run.reviewId ?? ''] ? 'Posted' : 'Post review',
					command: `ship post ${run.reviewId}`,
					primary: entry.kind === 'review',
					disabled: run.reviewId ? (this.posted[run.reviewId] ? 'Already posted' : undefined) : 'Escalated runs put findings in the PR body',
					run: () => this.askPost(entry, run)
				};
				return entry.kind === 'review' ? [post, fix, recheck] : [fix, recheck, post];
			}
			case 'threads': {
				const threads = prThreads[entry.prNumber!] ?? [];
				const fixable = threads.filter((t) => t.as.severity !== 'none' && t.as.severity !== 'tradeoff');
				const must = fixable.filter((t) => t.as.severity === 'must-fix').length;
				const nits = fixable.length - must;
				return [
					{
						key: 'f',
						label: `Fix ${must} must-fix + ${nits} nit`,
						command: `ship fix ${entry.prNumber}`,
						primary: true,
						run: () =>
							this.ask({
								title: `Fix the threads on #${entry.prNumber}`,
								command: `ship fix ${entry.prNumber}`,
								lines: fixable.map((t) => `${t.as.severity === 'must-fix' ? 'must-fix' : 'nit'} · ${t.file}:${t.line} — ${t.author}`),
								note: `Runs in ${run?.cwd ?? '~/work/acme/storefront'} after \`gh pr checkout ${entry.prNumber}\`. Fixes, runs the checks, commits and pushes to ${'dev/checkout-tax'}. 1 thread is a question and is left out.`,
								confirmLabel: 'Start fix',
								onConfirm: () => {
									const id = this.#startRun({ title: entry.title, projectKey: entry.projectKey, kind: 'fix', state: 'fix', command: `ship fix ${entry.prNumber}` });
									this.#resolve(entry.id, `Fix started · ${id}`);
									this.toast(`Started ${id}`, `ship fix ${entry.prNumber}`);
								}
							})
					},
					{ key: 'c', label: 'Recheck', command: `ship recheck ${entry.prNumber}`, run: () => this.askRecheck(entry) }
				];
			}
			case 'failed':
			case 'interrupted':
				return [
					{
						key: 'r',
						label: entry.kind === 'failed' ? 'Retry from implement' : 'Resume',
						command: `ship resume ${entry.runId}`,
						primary: true,
						run: () => this.resume(entry)
					}
				];
			case 'baseline':
			case 'tradeoff':
				return [
					{
						key: 'e',
						label: 'Acknowledge',
						primary: true,
						run: () => {
							this.#resolve(entry.id, 'Acknowledged');
							this.toast(`Acknowledged · ${entry.title}`);
						}
					}
				];
		}
	}

	runAction(key: string) {
		const action = this.actions(this.selected).find((a) => a.key === key);
		if (!action) {
			if (key === 'f' && this.selected?.kind === 'tradeoff') this.toast(`${this.selected.runId} is still running — ship triages its own findings`);
			return false;
		}
		if (action.disabled) {
			this.toast(action.disabled);
			return true;
		}
		action.run();
		return true;
	}

	resume(entry: Entry) {
		const run = this.run(entry.runId);
		if (!run) return;
		const state = entry.kind === 'failed' ? 'implement' : 'checks.running';
		this.#startRun({ title: run.title, projectKey: run.projectKey, kind: run.kind, state, command: `ship resume ${run.runId}` }, run.runId);
		this.#resolve(entry.id, `Resumed at ${entry.kind === 'failed' ? 'implement' : 'check-fix'}`);
		this.toast(`${run.runId} resumed → ${state}`, `ship resume ${run.runId}`);
	}

	askFix(entry: Entry, run: Run, source: string) {
		const fs = this.currentFindings(run).filter((f) => {
			const s = effectiveSeverity(f, this.decision(run.runId, f));
			return s === 'must-fix' || s === 'nit';
		});
		const accepted = this.currentFindings(run).filter((f) => this.decision(run.runId, f) === 'tradeoff');
		this.ask({
			title: `Fix ${entry.kind === 'review' ? `review ${source}` : `#${entry.prNumber}`}`,
			command: `ship fix ${source}`,
			lines: fs.map((f) => `${effectiveSeverity(f, this.decision(run.runId, f))} · ${f.id} ${f.file}${f.line ? `:${f.line}` : ''}`),
			note: `Runs in ${run.cwd} on ${run.branch} after \`gh pr checkout ${entry.prNumber}\`; tree must be clean.${accepted.length ? ` ${accepted.length} accepted as tradeoff will be noted on the PR.` : ''} Tradeoffs and dismissed findings are left out.`,
			confirmLabel: 'Start fix',
			onConfirm: () => {
				const id = this.#startRun({ title: run.title, projectKey: run.projectKey, kind: 'fix', state: 'fix', command: `ship fix ${source}` });
				this.#resolve(entry.id, `Fix started · ${id}`);
				this.toast(`Started ${id}`, `ship fix ${source}`);
			}
		});
	}

	askRecheck(entry: Entry) {
		this.ask({
			title: `Recheck #${entry.prNumber}`,
			command: `ship recheck ${entry.prNumber}`,
			lines: ['Verifier checks each open finding over merge-base…HEAD', 'Resolves the threads of fixed findings on GitHub', 'Exits 2 if some are not fixed'],
			note: 'Fails without resolving anything if HEAD moves while it runs.',
			confirmLabel: 'Start recheck',
			onConfirm: () => {
				const id = this.#startRun({ title: entry.title, projectKey: entry.projectKey, kind: 'recheck', state: 'recheck', command: `ship recheck ${entry.prNumber}` });
				this.toast(`Started ${id}`, `ship recheck ${entry.prNumber}`);
			}
		});
	}

	askPost(entry: Entry, run: Run) {
		const kept = this.currentFindings(run).filter((f) => this.decision(run.runId, f) !== 'dismiss');
		const mustFix = kept.some((f) => effectiveSeverity(f, this.decision(run.runId, f)) === 'must-fix');
		const inline = kept.filter((f) => f.line).length;
		this.ask({
			title: `Post ${run.reviewId} to #${entry.prNumber}`,
			command: `ship post ${run.reviewId}`,
			lines: [
				`${mustFix ? 'REQUEST_CHANGES' : 'COMMENT'} · ${inline} inline, ${kept.length - inline} in body`,
				...kept.map((f) => `${effectiveSeverity(f, this.decision(run.runId, f))} · ${f.id} ${f.file}${f.line ? `:${f.line}` : ''}`)
			],
			note: `Needs HEAD at the reviewed head (gh pr checkout ${entry.prNumber}).`,
			confirmLabel: 'Post review',
			onConfirm: () => {
				this.posted[run.reviewId!] = true;
				this.#resolve(entry.id, `Posted ${mustFix ? 'REQUEST_CHANGES' : 'COMMENT'}`);
				this.toast(`Review posted to #${entry.prNumber} · ${inline} inline`, `ship post ${run.reviewId}`);
			}
		});
	}

	// --- overlays -----------------------------------------------------------------------------

	ask(req: ConfirmRequest) {
		this.confirm = req;
	}

	accept() {
		const c = this.confirm;
		this.confirm = null;
		c?.onConfirm();
	}

	toast(text: string, command?: string, undo?: () => void) {
		const id = ++this.#toastId;
		this.toasts = [...this.toasts.slice(-2), { id, text, command, undo }];
		setTimeout(() => this.dismissToast(id), undo ? 6000 : 4000);
	}

	dismissToast(id: number) {
		this.toasts = this.toasts.filter((t) => t.id !== id);
	}

	undo() {
		const t = this.toasts.findLast((x) => x.undo);
		if (!t) return;
		t.undo!();
		this.dismissToast(t.id);
	}
}

export const [getInbox, setInbox] = createContext<InboxState>();
