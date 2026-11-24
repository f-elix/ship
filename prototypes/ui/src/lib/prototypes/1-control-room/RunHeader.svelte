<script lang="ts">
	import { commandFor, elapsed, projectByKey, usd, type Run } from '#lib';
	import StatusDot from './StatusDot.svelte';
	import { exitCodeFor, isActive } from './model.ts';

	interface Props {
		run: Run;
		oncancel: () => void;
		onresume: () => void;
		onopenpr: () => void;
		onfix: () => void;
		oncopy: (text: string) => void;
	}

	let { run, oncancel, onresume, onopenpr, onfix, oncopy }: Props = $props();

	const project = $derived(projectByKey(run.projectKey));
	const command = $derived(commandFor(run));
	const code = $derived(exitCodeFor(run.status));
	const resumable = $derived(run.status === 'interrupted' || run.status === 'failed');
	const lastStep = $derived.by(() => {
		const e = run.events.findLast((e) => e._tag === 'StepStarted');
		return e?._tag === 'StepStarted' ? e.step : null;
	});
</script>

<header>
	<div class="crumbs">
		<span class={['kind', `k-${run.kind}`]}>{run.kind}</span>
		<span class="proj">{project?.name}</span>
		<span class="sep">/</span>
		<span class="branch">
			<svg viewBox="0 0 16 16" aria-hidden="true"
				><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle
					cx="11.5"
					cy="5.5"
					r="1.5"
				/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" /></svg
			>
			{run.branch ?? 'detached'}
		</span>
		{#if run.prNumber}<span class="pr">PR #{run.prNumber}</span>{/if}

		<div class="actions">
			<button class="ghost" onclick={() => oncopy(`ship logs ${run.runId} --json`)} title="copy ship logs command">
				logs
			</button>
			{#if run.status === 'escalated' && run.prNumber}
				<button class="ghost" onclick={onfix} title="start ship fix on the draft PR">ship fix {run.prNumber}</button>
			{/if}
			{#if run.prUrl}
				<button class="ghost" onclick={onopenpr}>
					open PR
					<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2h6v6M10 2 3 9" /></svg>
					<kbd>o</kbd>
				</button>
			{/if}
			{#if resumable}
				<button class="primary" onclick={onresume}>
					<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 2v8l7-4z" /></svg>
					resume <kbd>r</kbd>
				</button>
			{/if}
			{#if isActive(run.status)}
				<button class="danger" onclick={oncancel}>
					<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" /></svg>
					cancel <kbd>x</kbd>
				</button>
			{/if}
		</div>
	</div>

	<h1>{run.title}</h1>

	<dl class="stats">
		<div>
			<dt>run</dt>
			<dd class="id">{run.runId}</dd>
		</div>
		<div>
			<dt>status</dt>
			<dd class={['status', `s-${run.status}`]}><StatusDot status={run.status} /> {run.status}</dd>
		</div>
		<div>
			<dt>state</dt>
			<dd>{run.state}</dd>
		</div>
		<div>
			<dt>round</dt>
			<dd>{run.round}<span class="dim">/{project?.caps.reviewRounds ?? 3}</span></dd>
		</div>
		<div>
			<dt>elapsed</dt>
			<dd>{elapsed(run.createdAt, run.updatedAt)}</dd>
		</div>
		<div>
			<dt>cost</dt>
			<dd class="cost">{usd(run.costUsd)}</dd>
		</div>
		<div>
			<dt>exit</dt>
			<dd class={code === null ? 'dim' : code === 0 ? 'ok' : code === 2 ? 'esc' : 'bad'}>{code ?? '—'}</dd>
		</div>
	</dl>

	<div class="cmdline">
		<span class="prompt">{run.cwd} $</span>
		<code>{command}</code>
		<button onclick={() => oncopy(command)} aria-label="Copy command" title="copy">
			<svg viewBox="0 0 12 12" aria-hidden="true"
				><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1" /><path d="M2 8V2h6" /></svg
			>
		</button>
	</div>

	{#if run.status === 'escalated'}
		<div class="banner esc">
			<b>escalated · {run.escalationReason}</b>
			<span
				>{run.escalationReason === 'review-cap'
					? `Must-fix findings remained after ${run.round} review rounds. A draft PR lists the unresolved findings.`
					: 'The run stopped and handed off to a human with a draft PR.'}</span
			>
		</div>
	{:else if run.status === 'failed'}
		<div class="banner bad">
			<b>failed{lastStep ? ` in ${lastStep}` : ''}</b>
			<span>{run.error ?? 'The run failed.'} <code>ship resume {run.runId}</code> retries from the failed step.</span>
		</div>
	{:else if run.status === 'interrupted'}
		<div class="banner int">
			<b>interrupted</b>
			<span
				>The daemon stopped while {lastStep ?? run.state} was running. <code>ship resume {run.runId}</code> continues
				it with the current env.</span
			>
		</div>
	{/if}
</header>

<style>
	header {
		padding: 12px 18px 10px;
		border-bottom: 1px solid var(--line);
	}
	.crumbs {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--mono);
		font-size: 11px;
		color: var(--dim);
		min-height: 26px;
	}
	.kind {
		padding: 1px 6px;
		border-radius: 2px;
		background: var(--line);
		color: var(--text);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-size: 10px;
	}
	.k-ship {
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
	}
	.k-review,
	.k-recheck {
		background: color-mix(in srgb, var(--c-review) 22%, transparent);
		color: var(--c-review);
	}
	.k-fix {
		background: color-mix(in srgb, var(--c-git) 22%, transparent);
		color: var(--c-git);
	}
	.proj {
		color: var(--text);
	}
	.sep {
		color: var(--faint);
	}
	.branch {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.branch svg {
		width: 12px;
		height: 12px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.2;
	}
	.pr {
		color: var(--c-git);
	}
	.actions {
		display: flex;
		gap: 6px;
		margin-left: auto;
	}
	.actions button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 26px;
		padding: 0 10px;
		border-radius: 3px;
		border: 1px solid var(--line-strong);
		background: var(--panel);
		color: var(--text);
		font-family: var(--mono);
		font-size: 11px;
		cursor: pointer;
	}
	.actions button:hover {
		border-color: var(--dim);
		color: var(--bright);
	}
	.actions svg {
		width: 10px;
		height: 10px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
	}
	.primary {
		background: var(--accent) !important;
		border-color: var(--accent) !important;
		color: var(--bg) !important;
		font-weight: 600;
	}
	.primary svg {
		fill: currentColor !important;
		stroke: none !important;
	}
	.primary kbd {
		border-color: color-mix(in srgb, var(--bg) 40%, transparent);
		color: var(--bg);
	}
	.danger {
		color: var(--s-failed) !important;
		border-color: color-mix(in srgb, var(--s-failed) 45%, transparent) !important;
	}
	.danger:hover {
		background: color-mix(in srgb, var(--s-failed) 12%, var(--panel)) !important;
	}
	.danger svg {
		fill: currentColor !important;
	}
	kbd {
		font-family: var(--mono);
		font-size: 9.5px;
		padding: 0 4px;
		border: 1px solid var(--line-strong);
		border-radius: 2px;
		color: var(--dim);
		line-height: 14px;
	}
	h1 {
		margin: 6px 0 8px;
		font-size: 19px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--bright);
	}
	.stats {
		display: flex;
		gap: 0;
		margin: 0;
		font-family: var(--mono);
		font-size: 12px;
	}
	.stats div {
		padding: 0 16px;
		border-left: 1px solid var(--line);
	}
	.stats div:first-child {
		padding-left: 0;
		border-left: 0;
	}
	dt {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--faint);
		margin-bottom: 1px;
	}
	dd {
		margin: 0;
		color: var(--text);
		font-variant-numeric: tabular-nums;
		display: flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
	}
	.id {
		color: var(--bright);
	}
	.cost {
		color: var(--c-cost);
	}
	.status.s-running {
		color: var(--s-running);
	}
	.status.s-waiting {
		color: var(--s-waiting);
	}
	.status.s-escalated {
		color: var(--s-escalated);
	}
	.status.s-failed {
		color: var(--s-failed);
	}
	.status.s-interrupted {
		color: var(--s-interrupted);
	}
	.status.s-done {
		color: var(--s-done);
	}
	.status.s-cancelled {
		color: var(--s-cancelled);
	}
	.dim {
		color: var(--faint);
	}
	.ok {
		color: var(--s-done);
	}
	.esc {
		color: var(--s-escalated);
	}
	.bad {
		color: var(--s-failed);
	}
	.cmdline {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
		padding: 5px 6px 5px 10px;
		border-radius: 3px;
		background: var(--bg);
		border: 1px solid var(--line);
		font-family: var(--mono);
		font-size: 11.5px;
	}
	.prompt {
		color: var(--faint);
	}
	.cmdline code {
		flex: 1;
		color: var(--accent);
	}
	.cmdline button {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border: 0;
		border-radius: 2px;
		background: none;
		color: var(--dim);
		cursor: pointer;
	}
	.cmdline button:hover {
		background: var(--hover);
		color: var(--bright);
	}
	.cmdline svg {
		width: 12px;
		height: 12px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.2;
	}
	.banner {
		display: flex;
		gap: 10px;
		align-items: baseline;
		margin-top: 8px;
		padding: 6px 10px;
		border-radius: 3px;
		border-left: 3px solid var(--bc);
		background: color-mix(in srgb, var(--bc) 10%, transparent);
		font-size: 12px;
		color: var(--text);
	}
	.banner b {
		font-family: var(--mono);
		font-size: 11px;
		font-weight: 600;
		color: var(--bc);
		white-space: nowrap;
	}
	.banner code {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--bright);
	}
	.banner.esc {
		--bc: var(--s-escalated);
	}
	.banner.bad {
		--bc: var(--s-failed);
	}
	.banner.int {
		--bc: var(--s-interrupted);
	}
</style>
