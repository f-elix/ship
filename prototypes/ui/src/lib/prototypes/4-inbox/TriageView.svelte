<script lang="ts">
	import { clock, projectByKey } from '#lib';
	import type { Run, Severity } from '#lib';
	import FindingCard from './FindingCard.svelte';
	import { getInbox, type Entry } from './inbox.svelte.ts';

	let { entry, run }: { entry: Entry; run: Run } = $props();

	const inbox = getInbox();

	const findings = $derived(inbox.currentFindings(run));
	const earlier = $derived(run.findings.filter((f) => !findings.includes(f)));
	const tally = $derived(inbox.tally(run));
	const clef = $derived(run.events.filter((e) => e._tag === 'ClefDecision'));
	const project = $derived(projectByKey(run.projectKey));
	const readonly = $derived(entry.status === 'archived');

	const groups: { sev: Severity; title: string; blurb: string }[] = [
		{ sev: 'must-fix', title: 'Must-fix', blurb: 'goes to the fix agent' },
		{ sev: 'tradeoff', title: 'Tradeoffs', blurb: 'left for a human; not fixed' },
		{ sev: 'nit', title: 'Nits', blurb: 'fixed alongside must-fix' }
	];
</script>

<section class="triage">
	<div class="tally" aria-label="After your calls">
		<span class="t mf"><b>{tally['must-fix']}</b> must-fix</span>
		<span class="t tr"><b>{tally.tradeoff}</b> tradeoff</span>
		<span class="t nit"><b>{tally.nit}</b> nit</span>
		{#if tally.dismissed}<span class="t dis"><b>{tally.dismissed}</b> dismissed</span>{/if}
		<span class="sub">round {findings[0]?.round ?? run.round} · {findings.length} verified, {run.disproved.length} disproved</span>
	</div>

	{#each groups as g (g.sev)}
		{@const group = findings.filter((f) => f.severity === g.sev)}
		{#if group.length}
			<div class="group">
				<h3 class="h-{g.sev}">{g.title} <span>{group.length}</span><em>{g.blurb}</em></h3>
				{#each group as f (f.id)}
					<FindingCard
						finding={f}
						runId={run.runId}
						{readonly}
						active={inbox.mode === 'detail' && findings[inbox.findingCursor] === f}
						onfocus={() => {
							inbox.mode = 'detail';
							inbox.findingCursor = findings.indexOf(f);
						}}
					/>
				{/each}
			</div>
		{/if}
	{/each}

	{#if earlier.length}
		<details class="disclosure">
			<summary>Earlier rounds · {earlier.length} finding{earlier.length > 1 ? 's' : ''}{#if findings.some((f) => f.repeats)}&nbsp;— repeated, ship counts it as a stall{/if}</summary>
			<div class="inner">
				{#each earlier as f (f.id)}
					<FindingCard finding={f} runId={run.runId} readonly />
				{/each}
			</div>
		</details>
	{/if}

	{#if run.disproved.length}
		<details class="disclosure">
			<summary>{run.disproved.length} disproved by the verifier</summary>
			<ul class="disproved">
				{#each run.disproved as d (d.claim)}
					<li>
						<span class="who">{d.reviewer} · <code>{d.file}{d.line ? `:${d.line}` : ''}</code></span>
						<s>{d.claim}</s>
						<span class="why">{d.reason}</span>
					</li>
				{/each}
			</ul>
		</details>
	{/if}

	<details class="disclosure clef" open={clef.some((c) => c._tag === 'ClefDecision' && c.decision === 'lower must-fix' && c.probability >= 0.7)}>
		<summary>
			<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.5 9.6 6.4 14.5 8l-4.9 1.6L8 14.5 6.4 9.6 1.5 8l4.9-1.6Z" fill="currentColor" /></svg>
			Clef decisions on this run
			<span class="count">{project?.clef ? clef.length : 'off'}</span>
		</summary>
		{#if !project?.clef}
			<p class="clef-off">
				Clef is off for <b>{project?.name}</b> (<code>"clef": false</code>). Triage used the rules without it: reviewers by trigger only,
				<code>models.review</code>, no must-fix lowering, failing checks always go to the fix loop.
			</p>
		{:else if clef.length === 0}
			<p class="clef-off">No decisions recorded yet.</p>
		{:else}
			<ul class="decisions">
				{#each clef as c (c.seq)}
					{#if c._tag === 'ClefDecision'}
						{@const applied = c.decision === 'lower must-fix' ? c.probability >= 0.7 : c.probability >= 0.5}
						<li>
							<time>{clock(c.at)}</time>
							<span class="dec">{c.decision}</span>
							<span class="meter" title="threshold {c.decision === 'lower must-fix' ? '0.70' : '0.50'}">
								<span class={['fill', applied && 'applied']} style:width="{c.probability * 100}%"></span>
								<span class="mark" style:left={c.decision === 'lower must-fix' ? '70%' : '50%'}></span>
							</span>
							<code class="p">p={c.probability.toFixed(2)}</code>
							<span class="detail">{c.detail}</span>
						</li>
					{/if}
				{/each}
			</ul>
		{/if}
	</details>
</section>

<style>
	.triage {
		display: grid;
		gap: 22px;
	}
	.tally {
		display: flex;
		align-items: baseline;
		gap: 16px;
		font-size: 13px;
		color: var(--muted);
		padding-bottom: 14px;
		border-bottom: 1px solid var(--line);
	}
	.t b {
		font-size: 20px;
		font-weight: 600;
		margin-right: 3px;
		font-variant-numeric: tabular-nums;
	}
	.mf b {
		color: var(--mf);
	}
	.tr b {
		color: var(--tr);
	}
	.nit b {
		color: var(--nit);
	}
	.dis b {
		color: var(--faint);
	}
	.sub {
		margin-left: auto;
		font-size: 12px;
		color: var(--faint);
	}
	.group {
		display: grid;
		gap: 12px;
	}
	h3 {
		margin: 0;
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.07em;
	}
	h3 span {
		font-variant-numeric: tabular-nums;
		color: var(--faint);
	}
	h3 em {
		font-style: normal;
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
		color: var(--faint);
	}
	.h-must-fix {
		color: var(--mf);
	}
	.h-tradeoff {
		color: var(--tr);
	}
	.h-nit {
		color: var(--nit);
	}
	.disclosure {
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel);
	}
	summary {
		cursor: pointer;
		padding: 11px 16px;
		font-size: 13px;
		color: var(--ink-2);
		display: flex;
		align-items: center;
		gap: 8px;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary::before {
		content: '›';
		display: inline-block;
		width: 10px;
		color: var(--faint);
		transition: transform 0.15s;
	}
	details[open] > summary::before {
		transform: rotate(90deg);
	}
	.inner {
		display: grid;
		gap: 12px;
		padding: 0 16px 16px;
	}
	.disproved {
		list-style: none;
		margin: 0;
		padding: 0 16px 14px 34px;
		display: grid;
		gap: 10px;
		font-size: 12.5px;
	}
	.disproved li {
		display: grid;
		gap: 2px;
	}
	.who {
		color: var(--faint);
		font-size: 11.5px;
	}
	.who code {
		font-family: var(--mono);
	}
	.disproved s {
		color: var(--muted);
	}
	.why {
		color: #23744a;
	}
	.clef summary {
		color: var(--clef);
	}
	.count {
		margin-left: auto;
		font: 11px var(--mono);
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--clef-wash);
	}
	.clef-off {
		margin: 0;
		padding: 0 16px 14px 34px;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--muted);
	}
	.clef-off code {
		font: 11.5px var(--mono);
		color: var(--ink-2);
	}
	.decisions {
		list-style: none;
		margin: 0;
		padding: 0 16px 14px 34px;
		display: grid;
		gap: 8px;
	}
	.decisions li {
		display: grid;
		grid-template-columns: 62px 128px 90px 54px 1fr;
		align-items: center;
		gap: 10px;
		font-size: 12.5px;
	}
	time,
	.p {
		font: 11.5px var(--mono);
		color: var(--faint);
	}
	.p {
		color: var(--clef);
	}
	.dec {
		font-weight: 500;
		color: var(--ink);
	}
	.detail {
		color: var(--ink-2);
	}
	.meter {
		position: relative;
		height: 6px;
		border-radius: 3px;
		background: var(--line);
	}
	.fill {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: 3px;
		background: color-mix(in oklab, var(--clef) 40%, transparent);
	}
	.fill.applied {
		background: var(--clef);
	}
	.mark {
		position: absolute;
		top: -3px;
		bottom: -3px;
		width: 1.5px;
		background: var(--ink);
	}
</style>
