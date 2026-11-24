<script lang="ts">
	import { getTimeline } from './state.svelte.ts';

	const tl = getTimeline();

	let c = $derived(tl.confirmation);

	const modal = (dialog: HTMLDialogElement) => {
		dialog.showModal();
		return () => dialog.close();
	};

	const confirm = () => {
		c?.onConfirm();
		tl.confirmation = null;
	};
</script>

{#if c}
	<dialog
		{@attach modal}
		onclose={() => (tl.confirmation = null)}
		onclick={(e) => {
			if (e.target === e.currentTarget) tl.confirmation = null;
		}}
	>
		<div class="sheet">
			<h2>{c.title}</h2>
			<p>{c.body}</p>
			<pre><span class="prompt">$</span> {c.command}</pre>
			<div class="actions">
				<button type="button" class="ghost" onclick={() => (tl.confirmation = null)}>Not now</button>
				<button type="button" class={['primary', c.tone === 'danger' && 'danger']} onclick={confirm}>
					{c.confirmLabel}
				</button>
			</div>
		</div>
	</dialog>
{/if}

<style>
	dialog {
		padding: 0;
		border: 1px solid var(--rule-strong);
		border-radius: 10px;
		background: var(--paper-raised);
		color: var(--ink);
		box-shadow: 0 30px 60px -20px rgb(50 40 20 / 0.35);
		width: 480px;
	}

	dialog::backdrop {
		background: rgb(40 34 24 / 0.22);
		backdrop-filter: blur(1.5px);
	}

	.sheet {
		padding: 26px 28px 22px;
	}

	h2 {
		margin: 0 0 8px;
		font: 500 24px/1.2 var(--serif);
	}

	p {
		margin: 0 0 16px;
		color: var(--ink-2);
		font: 16px/1.55 var(--serif);
	}

	pre {
		margin: 0 0 22px;
		padding: 10px 12px;
		background: var(--paper-sunk);
		border-radius: 6px;
		font: 13px/1.4 var(--mono);
	}

	.prompt {
		color: var(--faint);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	button {
		font: 500 14px var(--sans);
		padding: 8px 14px;
		border-radius: 6px;
		cursor: pointer;
	}

	.ghost {
		border: 1px solid transparent;
		background: none;
		color: var(--muted);
	}

	.ghost:hover {
		color: var(--ink);
	}

	.primary {
		border: 1px solid var(--ink);
		background: var(--ink);
		color: var(--paper-raised);
	}

	.primary.danger {
		border-color: var(--red);
		background: var(--red);
	}
</style>
