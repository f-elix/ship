import { onDestroy } from 'svelte';
import { runs } from './data.ts';
import type { Run, RunEvent, RunStatus } from './types.ts';

type Body = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, 'seq' | 'at'> : never) : never;

/** What happens next in r-7k2m, the running `ship run`: round 2 finishes clean and the PR opens. */
const script: { body: Body; status?: RunStatus; state?: string }[] = [
	{ body: { _tag: 'FindingsReported', round: 2, reviewer: 'error-handling', count: 0 } },
	{ body: { _tag: 'FindingsReported', round: 2, reviewer: 'spec', count: 1 } },
	{ body: { _tag: 'AgentCost', step: 'review', model: 'claude-sonnet-5-5', costUsd: 0.86 } },
	{ body: { _tag: 'FindingsVerified', round: 2, verified: [], disproved: 1 } },
	{ body: { _tag: 'AgentCost', step: 'verify', model: 'claude-sonnet-5-5', costUsd: 0.21 } },
	{ body: { _tag: 'StateChanged', from: 'review', to: 'triage' }, state: 'triage' },
	{ body: { _tag: 'FindingsTriaged', round: 2, mustFix: [], tradeoffs: ['f1-4'], nits: [] } },
	{ body: { _tag: 'StateChanged', from: 'triage', to: 'pr' }, state: 'pr' },
	{ body: { _tag: 'BranchPushed', sha: '9f3c21aa0b7e4d12', remote: 'origin', ref: 'felix/clef-routing' } },
	{ body: { _tag: 'StepStarted', step: 'pr' } },
	{ body: { _tag: 'AgentCost', step: 'pr', model: 'claude-haiku-5-5', costUsd: 0.05 } },
	{ body: { _tag: 'StepEnded', step: 'pr', outcome: 'ok', durationMs: 48_000 } },
	{ body: { _tag: 'PrOpened', url: 'https://github.com/f-elix/ship/pull/29', draft: true } },
	{ body: { _tag: 'StateChanged', from: 'pr', to: 'done' }, state: 'done', status: 'done' },
	{ body: { _tag: 'RunFinished', status: 'done' } }
];

/**
 * A reactive copy of the running `ship run` that appends one scripted event every
 * `intervalMs`, then starts over. Call from a component's script block.
 */
export function liveRun(intervalMs = 2500): { readonly run: Run; readonly lastEvent: RunEvent } {
	const base = runs.find((r) => r.runId === 'r-7k2m')!;
	let run = $state<Run>(structuredClone(base));
	let step = 0;

	const tick = () => {
		if (step >= script.length + 3) {
			run = structuredClone(base);
			step = 0;
			return;
		}
		const next = script[step++];
		if (!next) return;
		const at = new Date(new Date(run.events.at(-1)!.at).getTime() + 6000).toISOString();
		const event = { ...next.body, seq: run.events.length + 1, at } as RunEvent;
		run.events.push(event);
		run.updatedAt = at;
		if (next.state) run.state = next.state;
		if (next.status) run.status = next.status;
		if (event._tag === 'AgentCost') run.costUsd += event.costUsd;
		if (event._tag === 'PrOpened') {
			run.prUrl = event.url;
			run.prNumber = 29;
		}
	};

	const id = setInterval(tick, intervalMs);
	onDestroy(() => clearInterval(id));

	return {
		get run() {
			return run;
		},
		get lastEvent() {
			return run.events.at(-1)!;
		}
	};
}
