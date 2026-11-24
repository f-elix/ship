<script lang="ts">
	import { duration, locks } from '#lib';
	import type { Run } from '#lib';

	let { run }: { run: Run } = $props();

	const baseline = $derived(run.checks.find((c) => c.baseline));
	const round1 = $derived(run.checks.find((c) => !c.baseline && c.round === 1));
	const failing = $derived(baseline?.results.filter((r) => r.exitCode !== 0) ?? []);
	const db = locks.find((l) => l.name === 'db');
	const pos = $derived((db?.queue.findIndex((q) => q.runId === run.runId) ?? -1) + 1);
</script>

<section class="baseline">
	<p class="lede">
		Before implementing, ship ran every check on <code>main</code>. <b>{failing.map((f) => f.name).join(', ')}</b> already failed there. That
		is not this change's fault, so ship doesn't try to fix it: the run carries on, and the PR body lists it under
		<em>Checks failing before the change</em>.
	</p>

	<table>
		<thead>
			<tr><th>check</th><th>baseline</th><th>round 1</th><th>time</th></tr>
		</thead>
		<tbody>
			{#each baseline?.results ?? [] as r (r.name)}
				{@const after = round1?.results.find((x) => x.name === r.name)}
				<tr>
					<td><code>{r.name}</code></td>
					<td><span class={['pill', r.exitCode ? 'bad' : 'ok']}>{r.exitCode ? `exit ${r.exitCode}` : 'pass'}</span></td>
					<td>
						{#if after}
							<span class={['pill', after.exitCode ? 'bad' : 'ok']}>{after.exitCode ? `exit ${after.exitCode}` : 'pass'}</span>
						{:else if r.name === 'test'}
							<span class="pill wait">queued · db</span>
						{:else}
							<span class="dash">—</span>
						{/if}
					</td>
					<td class="time">{duration(r.durationMs)}</td>
				</tr>
			{/each}
		</tbody>
	</table>

	{#each failing as f (f.name)}
		<figure>
			<figcaption>baseline {f.name} · output tail</figcaption>
			<pre>{f.outputTail}</pre>
		</figure>
	{/each}

	<div class="now">
		<span class="live"></span>
		<div>
			<b>{run.runId}</b> is in <code>{run.state}</code> — <code>test</code> is #{pos || '?'} for the <code>db</code> lock, held by
			<code>{db?.held[0]?.check}</code>. Round 1 lint still fails with the same error; before a check fix, Clef rates whether the change caused
			it.
		</div>
	</div>
</section>

<style>
	.baseline {
		display: grid;
		gap: 20px;
	}
	.lede {
		margin: 0;
		font-size: 14.5px;
		line-height: 1.6;
		color: var(--ink-2);
		max-width: 70ch;
	}
	code {
		font: 12.5px var(--mono);
		color: var(--ink);
	}
	table {
		border-collapse: collapse;
		width: 100%;
		max-width: 560px;
		font-size: 13px;
	}
	th {
		text-align: left;
		font-weight: 500;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--faint);
		padding: 0 12px 8px 0;
		border-bottom: 1px solid var(--line);
	}
	td {
		padding: 9px 12px 9px 0;
		border-bottom: 1px solid var(--line);
	}
	.time {
		font: 12px var(--mono);
		color: var(--muted);
	}
	.pill {
		font: 600 11px var(--mono);
		padding: 2px 8px;
		border-radius: 4px;
	}
	.ok {
		color: #23744a;
		background: #eaf5ee;
	}
	.bad {
		color: var(--mf);
		background: var(--mf-wash);
	}
	.wait {
		color: var(--tr);
		background: var(--tr-wash);
	}
	.dash {
		color: var(--faint);
	}
	figure {
		margin: 0;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--code-bg);
		overflow: hidden;
	}
	figcaption {
		padding: 6px 12px;
		font: 11.5px var(--mono);
		color: var(--muted);
		border-bottom: 1px solid var(--line);
		background: var(--panel);
	}
	pre {
		margin: 0;
		padding: 12px 14px;
		font: 12px/1.6 var(--mono);
		color: var(--ink-2);
		white-space: pre-wrap;
	}
	.now {
		display: grid;
		grid-template-columns: 14px 1fr;
		gap: 10px;
		align-items: baseline;
		font-size: 13px;
		line-height: 1.55;
		color: var(--ink-2);
	}
	.live {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--tr);
		box-shadow: 0 0 0 3px var(--tr-wash);
	}
</style>
