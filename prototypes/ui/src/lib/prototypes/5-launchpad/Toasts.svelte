<script lang="ts">
	import { fly } from 'svelte/transition';
	import { backOut } from 'svelte/easing';
	import { flip } from 'svelte/animate';
	import { getLaunchpad } from './state.svelte.ts';

	const lp = getLaunchpad();
</script>

<div class="stack" aria-live="polite">
	{#each lp.toasts as t (t.id)}
		<div
			class={['toast', t.tone]}
			in:fly={{ y: 24, duration: 420, easing: backOut }}
			out:fly={{ x: 40, duration: 220 }}
			animate:flip={{ duration: 260 }}
		>
			<span class="mark">
				{#if t.tone === 'success'}
					<svg viewBox="0 0 20 20"><path d="M5 10.5l3.2 3L15 6.5" /></svg>
				{:else if t.tone === 'danger' || t.tone === 'warn'}
					<svg viewBox="0 0 20 20"><path d="M10 5.5v5.5M10 14.2v.3" /></svg>
				{:else}
					<svg viewBox="0 0 20 20"><path d="M6 10h8" /></svg>
				{/if}
			</span>
			<div class="body">
				<strong>{t.title}</strong>
				{#if t.body}<p>{t.body}</p>{/if}
				{#if t.command}<code>$ {t.command}</code>{/if}
			</div>
			<button type="button" aria-label="Dismiss" onclick={() => lp.dismiss(t.id)}>×</button>
		</div>
	{/each}
</div>

<style>
	.stack {
		position: fixed;
		right: 28px;
		bottom: 28px;
		display: grid;
		gap: 10px;
		z-index: 90;
		width: 380px;
	}
	.toast {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 12px;
		align-items: start;
		background: var(--ink);
		color: var(--bg);
		padding: 14px 14px 14px 16px;
		border-radius: 18px;
		box-shadow: 0 18px 40px -16px rgba(50, 25, 5, 0.5);
	}
	.mark {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: rgba(255, 240, 225, 0.14);
	}
	.success .mark {
		background: var(--teal);
	}
	.danger .mark {
		background: var(--red);
	}
	.warn .mark {
		background: var(--amber);
	}
	svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: #fff;
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.body {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	strong {
		font-size: 14.5px;
	}
	p {
		margin: 0;
		font-size: 13px;
		opacity: 0.75;
		line-height: 1.45;
	}
	code {
		font: 12px var(--mono);
		color: #f7b58a;
		overflow-wrap: anywhere;
	}
	button {
		background: none;
		border: 0;
		color: inherit;
		opacity: 0.5;
		font-size: 20px;
		line-height: 1;
		cursor: pointer;
		padding: 0 4px;
	}
	button:hover {
		opacity: 1;
	}
</style>
