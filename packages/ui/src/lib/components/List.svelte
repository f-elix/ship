<script lang="ts">
	import { relTime } from '#lib/format.ts';
	import { tick } from 'svelte';
	import type { DeliverableSummary } from '#lib/server/deliverables.ts';
	import Pill from './Pill.svelte';

	let {
		items,
		selectedId,
		project = $bindable(),
		projects,
		now,
		connected,
		onselect,
		onmove
	}: {
		/** The deliverables of the chosen project, in list order. */
		items: ReadonlyArray<DeliverableSummary>;
		selectedId: string | null;
		/** The project shown, or `null` for all. */
		project: string | null;
		projects: ReadonlyArray<string>;
		now: number;
		connected: boolean;
		onselect: (id: string) => void;
		/** Selects the item `delta` places away in list order. */
		onmove: (delta: number) => void;
	} = $props();

	const active = $derived(items.filter((d) => d.stage !== 'closed'));
	const closed = $derived(items.filter((d) => d.stage === 'closed'));
	const working = $derived(items.filter((d) => d.stage === 'working').length);
	let showClosed = $state(false);

	/**
	 * j/k and the arrow keys move the selection while the list has focus, and focus follows
	 * it, so the shortcuts never take keys from the rest of the page.
	 */
	const onkeydown = async (e: KeyboardEvent & { currentTarget: HTMLElement }) => {
		if (e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
		const delta = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[e.key];
		if (delta === undefined) return;
		e.preventDefault();
		onmove(delta);
		const list = e.currentTarget;
		await tick();
		list.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
	};
</script>

{#snippet item(d: DeliverableSummary)}
	<li>
		<button
			class={['item', d.id === selectedId && 'sel']}
			aria-current={d.id === selectedId}
			onclick={() => onselect(d.id)}
		>
			<span class="title">{d.title}</span>
			<span class="sub">
				<Pill {d} />
				{#if project === null}<span class="proj">{d.projectName}</span>{/if}
				<span class="time">{relTime(d.updatedAt, now)}</span>
			</span>
		</button>
	</li>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions: keys move between its buttons -->
<aside class="list" aria-label="Deliverables" {onkeydown}>
	<header>
		<span class="brand">ship</span>
		<select
			value={project ?? ''}
			onchange={(e) => (project = e.currentTarget.value || null)}
			aria-label="Project"
		>
			<option value="">All projects</option>
			{#each projects as name (name)}<option value={name}>{name}</option>{/each}
		</select>
	</header>

	<div class="scroll">
		<ul>
			{#each active as d (d.id)}{@render item(d)}{/each}
		</ul>
		{#if active.length === 0}<p class="empty">
				{closed.length ? 'Nothing open.' : 'Nothing from ship yet.'}
			</p>{/if}
	</div>

	{#if closed.length}
		<section class="closed">
			<button
				class="ghead"
				onclick={() => (showClosed = !showClosed)}
				aria-expanded={showClosed}
			>
				Closed <span class="n">{closed.length}</span><span
					class={['chev', showClosed && 'open']}>›</span
				>
			</button>
			{#if showClosed}
				<ul>
					{#each closed as d (d.id)}
						<li>
							<button
								class={['settled', d.id === selectedId && 'sel']}
								aria-current={d.id === selectedId}
								onclick={() => onselect(d.id)}
							>
								<span class="title">{d.title}</span>
								<span class="time">{relTime(d.updatedAt, now)}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	<footer>
		<span class={['dot', connected && 'on']}></span>
		{connected ? 'daemon connected' : 'daemon offline'} · {working} working
	</footer>
</aside>

<style>
	.list {
		display: grid;
		grid-template-rows: auto 1fr auto auto;
		min-height: 0;
		background: var(--sunk);
		border-right: 1px solid var(--line-soft);
	}
	@media (max-width: 720px) {
		.list {
			border-right: 0;
			border-bottom: 1px solid var(--line-soft);
		}
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 20px 20px 8px 24px;
	}
	.brand {
		font-weight: 650;
		font-size: 15px;
		letter-spacing: -0.01em;
	}
	select {
		padding: 3px 22px 3px 8px;
		font: 12.5px var(--sans);
		color: var(--muted);
		background: transparent
			url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%237e8792' stroke-width='1.5'/%3E%3C/svg%3E")
			no-repeat right 6px center;
		border: 0;
		border-radius: 6px;
		appearance: none;
		cursor: pointer;
	}
	select:hover {
		color: var(--text);
		background-color: var(--hover);
	}
	.scroll {
		overflow-y: auto;
		padding: 4px 10px 24px;
	}
	.empty {
		margin: 12px 14px;
		font-size: 13px;
		color: var(--dim);
	}
	.closed {
		display: grid;
		max-height: 40vh;
		overflow-y: auto;
		padding: 0 10px 8px;
		border-top: 1px solid var(--line-soft);
	}
	.ghead {
		display: flex;
		align-items: baseline;
		gap: 4px;
		width: 100%;
		padding: 16px 14px 8px;
		font: 550 12px var(--sans);
		color: var(--dim);
		text-align: left;
		background: none;
		border: 0;
		cursor: pointer;
	}
	.ghead:hover {
		color: var(--muted);
	}
	.ghead .n {
		margin-left: auto;
		font-weight: 400;
	}
	.chev {
		display: inline-block;
		width: 12px;
		text-align: center;
		transform: rotate(-90deg);
		transition: transform 0.15s;
	}
	.chev.open {
		transform: rotate(90deg);
	}
	.settled {
		display: flex;
		gap: 12px;
		width: 100%;
		padding: 7px 14px;
		font-size: 13px;
		text-align: left;
		color: var(--dim);
		background: none;
		border: 0;
		border-radius: 7px;
		cursor: pointer;
	}
	.settled:hover {
		background: var(--hover);
	}
	.settled.sel {
		background: var(--raised);
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.settled .title {
		flex: 1;
		font-size: 13px;
		color: var(--dim);
	}
	.settled.sel .title {
		color: var(--text);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}
	.item {
		display: grid;
		gap: 6px;
		width: 100%;
		padding: 10px 14px 11px;
		text-align: left;
		color: inherit;
		background: none;
		border: 0;
		border-radius: 8px;
		cursor: pointer;
	}
	.item:hover {
		background: var(--hover);
	}
	.item.sel {
		background: var(--raised);
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.title {
		font-size: 14px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sel .title {
		color: var(--text);
		font-weight: 500;
	}
	.sub {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: 12px;
		color: var(--dim);
	}
	.proj {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.time {
		flex: none;
		margin-left: auto;
	}
	footer {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 12px 24px;
		font-size: 11.5px;
		color: var(--dim);
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--err);
	}
	.dot.on {
		background: var(--ok);
	}
</style>
