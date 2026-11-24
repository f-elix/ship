<script lang="ts">
	import { fly, slide } from 'svelte/transition';
	import { clock, describe, duration, shortSha, usd } from '#lib';
	import type { Run } from '#lib';
	import { findingById, phaseDuration, phaseGist, shortModel, stepInfo, type Phase } from './phases.ts';
	import ChecksBody from './ChecksBody.svelte';
	import ReviewBody from './ReviewBody.svelte';
	import TriageBody from './TriageBody.svelte';
	import FindingCard from './FindingCard.svelte';

	let { run, phase, open, ontoggle }: { run: Run; phase: Phase; open: boolean; ontoggle: () => void } = $props();

	let gist = $derived(phaseGist(run, phase));
	let live = $derived(phase.status === 'current' || phase.status === 'waiting');
	let step = $derived(
		phase.kind === 'implement' || phase.kind === 'fix' || phase.kind === 'recheck' || phase.kind === 'pr'
			? stepInfo(phase, phase.kind)
			: null
	);
	let marks = $derived(phase.events.filter((e) => e._tag === 'CommitCreated' || e._tag === 'BranchPushed'));
	let pr = $derived.by(() => {
		const e = phase.events.find((e) => e._tag === 'PrOpened');
		return e?._tag === 'PrOpened' ? e : null;
	});
	let logLines = $derived(phase.events.filter((e) => e._tag !== 'StateChanged'));
</script>

<li class={['phase', phase.status, open && 'open']} id={phase.id} in:fly={{ y: 10, duration: 360 }}>
	<time class="when" datetime={phase.start}>{clock(phase.start).slice(0, 5)}</time>
	<span class="node" aria-hidden="true"></span>

	<button type="button" class="head" aria-expanded={open} onclick={ontoggle}>
		<span class="titles">
			<h3>{phase.title}</h3>
			{#if !open}<span class="gist">{gist}</span>{/if}
		</span>
		<span class="meta">
			{#if phase.status === 'failed'}<span class="flag red">failed</span>{/if}
			{#if phase.status === 'interrupted'}<span class="flag amber">interrupted</span>{/if}
			{#if phase.status === 'cancelled'}<span class="flag">cancelled</span>{/if}
			{#if phase.status === 'waiting'}<span class="flag amber">waiting</span>{/if}
			<span>{duration(phaseDuration(phase))}{live ? ' so far' : ''}</span>
			{#if phase.cost > 0}<span class="dot">·</span><span>{usd(phase.cost)}</span>{/if}
			<svg class="chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="m2.5 3.8 2.5 2.5 2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
		</span>
	</button>

	{#if open}
		<div class="body" transition:slide={{ duration: 220 }}>
			{#if phase.kind === 'baseline' || phase.kind === 'checks'}
				<ChecksBody {phase} />
			{:else if phase.kind === 'review'}
				<ReviewBody {run} {phase} />
			{:else if phase.kind === 'triage'}
				<TriageBody {run} {phase} />
			{:else if phase.kind === 'implement'}
				<p class="prose">
					{#if !step}
						Waiting to start the implementer.
					{:else if step.durationMs === null}
						The implementer (<em>{shortModel(step.model)}</em>) is reading
						<code>spec.md</code> and <code>implementation-plan.md</code>{run.planDir ? ` in ${run.planDir}` : ''} and writing the change<span
							class="ellipsis">…</span
						>
					{:else}
						The implementer (<em>{shortModel(step.model)}</em>, <code>{step.model}</code>) read
						<code>spec.md</code> and <code>implementation-plan.md</code>{run.planDir ? ` in ${run.planDir}` : ''} and worked for
						{duration(step.durationMs)}.
					{/if}
				</p>
				{#if step?.error}
					<p class="error">{step.error}</p>
				{/if}
			{:else if phase.kind === 'fix'}
				<p class="prose">
					{#if phase.addresses.length}
						The fix agent{step?.model ? ` (${shortModel(step.model)})` : ''} took the must-fix findings of round {phase.round}{step?.durationMs
							? ` and worked for ${duration(step.durationMs)}`
							: ''}{step?.durationMs === null ? ', and is working' : ''}.
					{:else}
						The fix agent{step?.model ? ` (${shortModel(step.model)})` : ''} worked through the findings left on PR #{run.prNumber}{step?.durationMs
							? ` for ${duration(step.durationMs)}`
							: ''}{step && step.durationMs === null ? '…' : '.'}
					{/if}
				</p>
				{#each phase.addresses as id (id)}
					{@const f = findingById(run, id)}
					{#if f}<FindingCard finding={f} compact />{/if}
				{/each}
			{:else if phase.kind === 'recheck'}
				<p class="prose">
					The verifier asked, over the diff from the merge base to the head, whether each finding on PR #{run.prNumber} is fixed{step?.durationMs
						? `, taking ${duration(step.durationMs)}`
						: ''}{step && step.durationMs === null ? '…' : '.'}
				</p>
			{:else if phase.kind === 'pr'}
				<p class="prose">
					{#if phase.escalation}
						Instead of finishing, ship pushed the branch and had the PR agent open a <em>draft</em> with a warning on top and the
						open findings listed at the end.
					{:else if pr}
						The PR agent{step?.model ? ` (${shortModel(step.model)})` : ''} wrote the description from the plan and the commits.
					{:else}
						Pushing the branch and asking the PR agent to describe the change<span class="ellipsis">…</span>
					{/if}
				</p>
				{#if pr}
					<a class="pr" href={pr.url} target="_blank" rel="noreferrer">
						<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3" /><circle cx="4" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3" /><circle cx="12" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3" /><path d="M4 5.3v5.4M12 10.7V6.5a2 2 0 0 0-2-2H7.5m0 0L9 3m-1.5 1.5L9 6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
						<span class="pr-title">{run.title}</span>
						<span class="pr-num">#{pr.url.split('/').at(-1)}</span>
						{#if pr.draft}<span class="pr-draft">draft</span>{/if}
					</a>
				{/if}
			{/if}

			{#if marks.length}
				<div class="marks">
					{#each marks as m (m.seq)}
						{#if m._tag === 'CommitCreated'}
							<span class="chip commit" in:fly={{ y: 4, duration: 260 }}>
								<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3" /><path d="M0 7h4.4M9.6 7H14" stroke="currentColor" stroke-width="1.3" /></svg>
								<code>{shortSha(m.sha)}</code>
								<span>{m.message}</span>
							</span>
						{:else if m._tag === 'BranchPushed'}
							<span class="chip push" in:fly={{ y: 4, duration: 260 }}>
								<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 11.5V2.5M3.5 6 7 2.5 10.5 6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
								pushed <code>{shortSha(m.sha)}</code> to <code>{m.remote}/{m.ref}</code>
							</span>
						{/if}
					{/each}
				</div>
			{/if}

			{#if logLines.length}
				<details class="log">
					<summary>{logLines.length} events</summary>
					<ol>
						{#each logLines as e (e.seq)}
							<li><time>{clock(e.at)}</time><span>{describe(e)}</span></li>
						{/each}
					</ol>
				</details>
			{/if}
		</div>
	{/if}
</li>

<style>
	.phase {
		--node: var(--ink-2);
		position: relative;
		padding: 0 0 26px 34px;
	}

	.when {
		position: absolute;
		right: calc(100% + 18px);
		top: 6px;
		font: 12px var(--mono);
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}

	.node {
		position: absolute;
		left: -5px;
		top: 9px;
		width: 11px;
		height: 11px;
		border-radius: 50%;
		background: var(--node);
		box-shadow: 0 0 0 4px var(--paper);
	}

	.current {
		--node: var(--blue);
	}
	.current .node {
		background: var(--paper);
		border: 2px solid var(--node);
		animation: pulse 2.2s ease-out infinite;
	}

	.waiting {
		--node: var(--amber);
	}
	.waiting .node {
		background: var(--paper);
		border: 2px dashed var(--node);
	}

	.failed {
		--node: var(--red);
	}
	.escalated,
	.interrupted {
		--node: var(--amber);
	}
	.cancelled {
		--node: var(--faint);
	}

	@keyframes pulse {
		0% {
			box-shadow:
				0 0 0 4px var(--paper),
				0 0 0 4px color-mix(in srgb, var(--blue) 35%, transparent);
		}
		100% {
			box-shadow:
				0 0 0 4px var(--paper),
				0 0 0 14px transparent;
		}
	}

	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 24px;
		width: 100%;
		padding: 0;
		border: 0;
		background: none;
		text-align: left;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.titles {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	h3 {
		margin: 0;
		font: 500 22px/1.3 var(--serif);
		letter-spacing: -0.005em;
		color: var(--ink);
	}

	.head:hover h3 {
		text-decoration: underline;
		text-decoration-color: var(--rule-strong);
		text-underline-offset: 4px;
	}

	.gist {
		margin-top: 1px;
		font-size: 14px;
		color: var(--muted);
	}

	.failed .gist {
		color: var(--red);
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		font: 12.5px var(--mono);
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.dot {
		color: var(--faint);
	}

	.chev {
		margin-left: 6px;
		color: var(--faint);
		transition: rotate 160ms;
		rotate: -90deg;
	}

	.open .chev {
		rotate: 0deg;
	}

	.flag {
		font: 600 10.5px var(--sans);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
		margin-right: 6px;
	}
	.flag.red {
		color: var(--red);
	}
	.flag.amber {
		color: var(--amber);
	}

	.body {
		padding-top: 12px;
	}

	.prose {
		margin: 0;
		font: 17px/1.6 var(--serif);
		color: var(--ink-2);
	}

	.prose em {
		font-style: italic;
	}

	.error {
		margin: 12px 0 0;
		padding: 10px 14px;
		border-radius: 6px;
		background: var(--red-soft);
		color: var(--red);
		font: 13px var(--mono);
	}

	.ellipsis {
		animation: breathe 1.6s ease-in-out infinite;
	}

	@keyframes breathe {
		50% {
			opacity: 0.3;
		}
	}

	.pr {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		margin-top: 12px;
		padding: 10px 14px;
		border: 1px solid var(--rule-strong);
		border-radius: 8px;
		background: var(--paper-raised);
		color: var(--ink);
		text-decoration: none;
	}

	.pr:hover {
		border-color: var(--ink-2);
	}

	.pr svg {
		color: var(--green);
	}

	.escalated .pr svg {
		color: var(--muted);
	}

	.pr-title {
		font: 500 16px var(--serif);
	}

	.pr-num {
		font: 13px var(--mono);
		color: var(--muted);
	}

	.pr-draft {
		font-size: 11px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 10px;
		background: var(--paper-sunk);
		color: var(--muted);
	}

	.marks {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 14px;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 3px 10px 3px 8px;
		border: 1px solid var(--rule);
		border-radius: 999px;
		background: var(--paper-raised);
		font-size: 13px;
		color: var(--ink-2);
	}

	.chip svg {
		color: var(--muted);
	}

	.chip code {
		font-size: 12px;
		color: var(--blue);
	}

	.push {
		color: var(--muted);
	}

	.log {
		margin-top: 14px;
		font-size: 12.5px;
		color: var(--muted);
	}

	summary {
		cursor: pointer;
		width: max-content;
		list-style: none;
		color: var(--faint);
	}

	summary::before {
		content: '¶ ';
	}

	summary:hover {
		color: var(--ink-2);
	}

	.log ol {
		margin: 8px 0 0;
		padding: 10px 12px;
		list-style: none;
		background: var(--paper-sunk);
		border-radius: 6px;
		font: 12px/1.7 var(--mono);
	}

	.log li {
		display: flex;
		gap: 12px;
	}

	.log time {
		color: var(--faint);
		flex-shrink: 0;
	}
</style>
