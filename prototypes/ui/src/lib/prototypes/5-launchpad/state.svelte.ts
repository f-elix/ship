import { createContext } from 'svelte';
import {
	NOW,
	daemon as baseDaemon,
	globalConfig,
	locks as baseLocks,
	openPrs,
	plans as basePlans,
	projects as baseProjects,
	runs as baseRuns
} from '#lib';
import type { DaemonInfo, LockResource, OpenPr, PlanDir, Project, Run, RunKind } from '#lib';
import { liveRun } from '#lib/mock/live.svelte.ts';
import { MODEL_STEPS, SCHEMA_TIMEOUT_DEFAULTS, TIMEOUT_KEYS, configFromProject, type ModelStep, type ProjectConfig, type TimeoutKey } from './config.ts';

export type Tone = 'neutral' | 'success' | 'warn' | 'danger';

export interface Toast {
	id: number;
	title: string;
	body?: string;
	command?: string;
	tone: Tone;
}

export interface ConfirmRequest {
	title: string;
	body: string;
	command?: string;
	confirmLabel: string;
	tone?: 'danger' | 'accent';
	onConfirm: () => void;
	/** A second, stronger option, e.g. `--force`. */
	alt?: { label: string; command?: string; onClick: () => void };
}

export interface LaunchTarget {
	plan: PlanDir;
	project: Project;
}

const ACTIVE = new Set(['running', 'waiting']);

const randomId = () => 'r-' + Math.random().toString(36).slice(2, 6);

export class Launchpad {
	live = liveRun();
	projects = $state<Project[]>(structuredClone(baseProjects));
	configs = $state<Record<string, ProjectConfig>>(
		Object.fromEntries(baseProjects.map((p) => [p.key, configFromProject(p)]))
	);
	#runs = $state<Run[]>(structuredClone(baseRuns));
	/** Set once r-7k2m is touched locally, so the scripted copy stops overriding it. */
	#liveDetached = $state(false);
	plans = $state<PlanDir[]>(structuredClone(basePlans));
	prs = $state<OpenPr[]>(structuredClone(openPrs));
	daemon = $state<DaemonInfo & { running: boolean }>({ ...structuredClone(baseDaemon), running: true });
	locks = $state<LockResource[]>(structuredClone(baseLocks));
	/** ~/.ship/config.json as edited; `appliedLocks` is what the running daemon loaded. */
	global = $state({
		locks: { ...globalConfig.locks } as Record<string, number>,
		models: Object.fromEntries(MODEL_STEPS.map((s) => [s, (globalConfig.models as Record<string, string>)[s] ?? ''])) as Record<ModelStep, string>,
		caps: { ...globalConfig.caps },
		timeouts: Object.fromEntries(
			TIMEOUT_KEYS.map((k) => [k, (globalConfig.timeouts as Record<string, string>)[k] ?? ''])
		) as Record<TimeoutKey, string>
	});
	appliedLocks = $state<Record<string, number>>({ ...globalConfig.locks });
	credentials = $state({ accountId: '9c41d07be2a84f0f8d1e5a2c7b3f3f9a', token: 'cf_wai_Q2x7mTn4hR8vL1pZ0aK6sYd3', checkedAt: '2026-11-02T10:14:00Z' });

	toasts = $state<Toast[]>([]);
	confirmReq = $state<ConfirmRequest | null>(null);
	launch = $state<LaunchTarget | null>(null);
	wizardOpen = $state(false);
	paletteOpen = $state(false);
	#toastId = 0;

	get runs(): Run[] {
		if (this.#liveDetached) return this.#runs;
		return this.#runs.map((r) => (r.runId === 'r-7k2m' ? this.live.run : r));
	}

	get activeRuns() {
		return this.runs.filter((r) => ACTIVE.has(r.status));
	}
	get attentionRuns() {
		return this.runs.filter((r) => r.status === 'escalated' || r.status === 'failed' || r.status === 'interrupted');
	}

	project(name: string) {
		return this.projects.find((p) => p.name === name);
	}
	projectOf(key: string) {
		return this.projects.find((p) => p.key === key);
	}
	runsFor(key: string) {
		return this.runs
			.filter((r) => r.projectKey === key)
			.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	plansFor(key: string) {
		return this.plans.filter((p) => p.project === key);
	}
	prsFor(key: string) {
		return this.prs.filter((p) => p.project === key);
	}
	spendFor(key: string) {
		return this.runs.filter((r) => r.projectKey === key).reduce((t, r) => t + r.costUsd, 0);
	}
	timeoutDefault(k: TimeoutKey) {
		return this.global.timeouts[k] || SCHEMA_TIMEOUT_DEFAULTS[k];
	}

	toast(title: string, opts: { body?: string; command?: string; tone?: Tone } = {}) {
		const id = ++this.#toastId;
		this.toasts.push({ id, title, tone: opts.tone ?? 'neutral', body: opts.body, command: opts.command });
		setTimeout(() => this.dismiss(id), 5200);
	}
	dismiss(id: number) {
		this.toasts = this.toasts.filter((t) => t.id !== id);
	}
	confirm(req: ConfirmRequest) {
		this.confirmReq = req;
	}

	#mutable(runId: string) {
		if (runId === 'r-7k2m' && !this.#liveDetached) {
			const i = this.#runs.findIndex((r) => r.runId === runId);
			this.#runs[i] = structuredClone($state.snapshot(this.live.run)) as Run;
			this.#liveDetached = true;
		}
		return this.#runs.find((r) => r.runId === runId);
	}

	/** Starts a new run locally, as the daemon would after its preconditions held. */
	startRun(input: { kind: RunKind; project: Project; title: string; branch: string | null; planDir?: string | null; prNumber?: number | null }) {
		const runId = randomId();
		const at = NOW.toISOString();
		const state = input.kind === 'ship' || input.kind === 'implement' ? 'baseline.running' : input.kind === 'checks' ? 'checks.running' : input.kind;
		this.#runs.unshift({
			runId,
			kind: input.kind,
			projectKey: input.project.key,
			cwd: input.project.path,
			status: 'running',
			state,
			round: input.kind === 'review' ? 1 : 0,
			createdAt: at,
			updatedAt: at,
			branch: input.branch,
			planDir: input.planDir ?? null,
			title: input.title,
			prUrl: input.prNumber ? `https://${input.project.key}/pull/${input.prNumber}` : null,
			prNumber: input.prNumber ?? null,
			reviewId: null,
			costUsd: 0,
			checks: [],
			findings: [],
			disproved: [],
			escalationReason: null,
			error: null,
			events: [
				input.planDir
					? { seq: 1, at, _tag: 'RunCreated', branch: input.branch ?? '', planDir: input.planDir, baseSha: 'b2e78640c1d2e3f4' }
					: { seq: 1, at, _tag: 'StateChanged', from: 'idle', to: state }
			],
			commits: [],
			diffStat: { files: 0, additions: 0, deletions: 0 }
		});
		return runId;
	}

	cancelRun(runId: string) {
		const r = this.#mutable(runId);
		if (!r) return;
		r.status = 'cancelled';
		r.state = 'cancelled';
		this.toast(`${runId} cancelled`, { command: `ship cancel ${runId}`, tone: 'neutral', body: 'It ends as cancelled; its commits stay on the branch.' });
	}

	resumeRun(runId: string) {
		const r = this.#mutable(runId);
		if (!r) return;
		if (!this.daemon.running) {
			this.daemon.running = true;
			this.daemon.startedAt = NOW.toISOString();
		}
		const from = r.status;
		r.status = 'running';
		this.toast(`Resumed ${runId}`, {
			command: `ship resume ${runId}`,
			tone: 'success',
			body: from === 'failed' ? `Retrying from the step that failed (${r.state}).` : `Continuing from ${r.state}.`
		});
	}

	/** Interrupts every active run, as `--force` does. */
	interruptActive() {
		for (const r of this.activeRuns.map((r) => r.runId)) {
			const run = this.#mutable(r);
			if (run) run.status = 'interrupted';
		}
	}

	restartDaemon(force: boolean) {
		const active = this.activeRuns.length;
		if (force) this.interruptActive();
		this.daemon.running = true;
		this.daemon.pid = 48213 + Math.floor(Math.random() * 900) + 100;
		this.daemon.startedAt = NOW.toISOString();
		this.appliedLocks = { ...this.global.locks };
		for (const l of this.locks) l.permits = this.global.locks[l.name] ?? l.permits;
		this.toast('Daemon restarted', {
			command: `ship daemon restart${force ? ' --force' : ''}`,
			tone: 'success',
			body: force && active ? `${active} run${active === 1 ? ' was' : 's were'} interrupted; ship resume <id> continues them.` : `pid ${this.daemon.pid}, lock permits reloaded.`
		});
	}

	stopDaemon(force: boolean) {
		if (force) this.interruptActive();
		this.daemon.running = false;
		this.toast('Daemon stopped', { command: `ship daemon stop${force ? ' --force' : ''}`, body: 'The next command that needs it starts it again.' });
	}

	addProject(p: Project, config: ProjectConfig) {
		this.projects.push(p);
		this.configs[p.key] = config;
	}
}

export const [getLaunchpad, setLaunchpad] = createContext<Launchpad>();
