<script lang="ts">
	import { activeRuns, daemon, projects, relTime } from '#lib';
	import { projectName, type Deliverable } from './data.ts';
	import Pill from './Pill.svelte';
	import type { Inbox } from './state.svelte.ts';

	let { inbox }: { inbox: Inbox } = $props();

	const active = $derived(inbox.visible.filter((d) => d.stage !== 'closed'));
	const closed = $derived(inbox.visible.filter((d) => d.stage === 'closed'));
	let showClosed = $state(true);
</script>

{#snippet item(d: Deliverable)}
	<li>
		<button class={['item', d.id === inbox.selectedId && 'sel', d.unread && 'unread']} onclick={() => inbox.select(d.id)}>
			<span class="title">{d.title}</span>
			<span class="sub">
				<Pill {d} />
				{#if !inbox.project}<span class="proj">{projectName(d.projectKey)}</span>{/if}
				<span class="time">{relTime(d.updatedAt)}</span>
			</span>
		</button>
	</li>
{/snippet}

<aside class="list">
	<header>
		<span class="brand">ship</span>
		<select
			value={inbox.project ?? ''}
			onchange={(e) => (inbox.project = e.currentTarget.value || null)}
			aria-label="Project"
		>
			<option value="">All projects</option>
			{#each projects as p (p.key)}<option value={p.key}>{p.name}</option>{/each}
		</select>
	</header>

	<div class="scroll">
		<ul>
			{#each active as d (d.id)}{@render item(d)}{/each}
		</ul>
	</div>

	{#if closed.length}
		<section class="closed">
			<button class="ghead" onclick={() => (showClosed = !showClosed)} aria-expanded={showClosed}>
				Closed <span class="n">{closed.length}</span><span class={['chev', showClosed && 'open']}>›</span>
			</button>
			{#if showClosed}
				<ul>
					{#each closed as d (d.id)}
						<li>
							<button class={['settled', d.id === inbox.selectedId && 'sel']} onclick={() => inbox.select(d.id)}>
								<span class="title">{d.title}</span>
								<span class="time">{relTime(d.updatedAt)}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	<footer>daemon {daemon.version} · {activeRuns().length} running <a href="/">← prototypes</a></footer>
</aside>

<style>
	.list {
		display: grid;
		grid-template-rows: auto 1fr auto auto;
		min-height: 0;
		background: var(--sunk);
		border-right: 1px solid var(--line-soft);
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
			url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%235d6670' stroke-width='1.5'/%3E%3C/svg%3E")
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
	}
	.title {
		font-size: 14px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.unread .title,
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
		gap: 6px;
		padding: 12px 24px;
		font-size: 11.5px;
		color: var(--dim);
	}
	footer a {
		margin-left: auto;
		color: var(--dim);
		text-decoration: none;
	}
	footer a:hover {
		color: var(--text);
	}
</style>
