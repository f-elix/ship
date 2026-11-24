<script lang="ts">
	import { daemon, elapsed, NOW, projects, relTime, type Run } from '#lib';
	import StatusDot from './StatusDot.svelte';

	interface Props {
		groups: { name: string; path: string; runs: Run[] }[];
		selectedId: string;
		filter: string;
		filterEl?: HTMLInputElement;
		onselect: (id: string) => void;
	}

	let { groups, selectedId, filter = $bindable(), filterEl = $bindable(), onselect }: Props = $props();

	const total = $derived(groups.reduce((n, g) => n + g.runs.length, 0));
	const clefProjects = projects.filter((p) => p.clef).length;
</script>

<aside>
	<div class="search">
		<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
		<input
			bind:this={filterEl}
			bind:value={filter}
			placeholder="filter runs, branches, states"
			spellcheck="false"
			aria-label="Filter runs"
			onkeydown={(e) => {
				if (e.key === 'Escape') {
					filter = '';
					e.currentTarget.blur();
				}
			}}
		/>
		<kbd>/</kbd>
	</div>

	<nav aria-label="Runs">
		{#each groups as g (g.name)}
			<section>
				<header>
					<span class="proj">{g.name}</span>
					<span class="path">{g.path}</span>
					<span class="n">{g.runs.length}</span>
				</header>
				<ul>
					{#each g.runs as r (r.runId)}
						<li>
							<button
								class={['run', r.runId === selectedId && 'sel']}
								onclick={() => onselect(r.runId)}
								aria-current={r.runId === selectedId ? 'true' : undefined}
							>
								<StatusDot status={r.status} />
								<span class="title">{r.title}</span>
								<span class="time">{relTime(r.updatedAt)}</span>
								<span class="meta">
									<span class="id">{r.runId}</span>
									<span class={['kind', `k-${r.kind}`]}>{r.kind}</span>
									<span class="state">{r.state}</span>
								</span>
							</button>
						</li>
					{/each}
				</ul>
			</section>
		{:else}
			<p class="empty">No runs match <code>{filter}</code></p>
		{/each}
	</nav>

	<footer>
		<div class="drow">
			<span class="live"></span>
			<span>shipd <b>{daemon.version}</b></span>
			<span class="dim">pid {daemon.pid}</span>
		</div>
		<dl>
			<dt>uptime</dt>
			<dd>{elapsed(daemon.startedAt, NOW.toISOString())}</dd>
			<dt>clef</dt>
			<dd class={daemon.clefConfigured ? 'ok' : 'warn'}>
				{daemon.clefConfigured ? 'configured' : 'no credentials'}
				<span class="dim">· {clefProjects}/{projects.length} projects</span>
			</dd>
			<dt>socket</dt>
			<dd class="dim">{daemon.socket}</dd>
			<dt>runs</dt>
			<dd>{total} shown</dd>
		</dl>
	</footer>
</aside>

<style>
	aside {
		display: grid;
		grid-template-rows: auto 1fr auto;
		min-height: 0;
		background: var(--panel);
		border-right: 1px solid var(--line);
	}
	.search {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 10px;
		padding: 0 8px;
		height: 30px;
		border: 1px solid var(--line);
		background: var(--bg);
		border-radius: 4px;
	}
	.search:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
	}
	.search svg {
		width: 13px;
		height: 13px;
		fill: none;
		stroke: var(--dim);
		stroke-width: 1.5;
	}
	input {
		flex: 1;
		min-width: 0;
		background: none;
		border: 0;
		outline: none;
		color: var(--text);
		font: inherit;
		font-size: 12px;
	}
	input::placeholder {
		color: var(--faint);
	}
	nav {
		overflow-y: auto;
		min-height: 0;
		padding-bottom: 8px;
	}
	section + section {
		margin-top: 6px;
	}
	header {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 8px 12px 4px;
		position: sticky;
		top: 0;
		background: var(--panel);
		z-index: 1;
	}
	.proj {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text);
	}
	.path {
		flex: 1;
		font-family: var(--mono);
		font-size: 10px;
		color: var(--faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.n {
		font-family: var(--mono);
		font-size: 10px;
		color: var(--dim);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.run {
		display: grid;
		grid-template-columns: 14px 1fr auto;
		grid-template-areas: 'dot title time' '. meta meta';
		row-gap: 2px;
		align-items: center;
		width: 100%;
		padding: 6px 12px 6px 10px;
		border: 0;
		border-left: 2px solid transparent;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.run:hover {
		background: var(--hover);
	}
	.run.sel {
		background: var(--sel);
		border-left-color: var(--accent);
	}
	.run :global(.dot) {
		grid-area: dot;
	}
	.title {
		grid-area: title;
		font-size: 12.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
	}
	.sel .title {
		color: var(--bright);
	}
	.time {
		grid-area: time;
		font-family: var(--mono);
		font-size: 10px;
		color: var(--faint);
		padding-left: 8px;
		font-variant-numeric: tabular-nums;
	}
	.meta {
		grid-area: meta;
		display: flex;
		gap: 6px;
		align-items: center;
		font-family: var(--mono);
		font-size: 10px;
		min-width: 0;
	}
	.id {
		color: var(--dim);
	}
	.kind {
		padding: 0 4px;
		border-radius: 2px;
		border: 1px solid var(--line-strong);
		color: var(--dim);
		line-height: 14px;
	}
	.k-ship {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 35%, transparent);
	}
	.k-review,
	.k-recheck {
		color: var(--c-review);
		border-color: color-mix(in srgb, var(--c-review) 35%, transparent);
	}
	.k-fix {
		color: var(--c-git);
		border-color: color-mix(in srgb, var(--c-git) 35%, transparent);
	}
	.state {
		color: var(--faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty {
		padding: 16px 12px;
		color: var(--dim);
		font-size: 12px;
	}
	footer {
		border-top: 1px solid var(--line);
		padding: 10px 12px;
		font-size: 11px;
		background: var(--bg);
	}
	.drow {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}
	.drow b {
		font-family: var(--mono);
		font-weight: 500;
		color: var(--bright);
	}
	.live {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--s-done);
		box-shadow: 0 0 6px var(--s-done);
	}
	dl {
		display: grid;
		grid-template-columns: 52px 1fr;
		gap: 2px 8px;
		margin: 0;
		font-family: var(--mono);
		font-size: 10.5px;
	}
	dt {
		color: var(--faint);
	}
	dd {
		margin: 0;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dim {
		color: var(--dim);
	}
	.ok {
		color: var(--s-done);
	}
	.warn {
		color: var(--s-waiting);
	}
</style>
