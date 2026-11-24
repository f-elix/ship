import { createContext } from 'svelte';
import { NOW, runs as seedRuns } from '#lib';
import type { Run, RunEvent } from '#lib';
import { liveRun } from '#lib/mock/live.svelte.ts';

type Body = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, 'seq' | 'at'> : never) : never;

export interface Toast {
	id: number;
	text: string;
	detail?: string;
	tone: 'ok' | 'warn' | 'info';
}

export interface Confirmation {
	title: string;
	body: string;
	command: string;
	confirmLabel: string;
	tone: 'default' | 'danger';
	onConfirm: () => void;
}

const LIVE_ID = 'r-7k2m';

const newRunId = () => {
	const chars = '0123456789abcdefghijkmnpqrstuvwxyz';
	let id = 'r-';
	for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
	return id;
};

const after = (run: Run, seconds: number) => {
	const last = new Date(run.events.at(-1)?.at ?? run.createdAt).getTime();
	return new Date(Math.max(last, NOW.getTime()) + seconds * 1000).toISOString();
};

const append = (run: Run, bodies: Body[]) => {
	for (const body of bodies) {
		const at = after(run, 1);
		run.events.push({ ...body, seq: run.events.length + 1, at } as RunEvent);
		run.updatedAt = at;
	}
};

/** Local, mutable copy of the mock runs plus the live one; every action only touches this. */
export class TimelineState {
	#live = liveRun();
	#liveCut = $state<number | null>(null);
	#toastId = 0;

	runs = $state<Run[]>(structuredClone(seedRuns.filter((r) => r.runId !== LIVE_ID)));
	toasts = $state<Toast[]>([]);
	confirmation = $state<Confirmation | null>(null);
	/** Runs started from another run's page, keyed by the parent run id. */
	followUps = $state<Record<string, string[]>>({});

	live = $derived.by((): Run => {
		const run = this.#live.run;
		if (this.#liveCut === null) return run;
		const events = run.events.slice(0, this.#liveCut);
		const at = new Date(new Date(events.at(-1)!.at).getTime() + 2000).toISOString();
		return {
			...run,
			status: 'cancelled',
			state: 'cancelled',
			updatedAt: at,
			events: [
				...events,
				{ _tag: 'RunCancelled', seq: events.length + 1, at },
				{ _tag: 'RunFinished', status: 'cancelled', seq: events.length + 2, at }
			]
		};
	});

	all = $derived([this.live, ...this.runs]);

	get(id: string): Run | undefined {
		return this.all.find((r) => r.runId === id);
	}

	toast(text: string, tone: Toast['tone'] = 'info', detail?: string) {
		const id = ++this.#toastId;
		this.toasts.push({ id, text, tone, detail });
		setTimeout(() => this.dismiss(id), 4200);
	}

	dismiss(id: number) {
		this.toasts = this.toasts.filter((t) => t.id !== id);
	}

	ask(c: Confirmation) {
		this.confirmation = c;
	}

	cancel(id: string) {
		if (id === LIVE_ID) {
			this.#liveCut = this.#live.run.events.length;
		} else {
			const run = this.runs.find((r) => r.runId === id);
			if (!run) return;
			append(run, [{ _tag: 'RunCancelled' }, { _tag: 'RunFinished', status: 'cancelled' }]);
			run.status = 'cancelled';
			run.state = 'cancelled';
		}
		this.toast(`Cancelled ${id}`, 'warn', 'Locks released; the branch keeps any commits already made.');
	}

	/** `ship resume` on an interrupted run: continues the step it was in. */
	resume(id: string) {
		const run = this.runs.find((r) => r.runId === id);
		if (!run) return;
		append(run, [
			{ _tag: 'RunResumed' },
			{ _tag: 'StateChanged', from: run.state, to: run.state },
			{ _tag: 'StepStarted', step: 'check-fix' }
		]);
		run.status = 'running';
		this.toast(`Resumed ${id}`, 'ok', 'Continuing check-fix with the current env.');
	}

	/** `ship resume` on a failed run: retries from the step that failed. */
	retry(id: string) {
		const run = this.runs.find((r) => r.runId === id);
		if (!run) return;
		append(run, [
			{ _tag: 'RunResumed' },
			{ _tag: 'StateChanged', from: run.state, to: 'implement' },
			{ _tag: 'StepStarted', step: 'implement' }
		]);
		run.status = 'running';
		run.state = 'implement';
		run.error = null;
		this.toast(`Retrying ${id} from implement`, 'ok', 'The baseline is kept; the implementer starts over.');
	}

	/** `ship fix <pr>` or `ship recheck <pr>` from an escalated run. */
	followUp(parentId: string, kind: 'fix' | 'recheck'): string | undefined {
		const parent = this.get(parentId);
		if (!parent) return;
		const runId = newRunId();
		const at = NOW.toISOString();
		const run: Run = {
			...structuredClone($state.snapshot(parent)),
			runId,
			kind,
			status: 'running',
			state: kind,
			round: 0,
			createdAt: at,
			updatedAt: at,
			planDir: null,
			reviewId: null,
			costUsd: 0,
			checks: [],
			disproved: [],
			escalationReason: null,
			error: null,
			commits: [],
			diffStat: { files: 0, additions: 0, deletions: 0 },
			events: [{ _tag: 'StateChanged', from: 'idle', to: kind, seq: 1, at }]
		};
		append(run, [{ _tag: 'StepStarted', step: kind }]);
		this.runs.unshift(run);
		this.followUps[parentId] = [...(this.followUps[parentId] ?? []), runId];
		this.toast(`Started ${runId}`, 'ok', `ship ${kind} ${parent.prNumber} is running in ${parent.cwd}.`);
		return runId;
	}
}

export const [getTimeline, setTimeline] = createContext<TimelineState>();
