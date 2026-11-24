<script lang="ts">
	import type { RunStatus } from '#lib';

	let { status }: { status: RunStatus } = $props();
</script>

<span class={['dot', status]} title={status} aria-label={status} role="img"></span>

<style>
	.dot {
		position: relative;
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--c);
		--c: var(--s-cancelled);
	}
	.running {
		--c: var(--s-running);
	}
	.running::after {
		content: '';
		position: absolute;
		inset: -3px;
		border-radius: 50%;
		border: 1px solid var(--c);
		animation: ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
	}
	.waiting {
		--c: var(--s-waiting);
		animation: blink 1.2s steps(2, jump-none) infinite;
	}
	.escalated {
		--c: var(--s-escalated);
		border-radius: 1px;
		transform: rotate(45deg) scale(0.9);
	}
	.failed {
		--c: var(--s-failed);
		border-radius: 1px;
	}
	.interrupted {
		--c: transparent;
		box-shadow: inset 0 0 0 1.5px var(--s-interrupted);
	}
	.done {
		--c: var(--s-done);
	}
	.cancelled {
		--c: transparent;
		box-shadow: inset 0 0 0 1.5px var(--s-cancelled);
	}
	@keyframes ping {
		from {
			opacity: 0.9;
			transform: scale(0.6);
		}
		to {
			opacity: 0;
			transform: scale(1.8);
		}
	}
	@keyframes blink {
		50% {
			opacity: 0.35;
		}
	}
</style>
