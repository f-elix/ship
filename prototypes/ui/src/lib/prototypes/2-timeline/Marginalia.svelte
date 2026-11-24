<script lang="ts">
	import { NOW, duration, elapsed, shortSha, usd } from '#lib';
	import type { Run } from '#lib';
	import { derivePhases, runNow, shortModel, type Phase } from './phases.ts';

	let { run }: { run: Run } = $props();

	let live = $derived(run.status === 'running' || run.status === 'waiting');
	let end = $derived(live ? runNow(run, NOW) : run.updatedAt);
	let phases = $derived(derivePhases(run, end).filter((i): i is Phase => i.type === 'phase'));

	let costs = $derived.by(() => {
		const by = new Map<string, { cost: number; model: string }>();
		for (const e of run.events) {
			if (e._tag !== 'AgentCost') continue;
			const cur = by.get(e.step) ?? { cost: 0, model: e.model };
			cur.cost += e.costUsd;
			by.set(e.step, cur);
		}
		return [...by.entries()].sort((a, b) => b[1].cost - a[1].cost);
	});

	let commits = $derived(
		run.events.flatMap((e) => (e._tag === 'CommitCreated' ? [{ sha: e.sha, message: e.message }] : []))
	);

	let baseSha = $derived.by(() => {
		const e = run.events[0];
		return e?._tag === 'RunCreated' || e?._tag === 'ReviewRunCreated' ? e.baseSha : null;
	});

	/** GitHub-style five-square diff bar. */
	let squares = $derived.by(() => {
		const { additions: a, deletions: d } = run.diffStat;
		const total = a + d;
		if (!total) return [] as string[];
		const adds = Math.round((a / total) * 5);
		return Array.from({ length: 5 }, (_, i) => (i < adds ? 'add' : 'del'));
	});

	const waitMs = (r: Run) =>
		r.events.reduce((t, e) => (e._tag === 'LockAcquired' ? t + e.waitedMs : t), 0);
</script>

<aside class="margin">
	<dl>
		<div>
			<dt>Elapsed</dt>
			<dd class="big">{elapsed(run.createdAt, end)}{#if live}<span class="live-dot" aria-label="live"></span>{/if}</dd>
			{#if waitMs(run)}<dd class="sub">{duration(waitMs(run))} of it waiting on locks</dd>{/if}
		</div>

		<div>
			<dt>Cost</dt>
			<dd class="big">{usd(run.costUsd)}</dd>
			{#each costs as [step, c] (step)}
				<dd class="row"><span>{step} <em>{shortModel(c.model)}</em></span><span>{usd(c.cost)}</span></dd>
			{/each}
		</div>

		{#if phases.length}
			<div>
				<dt>Contents</dt>
				<dd>
					<ol class="toc">
						{#each phases as p (p.id)}
							<li class={p.status}><a href="#{p.id}">{p.title}</a></li>
						{/each}
					</ol>
				</dd>
			</div>
		{/if}

		<div>
			<dt>Commits</dt>
			{#each commits as c (c.sha)}
				<dd class="commit"><code>{shortSha(c.sha)}</code> {c.message}</dd>
			{:else}
				<dd class="none">None yet</dd>
			{/each}
		</div>

		<div>
			<dt>Diff</dt>
			{#if run.diffStat.files}
				<dd class="diff">
					<span class="add">+{run.diffStat.additions}</span>
					<span class="del">−{run.diffStat.deletions}</span>
					<span class="squares" aria-hidden="true">
						{#each squares as s, i (i)}<span class={s}></span>{/each}
					</span>
				</dd>
				<dd class="sub">{run.diffStat.files} files changed</dd>
			{:else}
				<dd class="none">No changes</dd>
			{/if}
		</div>

		<div>
			<dt>Pull request</dt>
			{#if run.prUrl}
				<dd><a href={run.prUrl} target="_blank" rel="noreferrer">#{run.prNumber} ↗</a></dd>
				<dd class="sub url">{run.prUrl.replace('https://', '')}</dd>
			{:else}
				<dd class="none">{live ? 'Opens when the review is clean' : 'None'}</dd>
			{/if}
		</div>

		<div>
			<dt>Reference</dt>
			<dd class="ref"><span>run</span><code>{run.runId}</code></dd>
			{#if run.branch}<dd class="ref"><span>branch</span><code>{run.branch}</code></dd>{/if}
			{#if baseSha}<dd class="ref"><span>base</span><code>{shortSha(baseSha)}</code></dd>{/if}
			<dd class="ref"><span>cwd</span><code>{run.cwd}</code></dd>
		</div>
	</dl>
</aside>

<style>
	.margin {
		display: none;
		position: sticky;
		top: 0;
		align-self: start;
		max-height: 100vh;
		overflow-y: auto;
		padding: 64px 28px 40px 0;
	}

	@media (min-width: 1440px) {
		.margin {
			display: block;
		}
	}

	dl {
		margin: 0;
		display: grid;
		gap: 26px;
	}

	dt {
		margin-bottom: 4px;
		font: 600 10.5px var(--sans);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--faint);
	}

	dd {
		margin: 0;
		font-size: 13px;
		color: var(--ink-2);
	}

	.big {
		display: flex;
		align-items: center;
		gap: 8px;
		font: 400 26px/1.15 var(--serif);
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}

	.live-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--blue);
		animation: beacon 1.8s ease-in-out infinite;
	}

	@keyframes beacon {
		50% {
			opacity: 0.25;
		}
	}

	.sub {
		margin-top: 2px;
		font-size: 12px;
		color: var(--muted);
	}

	.url {
		font-family: var(--mono);
		font-size: 11px;
		word-break: break-all;
	}

	.row {
		display: flex;
		justify-content: space-between;
		padding: 2px 0;
		font: 12px var(--mono);
		color: var(--muted);
		border-bottom: 1px dotted var(--rule);
	}

	.row em {
		font-style: normal;
		color: var(--faint);
	}

	.toc {
		margin: 0;
		padding: 0 0 0 10px;
		list-style: none;
		border-left: 1px solid var(--rule);
	}

	.toc li {
		position: relative;
		padding: 1px 0;
	}

	.toc li::before {
		content: '';
		position: absolute;
		left: -13px;
		top: 9px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--rule-strong);
	}

	.toc .current::before {
		background: var(--blue);
	}
	.toc .failed::before {
		background: var(--red);
	}
	.toc .escalated::before,
	.toc .waiting::before,
	.toc .interrupted::before {
		background: var(--amber);
	}

	.toc a {
		font: 14px/1.5 var(--serif);
		color: var(--ink-2);
		text-decoration: none;
	}

	.toc a:hover {
		color: var(--ink);
		text-decoration: underline;
		text-decoration-color: var(--rule-strong);
	}

	.commit {
		padding: 2px 0;
		line-height: 1.4;
	}

	.commit code {
		color: var(--blue);
		font-size: 11.5px;
	}

	.none {
		font: italic 14px var(--serif);
		color: var(--faint);
	}

	.diff {
		display: flex;
		align-items: center;
		gap: 8px;
		font: 500 13px var(--mono);
	}

	.add {
		color: var(--green);
	}

	.del {
		color: var(--red);
	}

	.squares {
		display: inline-flex;
		gap: 2px;
	}

	.squares span {
		width: 8px;
		height: 8px;
		border-radius: 1px;
	}

	.squares .add {
		background: var(--green);
	}

	.squares .del {
		background: var(--red);
		opacity: 0.75;
	}

	a {
		color: var(--blue);
	}

	.ref {
		display: grid;
		grid-template-columns: 48px 1fr;
		padding: 1px 0;
		font-size: 12px;
	}

	.ref span {
		color: var(--faint);
	}

	.ref code {
		font-size: 11.5px;
		color: var(--ink-2);
		word-break: break-all;
	}
</style>
