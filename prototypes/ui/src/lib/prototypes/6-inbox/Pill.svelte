<script lang="ts">
	import type { Deliverable } from './data.ts';

	let { d }: { d: Deliverable } = $props();

	/** The stage says what kind of attention it needs; the tone refines "your call". */
	const kind = $derived(
		d.stage === 'decide' ? (d.tone === 'error' ? 'error' : d.tone === 'tradeoff' ? 'tradeoff' : 'must-fix') : d.stage
	);
</script>

<span class={['pill', `s-${kind}`]}>{#if d.stage === 'working'}<i class="pulse"></i>{/if}{d.tag}</span>

<style>
	.pill {
		--c: var(--muted);
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 1px 8px;
		font-size: 11.5px;
		font-weight: 500;
		white-space: nowrap;
		color: var(--c);
		background: color-mix(in srgb, var(--c) 13%, transparent);
		border-radius: 99px;
	}
	.s-must-fix {
		--c: var(--mf);
	}
	.s-error {
		--c: var(--err);
	}
	.s-tradeoff {
		--c: var(--tr);
	}
	.s-ready {
		--c: var(--ok);
	}
	.s-working {
		--c: var(--accent);
	}
	.s-queued {
		--c: #a6aebb;
	}
	.s-closed {
		--c: var(--dim);
	}
	.pulse {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: currentColor;
		animation: pulse 1.6s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.25;
		}
	}
</style>
