<script lang="ts">
	import type { Run, Severity } from '#lib';
	import { count, findingById, type Phase } from './phases.ts';
	import Clef from './Clef.svelte';
	import FindingCard from './FindingCard.svelte';

	let { run, phase }: { run: Run; phase: Phase } = $props();

	let triaged = $derived.by(() => {
		const e = phase.events.find((e) => e._tag === 'FindingsTriaged');
		return e?._tag === 'FindingsTriaged' ? e : null;
	});
	let escalated = $derived(phase.events.some((e) => e._tag === 'Escalated'));
	let clefs = $derived(phase.events.flatMap((e) => (e._tag === 'ClefDecision' ? [e] : [])));

	let groups = $derived<{ severity: Severity; label: string; ids: string[] }[]>(
		triaged
			? [
					{ severity: 'must-fix', label: 'Must fix', ids: triaged.mustFix },
					{ severity: 'tradeoff', label: 'Tradeoffs', ids: triaged.tradeoffs },
					{ severity: 'nit', label: 'Nits', ids: triaged.nits }
				]
			: []
	);
</script>

{#each clefs as c (c.seq)}
	<Clef decision={c.decision} probability={c.probability} detail={c.detail} />
{/each}

{#if triaged}
	{#each groups as g (g.severity)}
		<section class={g.severity}>
			<h4>{g.label} <span>{g.ids.length}</span></h4>
			{#if g.ids.length === 0}
				<p class="none">None.</p>
			{:else}
				{#each g.ids as id (id)}
					{@const f = findingById(run, id)}
					{#if f}
						<FindingCard finding={f} compact />
					{:else}
						<p class="none"><code>{id}</code></p>
					{/if}
				{/each}
			{/if}
		</section>
	{/each}

	<p class="outcome">
		{#if escalated}
			With {count(triaged.mustFix.length, 'must-fix finding')} still open and no review rounds left, ship stops here and escalates.
		{:else if triaged.mustFix.length}
			{count(triaged.mustFix.length, 'must-fix finding').replace(/^./, (c) => c.toUpperCase())} go to the fix agent. Tradeoffs and nits are left
			for a human, in the PR body.
		{:else}
			Nothing must be fixed. Tradeoffs and nits go in the PR body for a human to weigh.
		{/if}
	</p>
{:else}
	<p class="outcome">Sorting the kept findings by severity…</p>
{/if}

<style>
	section {
		margin-top: 12px;
	}

	h4 {
		display: flex;
		gap: 8px;
		margin: 0 0 2px;
		font: 600 11px var(--sans);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--muted);
	}

	h4 span {
		color: var(--faint);
	}

	.must-fix h4 {
		color: var(--red);
	}

	.tradeoff h4 {
		color: var(--amber);
	}

	.none {
		margin: 2px 0 0;
		font: italic 15px var(--serif);
		color: var(--faint);
	}

	.outcome {
		margin: 16px 0 0;
		font: 16px/1.55 var(--serif);
		color: var(--ink-2);
	}
</style>
