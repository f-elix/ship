<script lang="ts">
	import { activeRuns, daemon, projects, relTime } from '#lib';
	import { projectName } from './data.ts';
	import Pill from './Pill.svelte';
	import type { Inbox } from './state.svelte.ts';

	/** The sidebar's list as a tab strip: open work as tabs, closed work behind a menu at the end. */
	let { inbox }: { inbox: Inbox } = $props();

	const active = $derived(inbox.visible.filter((d) => d.stage !== 'closed'));
	const closed = $derived(inbox.visible.filter((d) => d.stage === 'closed'));
	let menu = $state(false);
	let strip = $state<HTMLElement>();

	$effect(() => {
		void inbox.selectedId;
		strip?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});
</script>

<svelte:window onclick={() => (menu = false)} />

<header class="top">
	<div class="bar">
		<span class="brand">ship</span>
		<select value={inbox.project ?? ''} onchange={(e) => (inbox.project = e.currentTarget.value || null)} aria-label="Project">
			<option value="">All projects</option>
			{#each projects as p (p.key)}<option value={p.key}>{p.name}</option>{/each}
		</select>
		<span class="daemon">daemon {daemon.version} · {activeRuns().length} running</span>
		<a href="/">← prototypes</a>
	</div>

	<div class="strip">
		<div class="tabs" role="tablist" bind:this={strip}>
			{#each active as d (d.id)}
				<button
					role="tab"
					aria-selected={d.id === inbox.selectedId}
					class={['tab', d.unread && 'unread']}
					title={d.title}
					onclick={() => inbox.select(d.id)}
				>
					<span class="title">{d.title}</span>
					<span class="sub">
						<Pill {d} />
						{#if !inbox.project}<span class="proj">{projectName(d.projectKey)}</span>{/if}
						<span class="time">{relTime(d.updatedAt)}</span>
					</span>
				</button>
			{/each}
		</div>

		{#if closed.length}
			<div class="closed">
				<button
					class={['more', closed.some((d) => d.id === inbox.selectedId) && 'on']}
					aria-expanded={menu}
					onclick={(e) => {
						e.stopPropagation();
						menu = !menu;
					}}>Closed <span>{closed.length}</span></button
				>
				{#if menu}
					<ul class="menu">
						{#each closed as d (d.id)}
							<li>
								<button class:sel={d.id === inbox.selectedId} onclick={() => inbox.select(d.id)}>
									<span class="title">{d.title}</span>
									<span class="time">{relTime(d.updatedAt)}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</div>
</header>

<style>
	.top {
		background: var(--sunk);
		border-bottom: 1px solid var(--line);
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 12px 24px 6px;
		font-size: 12px;
		color: var(--dim);
	}
	.brand {
		font-weight: 650;
		font-size: 15px;
		letter-spacing: -0.01em;
		color: var(--text);
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
	.daemon {
		margin-left: auto;
	}
	.bar a {
		color: var(--dim);
		text-decoration: none;
	}
	.bar a:hover {
		color: var(--text);
	}
	.strip {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 0 16px;
		margin-bottom: -1px;
	}
	.tabs {
		flex: 1;
		min-width: 0;
		display: flex;
		gap: 2px;
		padding-top: 6px;
		overflow-x: auto;
		scrollbar-width: none;
		mask-image: linear-gradient(90deg, transparent, #000 24px, #000 calc(100% - 24px), transparent);
	}
	.tab {
		flex: none;
		display: grid;
		gap: 6px;
		width: 220px;
		padding: 10px 14px 11px;
		text-align: left;
		color: inherit;
		background: none;
		border: 1px solid transparent;
		border-bottom: 0;
		border-radius: 9px 9px 0 0;
		cursor: pointer;
	}
	.tab:hover {
		background: var(--hover);
	}
	.tab[aria-selected='true'] {
		background: var(--bg);
		border-color: var(--line);
	}
	.title {
		font-size: 13.5px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.unread .title,
	[aria-selected='true'] .title {
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
	.closed {
		position: relative;
		flex: none;
		align-self: center;
	}
	.more {
		padding: 6px 10px;
		font: 500 12.5px var(--sans);
		color: var(--dim);
		background: none;
		border: 1px solid var(--line-soft);
		border-radius: 7px;
		cursor: pointer;
	}
	.more:hover,
	.more.on {
		color: var(--text);
	}
	.more span {
		margin-left: 4px;
		font-weight: 400;
	}
	.menu {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 10;
		width: 300px;
		margin: 0;
		padding: 6px;
		list-style: none;
		background: var(--raised);
		border: 1px solid var(--line-strong);
		border-radius: 10px;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.5);
	}
	.menu button {
		display: flex;
		gap: 12px;
		width: 100%;
		padding: 8px 10px;
		font: 13px var(--sans);
		text-align: left;
		color: var(--muted);
		background: none;
		border: 0;
		border-radius: 6px;
		cursor: pointer;
	}
	.menu button:hover,
	.menu button.sel {
		color: var(--text);
		background: var(--hover);
	}
	.menu .title {
		flex: 1;
		font-size: 13px;
		color: inherit;
	}
</style>
