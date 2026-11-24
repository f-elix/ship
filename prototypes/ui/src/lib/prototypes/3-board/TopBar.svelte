<script lang="ts">
	import { NOW, daemon, dailyCost, locks, projects, usd } from '#lib';
	import type { Board } from './board.svelte.ts';
	import { PROJECT_COLOR } from './model.ts';

	let {
		board,
		active,
		onnew
	}: { board: Board; active: Record<string, number>; onnew: () => void } = $props();

	const uptimeH = Math.floor((NOW.getTime() - new Date(daemon.startedAt).getTime()) / 3_600_000);
	const today = dailyCost.at(-1) ?? 0;
	const yesterday = dailyCost.at(-2) ?? 0;
	const total = dailyCost.reduce((a, b) => a + b, 0);
	const max = Math.max(...dailyCost);
	const day = (i: number) =>
		new Date(NOW.getTime() - (dailyCost.length - 1 - i) * 86_400_000).toISOString().slice(5, 10);
</script>

<header class="bar">
	<div class="brand">
		<span class="mark" aria-hidden="true">
			<svg viewBox="0 0 20 20" width="18" height="18"
				><path d="M3 12.5h14l-2.2 3.5H5.2Z" fill="currentColor" /><path
					d="M10 3v8M10 3l4.5 7H10"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linejoin="round"
				/></svg
			>
		</span>
		<span class="name">ship</span>
		<span class="slash">/</span>
		<span class="view">Board</span>
	</div>

	<div class="pill daemon" title="pid {daemon.pid} · {daemon.socket}">
		<span class="dot"></span>
		<span>daemon <b>{daemon.version}</b></span>
		<span class="muted">up {uptimeH}h</span>
		{#if daemon.clefConfigured}<span class="clef" title="Clef credentials configured">clef</span>{/if}
	</div>

	<div class="locks">
		{#each locks as l (l.name)}
			{@const full = l.held.length >= l.permits}
			<div
				class={['lock', full && 'full']}
				title={[
					...l.held.map((h) => `held · ${h.runId} ${h.check}`),
					...l.queue.map((q) => `queued · ${q.runId} ${q.check}`)
				].join('\n')}
			>
				<span class="lname">{l.name}</span>
				<span class="segs">
					{#each { length: l.permits }, i (i)}
						<i class={[i < l.held.length && 'on']}></i>
					{/each}
				</span>
				<span class="lnum">{l.held.length}/{l.permits}</span>
				{#if l.queue.length}<span class="queue">+{l.queue.length} queued</span>{/if}
			</div>
		{/each}
	</div>

	<div class="spend" title="14 days · {usd(total)}">
		<div class="spend-text">
			<span class="label">Today</span>
			<span class="amt">{usd(today)}</span>
			<span class={['delta', today < yesterday && 'down']}>
				{today >= yesterday ? '▲' : '▼'}
				{Math.abs(((today - yesterday) / (yesterday || 1)) * 100).toFixed(0)}%
			</span>
		</div>
		<svg class="spark" viewBox="0 0 84 26" width="84" height="26" aria-label="Daily spend, last 14 days">
			{#each dailyCost as v, i (i)}
				{@const h = v === 0 ? 1.5 : Math.max(3, (v / max) * 24)}
				<rect
					x={i * 6}
					y={26 - h}
					width="4"
					height={h}
					rx="1"
					class={[i === dailyCost.length - 1 && 'now', v === 0 && 'zero']}
				><title>{day(i)} · {usd(v)}</title></rect>
			{/each}
		</svg>
	</div>

	<div class="spacer"></div>

	<div class="chips" role="group" aria-label="Filter by project">
		<button
			type="button"
			class={['chip', board.filter.length === 0 && 'on']}
			onclick={() => (board.filter = [])}>All</button
		>
		{#each projects as p (p.key)}
			<button
				type="button"
				class={['chip', board.filter.includes(p.key) && 'on']}
				style:--pc={PROJECT_COLOR[p.name]}
				onclick={() => board.toggleProject(p.key)}
			>
				<i></i>{p.name}
				{#if active[p.key]}<span class="n">{active[p.key]}</span>{/if}
			</button>
		{/each}
	</div>

	<button type="button" class="new" onclick={onnew}>
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
			><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg
		>
		New run
		<kbd>N</kbd>
	</button>
</header>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: 14px;
		height: 60px;
		padding: 0 20px;
		background: rgba(255, 255, 255, 0.82);
		backdrop-filter: saturate(1.6) blur(10px);
		border-bottom: 1px solid var(--line);
		position: sticky;
		top: 0;
		z-index: 20;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 650;
		font-size: 15px;
	}
	.mark {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 8px;
		color: white;
		background: linear-gradient(140deg, #7a6bff, var(--accent) 60%, #3d2fd9);
		box-shadow: 0 2px 6px -1px color-mix(in srgb, var(--accent) 60%, transparent);
	}
	.slash {
		color: var(--line-2);
		font-weight: 400;
	}
	.view {
		color: var(--ink-2);
		font-weight: 500;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		padding: 5px 10px;
		border-radius: 999px;
		background: #effaf4;
		color: #0d6b47;
		border: 1px solid #cdeedd;
	}
	.pill b {
		font-weight: 650;
	}
	.muted {
		color: #3f8a6b;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--ok);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
	}
	.clef {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		background: #fff;
		color: #8f3bb8;
		border-radius: 4px;
		padding: 1px 5px;
	}
	.locks {
		display: flex;
		gap: 8px;
	}
	.lock {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		padding: 5px 9px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--card);
	}
	.lname {
		font-family: var(--mono);
		font-weight: 600;
		color: var(--ink-2);
	}
	.segs {
		display: inline-flex;
		gap: 2px;
	}
	.segs i {
		width: 9px;
		height: 12px;
		border-radius: 2.5px;
		background: var(--line-2);
	}
	.segs i.on {
		background: var(--accent);
	}
	.full .segs i.on {
		background: var(--warn);
	}
	.lnum {
		font-variant-numeric: tabular-nums;
		color: var(--ink-2);
	}
	.queue {
		font-size: 11px;
		font-weight: 600;
		color: #8a5300;
		background: #fff4dc;
		padding: 1px 6px;
		border-radius: 999px;
	}
	.spend {
		display: flex;
		align-items: center;
		gap: 10px;
		padding-left: 14px;
		border-left: 1px solid var(--line);
	}
	.spend-text {
		display: grid;
		grid-template-columns: auto auto;
		column-gap: 6px;
		align-items: baseline;
		line-height: 1.15;
	}
	.label {
		grid-column: 1 / -1;
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-3);
		font-weight: 600;
	}
	.amt {
		font-size: 15px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	.delta {
		font-size: 10.5px;
		color: var(--danger);
		font-weight: 600;
	}
	.delta.down {
		color: var(--ok);
	}
	.spark rect {
		fill: color-mix(in srgb, var(--accent) 28%, white);
	}
	.spark rect.zero {
		fill: var(--line-2);
	}
	.spark rect.now {
		fill: var(--accent);
	}
	.spacer {
		flex: 1;
	}
	.chips {
		display: flex;
		gap: 4px;
		padding: 3px;
		background: var(--canvas);
		border-radius: 10px;
	}
	.chip {
		all: unset;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--ink-2);
		padding: 5px 10px;
		border-radius: 7px;
		cursor: pointer;
		transition:
			background 140ms,
			color 140ms;
	}
	.chip:hover {
		color: var(--ink);
	}
	.chip.on {
		background: var(--card);
		color: var(--ink);
		box-shadow: var(--shadow-sm);
	}
	.chip i {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--pc);
	}
	.chip .n {
		font-size: 10.5px;
		font-weight: 650;
		color: color-mix(in srgb, var(--pc) 80%, black);
		background: color-mix(in srgb, var(--pc) 13%, white);
		padding: 0 5px;
		border-radius: 999px;
	}
	.chip:focus-visible,
	.new:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.new {
		all: unset;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		font-weight: 600;
		color: white;
		background: var(--accent);
		padding: 8px 12px 8px 11px;
		border-radius: 9px;
		cursor: pointer;
		box-shadow:
			0 1px 0 rgba(255, 255, 255, 0.25) inset,
			0 2px 8px -2px color-mix(in srgb, var(--accent) 70%, transparent);
		transition: transform 120ms, background 120ms;
	}
	.new:hover {
		background: #4b3bf0;
	}
	.new:active {
		transform: translateY(1px);
	}
	kbd {
		font: 600 10px var(--mono);
		background: rgba(255, 255, 255, 0.2);
		border-radius: 4px;
		padding: 1px 5px;
	}
</style>
