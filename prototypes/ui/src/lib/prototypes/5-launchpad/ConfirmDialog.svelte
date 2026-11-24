<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { backOut } from 'svelte/easing';
	import { getLaunchpad } from './state.svelte.ts';

	const lp = getLaunchpad();
	const req = $derived(lp.confirmReq);

	const close = () => (lp.confirmReq = null);
</script>

<svelte:window onkeydown={(e) => req && e.key === 'Escape' && close()} />

{#if req}
	<div class="scrim" transition:fade={{ duration: 160 }} onclick={close} role="presentation"></div>
	<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="lp-confirm-title" transition:scale={{ start: 0.92, duration: 280, easing: backOut }}>
		<h3 id="lp-confirm-title">{req.title}</h3>
		<p>{req.body}</p>
		{#if req.command}<code>$ {req.command}</code>{/if}
		<div class="actions">
			<button type="button" class="ghost" onclick={close}>Never mind</button>
			{#if req.alt}
				{@const alt = req.alt}
				<button
					type="button"
					class="danger-outline"
					title={alt.command}
					onclick={() => {
						close();
						alt.onClick();
					}}>{alt.label}</button
				>
			{/if}
			<button
				type="button"
				class={['primary', req.tone ?? 'accent']}
				onclick={() => {
					const r = req;
					close();
					r?.onConfirm();
				}}>{req.confirmLabel}</button
			>
		</div>
	</div>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		background: rgba(43, 32, 24, 0.32);
		backdrop-filter: blur(3px);
		z-index: 80;
	}
	.dialog {
		position: fixed;
		z-index: 81;
		top: 50%;
		left: 50%;
		translate: -50% -50%;
		width: 460px;
		background: var(--card);
		border-radius: 26px;
		padding: 28px;
		box-shadow: 0 30px 80px -24px rgba(50, 25, 5, 0.45);
	}
	h3 {
		font: 700 22px/1.2 var(--display);
		margin: 0 0 10px;
	}
	p {
		margin: 0 0 14px;
		color: var(--ink-2);
		line-height: 1.5;
	}
	code {
		display: block;
		font: 13px var(--mono);
		background: var(--bg-2);
		padding: 10px 12px;
		border-radius: 12px;
		margin-bottom: 6px;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 20px;
	}
	button {
		font: 600 14px var(--sans);
		padding: 10px 18px;
		border-radius: 999px;
		border: 0;
		cursor: pointer;
		transition: transform 0.12s;
	}
	button:active {
		transform: scale(0.96);
	}
	.ghost {
		background: transparent;
		color: var(--ink-2);
	}
	.ghost:hover {
		background: var(--bg-2);
	}
	.primary.accent {
		background: var(--accent);
		color: #fff;
	}
	.primary.danger {
		background: var(--red);
		color: #fff;
	}
	.danger-outline {
		background: transparent;
		color: var(--red);
		box-shadow: inset 0 0 0 1.5px var(--red);
	}
</style>
