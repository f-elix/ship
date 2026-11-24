import type { Finding, Run } from '#lib';
import { deliverables, STAGES, type Action, type Deliverable, type Stage } from './data.ts';

/**
 * What the developer decided about one open finding before acting. ship has no per-finding
 * decisions today: `fix` takes every must-fix and nit, and `post` posts every finding.
 * The prototype assumes it would grow them.
 */
export type Decision = 'fix' | 'accept' | 'dismiss';

export const defaultDecision = (f: Finding): Decision => (f.severity === 'tradeoff' ? 'accept' : 'fix');

const rank = (s: Stage) => STAGES.findIndex((x) => x.id === s);

export class Inbox {
	items = $state<Deliverable[]>(structuredClone(deliverables));
	selectedId = $state<string>('billing-88');
	project = $state<string | null>(null);
	decisions = $state<Record<string, Decision>>({});
	toasts = $state<{ id: number; text: string; command?: string }[]>([]);
	#toastId = 0;

	visible = $derived(
		this.items
			.filter((d) => this.project === null || d.projectKey === this.project)
			.toSorted((a, b) => rank(a.stage) - rank(b.stage) || b.updatedAt.localeCompare(a.updatedAt))
	);

	groups = $derived(
		STAGES.map((s) => ({ ...s, items: this.visible.filter((d) => d.stage === s.id) })).filter(
			(g) => g.items.length > 0
		)
	);

	selected = $derived(this.items.find((d) => d.id === this.selectedId) ?? this.items[0]);

	counts = $derived(
		Object.fromEntries(STAGES.map((s) => [s.id, this.items.filter((d) => d.stage === s.id).length])) as Record<Stage, number>
	);

	select(id: string) {
		this.selectedId = id;
		const d = this.items.find((x) => x.id === id);
		if (d) d.unread = false;
	}

	move(delta: number) {
		const list = this.visible;
		const i = list.findIndex((d) => d.id === this.selectedId);
		const next = list[Math.min(list.length - 1, Math.max(0, i + delta))];
		if (next) this.select(next.id);
	}

	decision(d: Deliverable, f: Finding): Decision {
		return this.decisions[`${d.id}:${f.id}`] ?? defaultDecision(f);
	}

	decide(d: Deliverable, f: Finding, value: Decision) {
		this.decisions[`${d.id}:${f.id}`] = value;
	}

	/** The open findings the primary action would act on, given the decisions. */
	toFix(d: Deliverable): Finding[] {
		return [...d.open.mustFix, ...d.open.tradeoffs, ...d.open.nits].filter(
			(f) => this.decision(d, f) === 'fix'
		);
	}

	/** The primary action, relabelled from the developer's decisions when they change it. */
	primaryFor(d: Deliverable): Action | null {
		const p = d.primary;
		if (!p) return null;
		if (d.origin === 'reviewed' && p.command.startsWith('ship post')) {
			const kept = [...d.open.mustFix, ...d.open.tradeoffs, ...d.open.nits].filter(
				(f) => this.decision(d, f) !== 'dismiss'
			);
			const must = kept.filter((f) => f.severity === 'must-fix').length;
			if (kept.length === 0) return { ...p, label: 'Nothing to post', command: '—' };
			return { ...p, label: `Post ${kept.length} finding${kept.length === 1 ? '' : 's'}${must ? ' · request changes' : ' · comment'}` };
		}
		if (p.command.startsWith('ship fix')) {
			const fix = this.toFix(d);
			if (fix.length === 0) return { ...p, label: 'Nothing to fix', command: '—' };
			const must = fix.filter((f) => f.severity === 'must-fix').length;
			const other = fix.length - must;
			const parts = [must && `${must} must-fix`, other && `${other} other`].filter(Boolean);
			return { ...p, label: `Fix ${parts.join(' + ')}` };
		}
		return p;
	}

	act(d: Deliverable, action: Action) {
		if (action.command === '—' && !action.then) return;
		if (action.then) {
			d.stage = action.then.stage;
			d.headline = action.then.headline;
			d.updatedAt = new Date().toISOString();
			if (action.then.stage === 'working') {
				d.tone = 'live';
				d.tag = 'starting';
				d.progress = { now: 'Starting', step: 0, of: 5, eta: '—' };
				d.primary = null;
				d.secondary = [];
			} else if (action.then.stage === 'closed') {
				d.tone = 'neutral';
				d.tag = 'closed';
				d.primary = null;
				d.secondary = [];
			} else {
				d.tone = 'ok';
				d.tag = 'clean';
				d.primary = null;
			}
		}
		this.toast(action.label, action.command === '—' ? undefined : action.command);
	}

	toast(text: string, command?: string) {
		const id = ++this.#toastId;
		this.toasts.push({ id, text, command });
		setTimeout(() => (this.toasts = this.toasts.filter((t) => t.id !== id)), 3800);
	}

	/** Mirrors the live `ship run` (r-7k2m) onto its deliverable. */
	syncLive(run: Run) {
		const d = this.items.find((x) => x.id === 'ship-clef-routing');
		if (!d) return;
		if (run.status === 'done' && d.stage === 'working') {
			d.stage = 'ready';
			d.tone = 'ok';
			d.tag = 'clean';
			d.unread = true;
			d.pr = { number: 29, url: 'https://github.com/f-elix/ship/pull/29', state: 'draft', ci: 'pending', threads: { open: 0, resolved: 0 }, approval: 'none' };
			d.headline = 'Draft PR is up: checks pass, no must-fix left. 1 tradeoff is listed in the PR body for you to accept.';
			d.progress = null;
			d.primary = { label: 'Mark ready for review', command: 'gh pr ready 29', tone: 'primary', then: { stage: 'ready', headline: 'PR #29 is open for review.' } };
			d.secondary = [{ label: 'Open diff', command: 'gh pr diff 29' }];
			d.updatedAt = run.updatedAt;
			this.toast('PR #29 is up: Route reviewer selection through Clef');
			return;
		}
		if (run.status === 'running' && d.stage === 'ready' && d.pr?.number === 29) {
			// The simulation looped; put the deliverable back in progress.
			const fresh = deliverables.find((x) => x.id === d.id)!;
			Object.assign(d, structuredClone(fresh));
			return;
		}
		if (d.stage !== 'working' || !d.progress) return;
		const phase: Record<string, [string, number, string]> = {
			review: ['Reviewing the fixes', 4, 'Waiting on the second review of ship’s fixes.'],
			triage: ['Sorting findings', 4, 'Second review is in: no must-fix left. Sorting what remains.'],
			pr: ['Opening the PR', 5, 'Clean after 2 rounds. Pushing the branch and opening a draft PR.']
		};
		const p = phase[run.state];
		if (p) {
			d.progress.now = p[0];
			d.progress.step = p[1];
			d.headline = `${run.commits.length} commits, checks pass. ${p[2]}`;
			d.tag = run.state === 'pr' ? 'opening PR' : run.state === 'triage' ? 'sorting' : 'review 2/3';
		}
		d.updatedAt = run.updatedAt;
	}
}
