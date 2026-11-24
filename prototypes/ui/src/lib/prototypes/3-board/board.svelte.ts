import { NOW, commandFor, runs } from '#lib';
import type { Project, Run, RunEvent, RunKind } from '#lib';

type Body = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, 'seq' | 'at'> : never) : never;

export interface Toast {
	id: number;
	title: string;
	detail?: string;
	tone: 'info' | 'ok' | 'warn' | 'danger';
}

export interface NewRunSpec {
	project: Project;
	kind: RunKind;
	planDir: string | null;
	prNumber: number | null;
	title: string;
	branch: string | null;
}

const LIVE_ID = 'r-7k2m';

/** Local, mutable board state. Every action only changes this; nothing talks to ship. */
export class Board {
	local = $state<Run[]>(structuredClone(runs.filter((r) => r.runId !== LIVE_ID)));
	toasts = $state<Toast[]>([]);
	filter = $state<string[]>([]);
	swimlanes = $state(false);
	liveCancelled = $state(false);
	#live: { readonly run: Run };
	#toastId = 0;

	constructor(live: { readonly run: Run }) {
		this.#live = live;
	}

	get all(): Run[] {
		return this.liveCancelled ? this.local : [this.#live.run, ...this.local];
	}

	isLive(id: string): boolean {
		return id === LIVE_ID && !this.liveCancelled;
	}

	toggleProject(key: string) {
		this.filter = this.filter.includes(key)
			? this.filter.filter((k) => k !== key)
			: [...this.filter, key];
	}

	toast(t: Omit<Toast, 'id'>) {
		const id = ++this.#toastId;
		this.toasts.push({ ...t, id });
		setTimeout(() => this.dismiss(id), 4200);
	}

	dismiss(id: number) {
		this.toasts = this.toasts.filter((t) => t.id !== id);
	}

	#find(id: string): Run | undefined {
		return this.local.find((r) => r.runId === id);
	}

	#push(run: Run, body: Body) {
		const last = run.events.at(-1);
		const base = Math.max(NOW.getTime(), last ? new Date(last.at).getTime() : 0);
		const at = new Date(base + 3000).toISOString();
		run.events.push({ ...body, seq: run.events.length + 1, at } as RunEvent);
		run.updatedAt = at;
	}

	#moveTo(id: string, to: string, after: Body[] = []) {
		const run = this.#find(id);
		if (!run || (run.status !== 'running' && run.status !== 'waiting')) return;
		this.#push(run, { _tag: 'StateChanged', from: run.state, to });
		run.state = to;
		for (const b of after) this.#push(run, b);
	}

	cancel(id: string) {
		if (this.isLive(id)) {
			this.local.unshift($state.snapshot(this.#live.run) as Run);
			this.liveCancelled = true;
		}
		const run = this.#find(id);
		if (!run) return;
		run.status = 'cancelled';
		run.state = 'cancelled';
		this.#push(run, { _tag: 'RunCancelled' });
		this.#push(run, { _tag: 'RunFinished', status: 'cancelled' });
		this.toast({ title: `Cancelled ${id}`, detail: `ship cancel ${id}`, tone: 'warn' });
	}

	resume(id: string) {
		const run = this.#find(id);
		if (!run) return;
		const wasFailed = run.status === 'failed';
		this.#push(run, { _tag: 'RunResumed' });
		let detail = 'continuing from the last checkpoint';
		if (run.state === 'failed') {
			const failed = run.events.findLast((e) => e._tag === 'StepEnded' && e.outcome !== 'ok');
			const step = failed?._tag === 'StepEnded' ? failed.step : 'implement';
			this.#push(run, { _tag: 'StateChanged', from: run.state, to: step });
			this.#push(run, { _tag: 'StepStarted', step });
			run.state = step;
			detail = `retrying ${step} from its checkpoint`;
		}
		run.status = 'running';
		run.error = null;
		this.toast({
			title: `${wasFailed ? 'Retrying' : 'Resumed'} ${id}`,
			detail: `ship resume ${id} · ${detail}`,
			tone: 'ok'
		});
	}

	start(spec: NewRunSpec): string {
		const id = `r-${Math.random().toString(36).slice(2, 6)}`;
		const initial =
			spec.kind === 'ship' || spec.kind === 'implement'
				? 'baseline.running'
				: spec.kind === 'review'
					? 'review'
					: spec.kind;
		const run: Run = {
			runId: id,
			kind: spec.kind,
			projectKey: spec.project.key,
			cwd: spec.project.path,
			status: 'running',
			state: 'idle',
			round: spec.kind === 'review' ? 1 : 0,
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
			branch: spec.branch,
			planDir: spec.planDir,
			title: spec.title,
			prUrl: spec.prNumber ? `https://${spec.project.key}/pull/${spec.prNumber}` : null,
			prNumber: spec.prNumber,
			reviewId: null,
			costUsd: 0,
			checks: [],
			findings: [],
			disproved: [],
			escalationReason: null,
			error: null,
			events: [],
			commits: [],
			diffStat: { files: 0, additions: 0, deletions: 0 }
		};
		this.local.unshift(run);
		const proxied = this.#find(id)!;
		if (spec.planDir)
			this.#push(proxied, {
				_tag: 'RunCreated',
				branch: spec.branch ?? '',
				planDir: spec.planDir,
				baseSha: '5e1c0a9d2b4f7e31'
			});
		else if (spec.kind === 'review' && spec.prNumber)
			this.#push(proxied, {
				_tag: 'ReviewRunCreated',
				prUrl: proxied.prUrl ?? '',
				prNumber: spec.prNumber,
				baseSha: '0c4be2a19f7d3e58',
				headSha: '7a91d3e04bc2f615'
			});
		this.#push(proxied, { _tag: 'StateChanged', from: 'idle', to: initial });
		proxied.state = initial;

		const firstCheck = spec.project.checks[0];
		if (initial === 'baseline.running' && firstCheck) {
			setTimeout(() => {
				const r = this.#find(id);
				if (r?.status !== 'running') return;
				this.#push(r, { _tag: 'LockAcquired', resource: firstCheck.lock, check: firstCheck.name, waitedMs: 0 });
				this.#push(r, {
					_tag: 'CheckStarted',
					check: firstCheck.name,
					command: 'run',
					baseline: true,
					round: 0,
					attempt: 0,
					commandLine: firstCheck.run
				});
			}, 2500);
			setTimeout(() => this.#moveTo(id, 'implement', [{ _tag: 'StepStarted', step: 'implement' }]), 7000);
		} else if (initial === 'review') {
			setTimeout(() => {
				const r = this.#find(id);
				if (r?.status !== 'running') return;
				this.#push(r, {
					_tag: 'ClefDecision',
					decision: 'reviewer routing',
					probability: 0.64,
					detail: 'added contracts (p=0.64); risk routine → sonnet'
				});
				this.#push(r, {
					_tag: 'ReviewStarted',
					round: 1,
					fromSha: '0c4be2a19f7d3e58',
					toSha: '7a91d3e04bc2f615',
					reviewers: ['standards', 'spec', 'tests', 'contracts']
				});
			}, 2500);
		} else {
			setTimeout(() => {
				const r = this.#find(id);
				if (r?.status === 'running') this.#push(r, { _tag: 'StepStarted', step: spec.kind });
			}, 2000);
		}

		this.toast({ title: `Started ${id}`, detail: commandFor({ ...spec, reviewId: null }), tone: 'ok' });
		return id;
	}

	followUp(source: Run, kind: 'fix' | 'recheck', project: Project): string {
		return this.start({
			project,
			kind,
			planDir: null,
			prNumber: source.prNumber,
			title: source.title,
			branch: source.branch
		});
	}

	restart(source: Run, project: Project): string {
		return this.start({
			project,
			kind: source.kind,
			planDir: source.planDir,
			prNumber: source.prNumber,
			title: source.title,
			branch: source.branch
		});
	}
}
