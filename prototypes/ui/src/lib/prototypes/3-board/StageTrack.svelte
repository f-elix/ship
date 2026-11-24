<script lang="ts">
	import type { Run } from '#lib';
	import { STAGE_COLOR, stageDots } from './model.ts';

	let { run, labels = false }: { run: Run; labels?: boolean } = $props();

	const dots = $derived(stageDots(run));
</script>

<div class={['track', labels && 'labelled']} role="list" aria-label="Pipeline progress">
	{#each dots as d (d.stage)}
		<div class="seg" role="listitem" title="{d.stage}: {d.state}" style:--c={STAGE_COLOR[d.stage]}>
			<span class={['bar', d.state]}></span>
			{#if labels}
				<span class={['label', d.state]}>{d.stage}</span>
			{/if}
		</div>
	{/each}
</div>

<style>
	.track {
		display: flex;
		gap: 3px;
	}
	.labelled {
		gap: 6px;
	}
	.seg {
		flex: 1;
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.bar {
		height: 4px;
		border-radius: 4px;
		background: var(--line-2, #e6e8f1);
		transition:
			background 300ms,
			box-shadow 300ms;
	}
	.labelled .bar {
		height: 6px;
	}
	.bar.done {
		background: var(--c);
	}
	.bar.current {
		background: var(--c);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 22%, transparent);
		animation: pulse 1.6s ease-in-out infinite;
	}
	.bar.waiting {
		background: repeating-linear-gradient(
			-45deg,
			var(--c) 0 4px,
			color-mix(in srgb, var(--c) 35%, white) 4px 8px
		);
		background-size: 22px 100%;
		animation: slide 1.2s linear infinite;
	}
	.bar.blocked {
		background: var(--danger, #e5484d);
	}
	.bar.skip {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--line-2, #e6e8f1);
	}
	.label {
		font-size: 11px;
		color: var(--ink-3);
		text-transform: capitalize;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.label.done,
	.label.current,
	.label.waiting {
		color: var(--ink);
		font-weight: 500;
	}
	.label.blocked {
		color: var(--danger, #e5484d);
		font-weight: 600;
	}
	.label.skip {
		text-decoration: line-through;
		opacity: 0.6;
	}
	@keyframes pulse {
		50% {
			opacity: 0.55;
		}
	}
	@keyframes slide {
		to {
			background-position: 22px 0;
		}
	}
</style>
