<script lang="ts">
	import { PIPELINE_STATES, relTime, usd } from '#lib';
	import LogTail from './LogTail.svelte';
	import { getInbox, type RunRow } from './inbox.svelte.ts';

	let { row }: { row: RunRow } = $props();

	const inbox = getInbox();
	const run = $derived(row.command ? undefined : inbox.run(row.runId));
	const top = $derived(row.state.split('.')[0]);
	const idx = $derived(PIPELINE_STATES.indexOf(top as (typeof PIPELINE_STATES)[number]));
</script>

<section class="running">
	<p class="quiet">
		Nothing to decide here — this is the quiet folder. ship will put it in your inbox if it escalates, fails or leaves a tradeoff.
	</p>

	{#if row.kind === 'ship'}
		<ol class="pipe" aria-label="Pipeline">
			{#each PIPELINE_STATES as s, i (s)}
				<li class={[i < idx && 'past', i === idx && 'now', row.status === 'done' && 'past']}>{s}</li>
			{/each}
		</ol>
	{/if}

	<dl>
		<dt>state</dt>
		<dd><code>{row.state}</code>{#if row.status === 'waiting'}&nbsp;· waiting for a lock{/if}</dd>
		{#if run}
			<dt>round</dt>
			<dd>{run.round}</dd>
			<dt>cost</dt>
			<dd>{usd(run.costUsd)}</dd>
			<dt>updated</dt>
			<dd>{relTime(run.updatedAt)}</dd>
		{:else}
			<dt>started</dt>
			<dd>just now by <code>{row.command}</code></dd>
		{/if}
	</dl>

	{#if run}
		<div>
			<h3>Log {#if row.live}<span class="live">live</span>{/if}</h3>
			<LogTail events={run.events} count={12} live={row.live && run.status === 'running'} />
		</div>
	{:else}
		<div class="starting"><span class="spin"></span> Daemon accepted the run; waiting for the first event…</div>
	{/if}
</section>

<style>
	.running {
		display: grid;
		gap: 22px;
	}
	.quiet {
		margin: 0;
		font-size: 13.5px;
		color: var(--muted);
	}
	.pipe {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 4px;
	}
	.pipe li {
		padding-top: 8px;
		border-top: 3px solid var(--line);
		font: 11.5px var(--mono);
		color: var(--faint);
	}
	.pipe .past {
		border-color: var(--ink-2);
		color: var(--muted);
	}
	.pipe .now {
		border-color: var(--live);
		color: var(--ink);
		font-weight: 600;
	}
	dl {
		display: grid;
		grid-template-columns: 90px 1fr;
		gap: 6px 12px;
		margin: 0;
		font-size: 13px;
	}
	dt {
		color: var(--faint);
	}
	dd {
		margin: 0;
		color: var(--ink-2);
	}
	code {
		font: 12px var(--mono);
		color: var(--ink);
	}
	h3 {
		margin: 0 0 10px;
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--muted);
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.live {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 3px;
		background: var(--live);
		color: white;
	}
	.starting {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
		color: var(--muted);
	}
	.spin {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 2px solid var(--line);
		border-top-color: var(--live);
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
