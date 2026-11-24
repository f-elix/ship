<script lang="ts">
	import { page } from '$app/state';
	import { daemon, projectByKey, relTime, NOW } from '#lib';
	import type { Run } from '#lib';
	import { getTimeline } from './state.svelte.ts';
	import { statusWord, tone } from './words.ts';

	const tl = getTimeline();

	const byRecent = (a: Run, b: Run) => b.updatedAt.localeCompare(a.updatedAt);

	let groups = $derived([
		{ label: 'Active', runs: tl.all.filter((r) => r.status === 'running' || r.status === 'waiting').sort(byRecent) },
		{
			label: 'Needs you',
			runs: tl.all
				.filter((r) => r.status === 'escalated' || r.status === 'failed' || r.status === 'interrupted')
				.sort(byRecent)
		},
		{ label: 'Recent', runs: tl.all.filter((r) => r.status === 'done' || r.status === 'cancelled').sort(byRecent) }
	]);

	const uptime = Math.round((NOW.getTime() - new Date(daemon.startedAt).getTime()) / 3_600_000);
</script>

<nav aria-label="Runs">
	<header>
		<a class="mark" href="/2-timeline">ship</a>
		<p class="daemon">
			<span class="dot" aria-hidden="true"></span>
			daemon {daemon.version} · up {uptime}h
		</p>
	</header>

	{#each groups as group (group.label)}
		<section>
			<h2>
				{group.label}
				{#if group.runs.length}<span class="n">{group.runs.length}</span>{/if}
			</h2>
			{#if group.runs.length === 0}
				<p class="empty">Nothing here.</p>
			{:else}
				<ul>
					{#each group.runs as run (run.runId)}
						{@const current = page.params.runId === run.runId}
						<li>
							<a href="/2-timeline/{run.runId}" aria-current={current ? 'page' : undefined} class={{ current }}>
								<span class="title">{run.title}</span>
								<span class="meta">
									<span>{projectByKey(run.projectKey)?.name}</span>
									<span class="sep">·</span>
									<span class="status {tone(run.status)}">{statusWord(run)}</span>
									<span class="time">{relTime(run.updatedAt)}</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}

	<footer>
		<a href="/">← prototypes</a>
	</footer>
</nav>

<style>
	nav {
		position: sticky;
		top: 0;
		height: 100vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		padding: 28px 18px 20px 24px;
		border-right: 1px solid var(--rule);
		background: var(--paper-sunk);
	}

	header {
		padding: 0 8px 22px;
	}

	.mark {
		font: italic 500 28px/1 var(--serif);
		letter-spacing: -0.01em;
		color: var(--ink);
		text-decoration: none;
	}

	.daemon {
		margin: 8px 0 0;
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		color: var(--muted);
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--green);
	}

	section {
		margin-top: 18px;
	}

	h2 {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin: 0 0 6px;
		padding: 0 8px;
		font: 600 11px/1 var(--sans);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--muted);
	}

	.n {
		font-weight: 500;
		color: var(--faint);
	}

	.empty {
		margin: 0;
		padding: 4px 8px;
		font: italic 14px var(--serif);
		color: var(--faint);
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li a {
		display: grid;
		gap: 2px;
		padding: 8px 8px 9px;
		border-radius: 6px;
		color: inherit;
		text-decoration: none;
		transition: background 120ms;
	}

	li a:hover {
		background: color-mix(in srgb, var(--paper) 70%, transparent);
	}

	li a.current {
		background: var(--paper-raised);
		box-shadow:
			0 0 0 1px var(--rule),
			0 1px 2px rgb(60 50 30 / 0.05);
	}

	.title {
		font: 500 15.5px/1.3 var(--serif);
		color: var(--ink);
	}

	.meta {
		display: flex;
		gap: 5px;
		font-size: 12px;
		color: var(--muted);
	}

	.sep {
		color: var(--faint);
	}

	.time {
		margin-left: auto;
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}

	.status.green {
		color: var(--green);
	}
	.status.red {
		color: var(--red);
	}
	.status.amber {
		color: var(--amber);
	}
	.status.blue {
		color: var(--blue);
	}

	footer {
		margin-top: auto;
		padding: 28px 8px 0;
	}

	footer a {
		font-size: 12px;
		color: var(--muted);
		text-decoration: none;
	}

	footer a:hover {
		color: var(--ink);
	}
</style>
