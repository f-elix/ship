<script lang="ts">
	import type { PageProps } from './$types';
	import { getTimeline } from '#lib/prototypes/2-timeline/state.svelte.ts';
	import RunDocument from '#lib/prototypes/2-timeline/RunDocument.svelte';
	import Marginalia from '#lib/prototypes/2-timeline/Marginalia.svelte';

	let { data }: PageProps = $props();

	const tl = getTimeline();

	let run = $derived(tl.get(data.runId));
</script>

<svelte:head>
	<title>{run ? `${run.title} · ${run.runId}` : 'Run not found'} · ship</title>
</svelte:head>

<div class="page">
	<main>
		{#if run}
			{#key run.runId}
				<RunDocument {run} />
			{/key}
		{:else}
			<div class="missing">
				<h1>No run called <code>{data.runId}</code>.</h1>
				<p>It may have been pruned from the daemon's database. Pick one from the list.</p>
			</div>
		{/if}
	</main>
	{#if run}
		<Marginalia {run} />
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
	}

	main {
		padding: 64px 72px 120px 96px;
	}

	@media (min-width: 1440px) {
		.page {
			grid-template-columns: minmax(0, 1fr) 248px;
		}
	}

	.missing {
		max-width: 720px;
		margin: 0 auto;
	}

	.missing h1 {
		font: 500 32px/1.2 var(--serif);
	}

	.missing p {
		font: 17px var(--serif);
		color: var(--muted);
	}
</style>
