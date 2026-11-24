<script lang="ts">
	import type { RunStatus } from '#lib';

	let { status, size = 'md' }: { status: RunStatus; size?: 'sm' | 'md' } = $props();
</script>

<span class={['pill', status, size]}>
	<i></i>{status}
</span>

<style>
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 10px 3px 8px;
		border-radius: 999px;
		font-size: 12.5px;
		font-weight: 600;
		letter-spacing: 0.01em;
		white-space: nowrap;
		background: var(--c-soft);
		color: var(--c);
		--c: var(--slate);
		--c-soft: var(--slate-soft);
	}
	.sm {
		font-size: 11.5px;
		padding: 2px 8px 2px 6px;
	}
	i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
	}
	.running {
		--c: var(--accent-ink);
		--c-soft: var(--accent-soft);
	}
	.running i {
		animation: pulse 1.4s ease-in-out infinite;
	}
	.waiting {
		--c: var(--amber);
		--c-soft: var(--amber-soft);
	}
	.done {
		--c: var(--teal);
		--c-soft: var(--teal-soft);
	}
	.escalated {
		--c: var(--plum);
		--c-soft: var(--plum-soft);
	}
	.failed {
		--c: var(--red);
		--c-soft: var(--red-soft);
	}
	@keyframes pulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 45%, transparent);
		}
		50% {
			box-shadow: 0 0 0 5px transparent;
		}
	}
</style>
