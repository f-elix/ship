<script lang="ts">
	import { describe, usd } from '#lib';
	import type { Run } from '#lib';
	import StageTrack from './StageTrack.svelte';
	import {
		SEVERITIES,
		SEVERITY_COLOR,
		ago,
		attention,
		lastEvent,
		lockWait,
		projectColor,
		projectOf,
		roundLabel,
		severityCounts
	} from './model.ts';

	let {
		run,
		live = false,
		selected = false,
		onopen
	}: { run: Run; live?: boolean; selected?: boolean; onopen: () => void } = $props();

	const project = $derived(projectOf(run));
	const counts = $derived(severityCounts(run));
	const hasFindings = $derived(counts['must-fix'] + counts.tradeoff + counts.nit > 0);
	const wait = $derived(lockWait(run));
	const alert = $derived(attention(run));
	const last = $derived(lastEvent(run));
	const round = $derived(roundLabel(run));
	const active = $derived(run.status === 'running' || run.status === 'waiting');
</script>

<button
	type="button"
	class={['card', selected && 'selected', alert && 'alert', live && 'live']}
	style:--pc={projectColor(run)}
	onclick={onopen}
>
	<div class="top">
		<span class="ptag"><i></i>{project.name}</span>
		<span class="kind">{run.kind}</span>
		{#if live}<span class="livebadge"><i></i>live</span>{/if}
		<span class="rid">{run.runId}</span>
	</div>

	<h3>{run.title}</h3>

	{#if run.branch}
		<div class="branch">
			<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
				><path
					d="M5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm0 0v9m0-9c0 3 6 2 6 6m0 0a1.5 1.5 0 1 0 0 .01M5 12.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z"
					fill="none"
					stroke="currentColor"
					stroke-width="1.3"
				/></svg
			>
			<span>{run.branch}</span>
			{#if run.prNumber}<span class="pr">#{run.prNumber}</span>{/if}
		</div>
	{/if}

	{#if wait}
		<div class="ribbon wait">
			<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
				><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" /><path
					d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"
					fill="none"
					stroke="currentColor"
					stroke-width="1.4"
				/></svg
			>
			waiting for {wait.resource} lock{wait.position ? ` · #${wait.position} in queue` : ''}
		</div>
	{/if}

	{#if alert}
		<div class="ribbon danger">
			<strong>{alert.label}</strong>
			{#if run.escalationReason}<code>{run.escalationReason}</code>{/if}
		</div>
	{/if}

	<StageTrack {run} />

	<div class="meta">
		{#if round}<span class="round">{round}</span>{/if}
		{#if hasFindings}
			<span class="pips" title="{counts['must-fix']} must-fix · {counts.tradeoff} tradeoff · {counts.nit} nit">
				{#each SEVERITIES as s (s)}
					{#if counts[s]}
						<span class="pip" style:--sc={SEVERITY_COLOR[s]}><i></i>{counts[s]}</span>
					{/if}
				{/each}
			</span>
		{/if}
		<span class="cost">{usd(run.costUsd)}</span>
	</div>

	<div class="last">
		{#if active}<span class="beat"></span>{/if}
		{#key last.seq}
			<span class="text">{describe(last)}</span>
		{/key}
		<span class="when">{ago(run.updatedAt)}</span>
	</div>
</button>

<style>
	.card {
		all: unset;
		box-sizing: border-box;
		display: grid;
		gap: 9px;
		width: 100%;
		padding: 12px 13px 11px;
		background: var(--card);
		border-radius: 12px;
		box-shadow: var(--shadow-sm);
		border: 1px solid var(--line);
		cursor: pointer;
		position: relative;
		transition:
			box-shadow 160ms,
			transform 160ms,
			border-color 160ms;
	}
	.card::before {
		content: '';
		position: absolute;
		left: -1px;
		top: 12px;
		bottom: 12px;
		width: 3px;
		border-radius: 0 3px 3px 0;
		background: var(--pc);
	}
	.card:hover {
		box-shadow: var(--shadow-md);
		transform: translateY(-1px);
	}
	.card:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.card.selected {
		border-color: var(--accent);
		box-shadow:
			0 0 0 3px var(--accent-soft),
			var(--shadow-md);
	}
	.card.alert {
		background: linear-gradient(180deg, #fff 0%, #fffafa 100%);
	}
	.card.live {
		border-color: color-mix(in srgb, var(--accent) 35%, var(--line));
	}
	.top {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		min-width: 0;
	}
	.ptag {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-weight: 600;
		color: color-mix(in srgb, var(--pc) 75%, black);
		background: color-mix(in srgb, var(--pc) 10%, white);
		padding: 2px 7px 2px 6px;
		border-radius: 999px;
	}
	.ptag i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--pc);
	}
	.kind {
		font-weight: 600;
		color: var(--ink-2);
		border: 1px solid var(--line);
		padding: 1px 6px;
		border-radius: 5px;
		font-family: var(--mono);
		font-size: 10.5px;
	}
	.livebadge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--accent);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-size: 9.5px;
	}
	.livebadge i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		animation: blink 1.2s infinite;
	}
	.rid {
		margin-left: auto;
		font-family: var(--mono);
		color: var(--ink-3);
		font-size: 10.5px;
	}
	h3 {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.35;
		font-weight: 600;
		color: var(--ink);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.branch {
		display: flex;
		align-items: center;
		gap: 5px;
		font-family: var(--mono);
		font-size: 11px;
		color: var(--ink-2);
		min-width: 0;
	}
	.branch span:first-of-type {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.branch svg {
		flex: none;
		color: var(--ink-3);
	}
	.pr {
		color: var(--ink-3);
	}
	.ribbon {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11.5px;
		padding: 5px 8px;
		border-radius: 7px;
		margin: 0 -2px;
	}
	.ribbon.wait {
		color: #8a5300;
		background: repeating-linear-gradient(-45deg, #fff4dc 0 6px, #fdedc9 6px 12px);
	}
	.ribbon.danger {
		color: #b42328;
		background: #fff0f0;
		justify-content: space-between;
	}
	.ribbon code {
		font-family: var(--mono);
		font-size: 10.5px;
		opacity: 0.85;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11.5px;
		color: var(--ink-2);
	}
	.round {
		font-weight: 600;
		background: var(--canvas);
		padding: 1px 7px;
		border-radius: 5px;
	}
	.pips {
		display: inline-flex;
		gap: 7px;
	}
	.pip {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-weight: 600;
		color: color-mix(in srgb, var(--sc) 80%, black);
	}
	.pip i {
		width: 7px;
		height: 7px;
		border-radius: 2px;
		background: var(--sc);
	}
	.cost {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
		font-weight: 500;
		color: var(--ink);
	}
	.last {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		color: var(--ink-3);
		border-top: 1px dashed var(--line);
		padding-top: 8px;
		min-width: 0;
	}
	.text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink-2);
		animation: rise 300ms ease-out;
	}
	.when {
		flex: none;
	}
	.beat {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--ok);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 20%, transparent);
	}
	@keyframes blink {
		50% {
			opacity: 0.3;
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(3px);
		}
	}
</style>
