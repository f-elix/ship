<script lang="ts">
	import { elapsed } from '#lib/format.ts';
	import { plural, usd } from '@ship/core/event-lines';
	import type { HistoryRun } from '#lib/server/detail.ts';

	/** How the deliverable was made: its runs, newest first, each with its event log. */
	let { runs }: { runs: ReadonlyArray<HistoryRun> } = $props();

	const total = $derived(runs.reduce((sum, run) => sum + run.costUsd, 0));
	let open = $state<string | null>(null);
</script>

{#if runs.length}
	<details class="history">
		<summary>
			<span>How it was made</span>
			<span class="sum">{plural(runs.length, 'run')} · {usd(total)}</span>
		</summary>
		<ul class="runs">
			{#each runs as r (r.runId)}
				<li>
					<button
						class="run"
						onclick={() => (open = open === r.runId ? null : r.runId)}
						aria-expanded={open === r.runId}
					>
						<code class="cmd">{r.command}</code>
						<span class="id">{r.runId}</span>
						<span class={['st', `st-${r.status}`]}>{r.status}</span>
						<span>{r.round ? plural(r.round, 'round') : ''}</span>
						<span>{elapsed(r.createdAt, r.updatedAt)}</span>
						<span class="cost">{usd(r.costUsd)}</span>
					</button>
					{#if open === r.runId}
						<ol class="log">
							{#each r.lines as line, i (i)}
								<li>{line}</li>
							{/each}
						</ol>
					{/if}
				</li>
			{/each}
		</ul>
	</details>
{/if}

<style>
	.runs {
		list-style: none;
		margin: 0;
		padding: 0 0 18px;
		display: grid;
		gap: 4px;
	}
	.run {
		display: grid;
		grid-template-columns: 1fr 120px 84px 70px 70px 54px;
		gap: 12px;
		align-items: center;
		width: 100%;
		padding: 8px 12px;
		font: 12px var(--sans);
		color: var(--muted);
		text-align: left;
		background: none;
		border: 1px solid var(--line-soft);
		border-radius: 7px;
		cursor: pointer;
	}
	/* Too narrow for the columns: the command and id take a line each, the rest share one. */
	@media (max-width: 720px) {
		.run {
			display: flex;
			flex-wrap: wrap;
			gap: 4px 12px;
		}
		.cmd,
		.id {
			flex-basis: 100%;
		}
		.cost {
			margin-left: auto;
		}
	}
	.run:hover {
		border-color: var(--line-strong);
	}
	.cmd {
		font: 12px var(--mono);
		color: var(--text);
	}
	.id {
		overflow: hidden;
		font: 11px var(--mono);
		color: var(--dim);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.st-done {
		color: var(--ok);
	}
	.st-escalated {
		color: var(--tr);
	}
	.st-failed,
	.st-interrupted {
		color: var(--err);
	}
	.st-running,
	.st-waiting {
		color: var(--accent);
	}
	.cost {
		text-align: right;
		font-family: var(--mono);
	}
	.log {
		list-style: none;
		margin: 4px 0 8px;
		padding: 10px 0;
		max-height: 320px;
		overflow: auto;
		background: var(--code);
		border-radius: 7px;
		font: 11.5px/1.7 var(--mono);
		color: var(--muted);
	}
	.log li {
		padding: 0 14px;
		white-space: nowrap;
	}
</style>
