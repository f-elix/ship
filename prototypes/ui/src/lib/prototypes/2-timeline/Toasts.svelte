<script lang="ts">
	import { fly } from 'svelte/transition';
	import { getTimeline } from './state.svelte.ts';

	const tl = getTimeline();
</script>

<div class="toasts" aria-live="polite">
	{#each tl.toasts as t (t.id)}
		<div class="toast {t.tone}" transition:fly={{ y: 12, duration: 220 }}>
			<span class="rule" aria-hidden="true"></span>
			<div>
				<p class="text">{t.text}</p>
				{#if t.detail}<p class="detail">{t.detail}</p>{/if}
			</div>
			<button type="button" aria-label="Dismiss" onclick={() => tl.dismiss(t.id)}>×</button>
		</div>
	{/each}
</div>

<style>
	.toasts {
		position: fixed;
		left: 50%;
		bottom: 28px;
		translate: -50% 0;
		display: grid;
		gap: 10px;
		z-index: 30;
		pointer-events: none;
	}

	.toast {
		pointer-events: auto;
		display: grid;
		grid-template-columns: 3px 1fr auto;
		gap: 14px;
		align-items: start;
		width: 400px;
		padding: 13px 14px 13px 0;
		background: var(--paper-raised);
		border: 1px solid var(--rule-strong);
		border-radius: 8px;
		box-shadow: 0 12px 32px -12px rgb(60 45 20 / 0.25);
		overflow: hidden;
	}

	.rule {
		align-self: stretch;
		background: var(--blue);
	}
	.ok .rule {
		background: var(--green);
	}
	.warn .rule {
		background: var(--amber);
	}

	p {
		margin: 0;
	}

	.text {
		font: 500 16px/1.3 var(--serif);
	}

	.detail {
		margin-top: 2px;
		font-size: 13px;
		color: var(--muted);
	}

	button {
		border: 0;
		background: none;
		font-size: 18px;
		line-height: 1;
		color: var(--faint);
		cursor: pointer;
	}

	button:hover {
		color: var(--ink);
	}
</style>
