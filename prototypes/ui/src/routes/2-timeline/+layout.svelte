<script lang="ts">
	import type { LayoutProps } from './$types';
	import { TimelineState, setTimeline } from '#lib/prototypes/2-timeline/state.svelte.ts';
	import RunList from '#lib/prototypes/2-timeline/RunList.svelte';
	import Toasts from '#lib/prototypes/2-timeline/Toasts.svelte';
	import ConfirmDialog from '#lib/prototypes/2-timeline/ConfirmDialog.svelte';

	let { children }: LayoutProps = $props();

	setTimeline(new TimelineState());
</script>

<svelte:head>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		rel="stylesheet"
		href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400;1,6..72,500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
	/>
</svelte:head>

<div class="tl">
	<RunList />
	{@render children()}
	<Toasts />
	<ConfirmDialog />
</div>

<style>
	.tl {
		--paper: #f8f5ee;
		--paper-raised: #fdfbf7;
		--paper-sunk: #f1ece2;
		--ink: #22201c;
		--ink-2: #4a463f;
		--muted: #857e72;
		--faint: #b5ad9f;
		--rule: #e4ddcf;
		--rule-strong: #d3cab8;

		--green: #3e7a52;
		--green-soft: #e3eedf;
		--red: #a8392c;
		--red-soft: #f6e3dc;
		--amber: #a26c16;
		--amber-soft: #f6ead0;
		--blue: #2d5c86;
		--blue-soft: #e2eaf1;

		--serif: 'Newsreader', 'Iowan Old Style', Georgia, serif;
		--sans: 'IBM Plex Sans', -apple-system, system-ui, sans-serif;
		--mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;

		display: grid;
		grid-template-columns: 272px minmax(0, 1fr);
		min-height: 100vh;
		background: var(--paper);
		color: var(--ink);
		font: 15px/1.6 var(--sans);
		-webkit-font-smoothing: antialiased;
	}

	.tl :global(::selection) {
		background: #e9dcb8;
	}

	.tl :global(code) {
		font-family: var(--mono);
		font-size: 0.86em;
	}
</style>
