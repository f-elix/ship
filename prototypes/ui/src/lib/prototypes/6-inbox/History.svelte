<script lang="ts">
	import { clock, commandFor, describe, elapsed, runById, usd, type Run } from '#lib';

	/** How the deliverable was made: its runs, last. `live` replaces the shared copy of a run. */
	let { runIds, live }: { runIds: string[]; live?: Run } = $props();

	const list = $derived(runIds.map((id) => (live?.runId === id ? live : runById(id))).filter((r): r is Run => !!r));
	const total = $derived(list.reduce((t, r) => t + r.costUsd, 0));
	let open = $state<string | null>(null);
</script>

{#if list.length}
	<details class="history">
		<summary>
			<span>How it was made</span>
			<span class="sum">{list.length} run{list.length === 1 ? '' : 's'} · {usd(total)}</span>
		</summary>
		<ul class="runs">
			{#each list as r (r.runId)}
				<li>
					<button class="run" onclick={() => (open = open === r.runId ? null : r.runId)} aria-expanded={open === r.runId}>
						<code class="cmd">{commandFor(r)}</code>
						<span class="id">{r.runId}</span>
						<span class={['st', `st-${r.status}`]}>{r.status}</span>
						<span>{r.round ? `${r.round} round${r.round === 1 ? '' : 's'}` : ''}</span>
						<span>{elapsed(r.createdAt, r.updatedAt)}</span>
						<span class="cost">{usd(r.costUsd)}</span>
					</button>
					{#if open === r.runId}
						<ol class="log">
							{#each r.events as e (e.seq)}
								<li class={e._tag}><time>{clock(e.at)}</time>{describe(e)}</li>
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
		grid-template-columns: 1fr 64px 84px 70px 70px 54px;
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
	.run:hover {
		border-color: var(--line-strong);
	}
	.cmd {
		font: 12px var(--mono);
		color: var(--text);
	}
	.id {
		font: 11px var(--mono);
		color: var(--dim);
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
		overflow-y: auto;
		background: var(--code);
		border-radius: 7px;
		font: 11.5px/1.7 var(--mono);
		color: var(--muted);
	}
	.log li {
		padding: 0 14px;
		white-space: nowrap;
	}
	time {
		display: inline-block;
		width: 70px;
		color: var(--dim);
	}
	.log .StateChanged {
		color: var(--accent);
	}
	.log .Escalated,
	.log .RunInterrupted {
		color: var(--tr);
	}
	.log .PrOpened,
	.log .CommitCreated {
		color: var(--ok);
	}
</style>
