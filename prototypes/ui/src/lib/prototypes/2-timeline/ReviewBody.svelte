<script lang="ts">
	import { fade } from 'svelte/transition';
	import { reviewers as briefs, shortSha } from '#lib';
	import type { Run } from '#lib';
	import type { Phase } from './phases.ts';
	import Clef from './Clef.svelte';
	import FindingCard from './FindingCard.svelte';

	let { run, phase }: { run: Run; phase: Phase } = $props();

	let started = $derived.by(() => {
		const e = phase.events.find((e) => e._tag === 'ReviewStarted');
		return e?._tag === 'ReviewStarted' ? e : null;
	});
	let verified = $derived.by(() => {
		const e = phase.events.find((e) => e._tag === 'FindingsVerified');
		return e?._tag === 'FindingsVerified' ? e : null;
	});
	let clefs = $derived(phase.events.flatMap((e) => (e._tag === 'ClefDecision' ? [e] : [])));
	let reports = $derived(
		new Map(phase.events.flatMap((e) => (e._tag === 'FindingsReported' ? [[e.reviewer, e.count] as const] : [])))
	);
	let live = $derived(phase.status === 'current');
	let reported = $derived(started ? started.reviewers.filter((r) => reports.has(r)).length : 0);
</script>

{#each clefs as c (c.seq)}
	<Clef decision={c.decision} probability={c.probability} detail={c.detail} />
{/each}

{#if started}
	<p class="lede">
		{started.reviewers.length} reviewers read the diff
		<code>{shortSha(started.fromSha)}..{shortSha(started.toSha)}</code>{#if live && !verified}; {reported} of {started.reviewers.length}
			have reported{/if}.
	</p>

	<ol class="reviewers">
		{#each started.reviewers as name (name)}
			{@const n = reports.get(name)}
			{@const brief = briefs.find((b) => b.name === name)}
			{@const kept = verified ? run.findings.filter((f) => f.round === phase.round && f.reviewer === name) : []}
			{@const gone = run.disproved.filter((d) => d.round === phase.round && d.reviewer === name)}
			<li>
				<div class="row">
					<span class="name" title={brief?.description}>{name}</span>
					{#if brief?.model}<span class="model">{brief.model}</span>{/if}
					<span class="leader" aria-hidden="true"></span>
					{#key n}
						<span class={['count', n === undefined && !verified && 'pending', n === 0 && 'zero']} in:fade={{ duration: 400 }}>
							{#if n !== undefined}
								{n === 0 ? 'nothing to report' : `${n} finding${n === 1 ? '' : 's'}`}
							{:else if verified}
								reported
							{:else if live}
								reading<span class="ellipsis">…</span>
							{:else}
								did not report
							{/if}
						</span>
					{/key}
				</div>
				{#if kept.length || gone.length}
					<div class="cards">
						{#each kept as f (f.id)}
							<FindingCard finding={f} />
						{/each}
						{#each gone as d (d.claim)}
							<FindingCard disproved={d} />
						{/each}
					</div>
				{/if}
			</li>
		{/each}
	</ol>

	{#if verified}
		<p class="verifier" in:fade={{ duration: 400 }}>
			<span class="who">Verifier</span>
			kept <strong>{verified.verified.length}</strong> and disproved <strong>{verified.disproved}</strong>{#if verified.verified.length}:
				{verified.verified.join(', ')}{/if}.
		</p>
	{:else}
		<p class="verifier pending">The verifier reads every finding against the code once all reviewers have reported.</p>
	{/if}
{/if}

<style>
	.lede {
		margin: 0 0 8px;
		font: 16px/1.55 var(--serif);
		color: var(--ink-2);
	}

	.reviewers {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.reviewers > li {
		padding: 4px 0;
	}

	.row {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.name {
		font: 500 14px var(--mono);
		color: var(--ink);
		cursor: help;
	}

	.model {
		font-size: 11px;
		color: var(--muted);
		padding: 0 5px;
		border: 1px solid var(--rule);
		border-radius: 3px;
	}

	.leader {
		flex: 1;
		border-bottom: 1px dotted var(--rule-strong);
		translate: 0 -4px;
	}

	.count {
		font: italic 15px var(--serif);
		color: var(--ink-2);
	}

	.count.zero {
		color: var(--muted);
	}

	.count.pending {
		color: var(--faint);
	}

	.cards {
		margin: 2px 0 10px 18px;
	}

	.ellipsis {
		animation: breathe 1.6s ease-in-out infinite;
	}

	@keyframes breathe {
		50% {
			opacity: 0.3;
		}
	}

	.verifier {
		margin: 14px 0 0;
		font: 16px/1.5 var(--serif);
		color: var(--ink-2);
	}

	.verifier.pending {
		font-style: italic;
		color: var(--muted);
		font-size: 15px;
	}

	.who {
		font: 600 11px var(--sans);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--green);
		margin-right: 6px;
	}

	strong {
		font-weight: 600;
	}
</style>
