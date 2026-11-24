<script lang="ts">
	import { getInbox } from './inbox.svelte.ts';

	const inbox = getInbox();

	const keys: [string, { k: string[]; d: string }[]][] = [
		[
			'Navigate',
			[
				{ k: ['j', 'k'], d: 'Next / previous item (or finding when open)' },
				{ k: ['↵'], d: 'Open item — step into its findings' },
				{ k: ['esc'], d: 'Back to the list' },
				{ k: ['1', '2', '3', '4'], d: 'Needs decision · Snoozed · Done · Running' }
			]
		],
		[
			'Item',
			[
				{ k: ['e'], d: 'Archive (or acknowledge)' },
				{ k: ['h'], d: 'Snooze until tomorrow' },
				{ k: ['u'], d: 'Toggle unread' },
				{ k: ['z'], d: 'Undo archive / snooze' }
			]
		],
		[
			'Run ship',
			[
				{ k: ['f'], d: 'Fix — ship fix <pr | review-id>' },
				{ k: ['r'], d: 'Resume — ship resume <run-id>' },
				{ k: ['c'], d: 'Recheck — ship recheck <pr>' },
				{ k: ['p'], d: 'Post review — ship post <review-id>' }
			]
		],
		[
			'Finding (when open)',
			[
				{ k: ['l'], d: 'Leave for fix / keep as triaged' },
				{ k: ['a'], d: 'Accept as tradeoff' },
				{ k: ['n'], d: 'Downgrade to nit' },
				{ k: ['d'], d: 'Dismiss' },
				{ k: ['x'], d: 'Fix a tradeoff anyway' }
			]
		]
	];

	let confirmBtn = $state<HTMLButtonElement>();
	$effect(() => {
		if (inbox.confirm) confirmBtn?.focus();
	});
</script>

{#if inbox.showKeys}
	<div class="scrim" role="presentation" onclick={() => (inbox.showKeys = false)}>
		<div class="sheet keys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
			<header><h2>Keyboard</h2><span>esc to close</span></header>
			<div class="cols">
				{#each keys as [title, rows] (title)}
					<section>
						<h3>{title}</h3>
						<dl>
							{#each rows as r (r.d)}
								<dt>{#each r.k as k (k)}<kbd>{k}</kbd>{/each}</dt>
								<dd>{r.d}</dd>
							{/each}
						</dl>
					</section>
				{/each}
			</div>
		</div>
	</div>
{/if}

{#if inbox.confirm}
	{@const c = inbox.confirm}
	<div class="scrim" role="presentation" onclick={() => (inbox.confirm = null)}>
		<div class="sheet confirm" role="alertdialog" aria-modal="true" aria-label={c.title} tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
			<h2>{c.title}</h2>
			<pre class="cmd"><span>$</span> {c.command}</pre>
			<ul>
				{#each c.lines as l (l)}
					<li class={l.split(' · ')[0]}>{l}</li>
				{/each}
			</ul>
			{#if c.note}<p class="note">{c.note}</p>{/if}
			<div class="row">
				<button type="button" class="ghost" onclick={() => (inbox.confirm = null)}>Cancel <kbd>esc</kbd></button>
				<button type="button" class="go" bind:this={confirmBtn} onclick={() => inbox.accept()}>{c.confirmLabel} <kbd>↵</kbd></button>
			</div>
		</div>
	</div>
{/if}

<div class="toasts" aria-live="polite">
	{#each inbox.toasts as t (t.id)}
		<div class="toast">
			<span class="tick">✓</span>
			<span class="txt">{t.text}{#if t.command}<code>{t.command}</code>{/if}</span>
			{#if t.undo}
				<button type="button" onclick={() => inbox.undo()}>Undo <kbd>z</kbd></button>
			{/if}
		</div>
	{/each}
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 20;
		display: grid;
		place-items: center;
		background: rgb(28 28 30 / 0.28);
		backdrop-filter: blur(2px);
		animation: fade 0.12s ease-out;
	}
	.sheet {
		background: var(--panel);
		border-radius: 14px;
		box-shadow:
			0 24px 64px -16px rgb(0 0 0 / 0.35),
			0 0 0 1px rgb(0 0 0 / 0.06);
		animation: rise 0.16s ease-out;
		outline: none;
	}
	.keys {
		width: 760px;
		padding: 22px 26px 26px;
	}
	.keys header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 14px;
	}
	.keys header span {
		font-size: 12px;
		color: var(--faint);
	}
	h2 {
		margin: 0;
		font-size: 17px;
		font-weight: 600;
		color: var(--ink);
	}
	.cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 22px 36px;
	}
	h3 {
		margin: 0 0 8px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--faint);
	}
	dl {
		display: grid;
		grid-template-columns: 96px 1fr;
		gap: 7px 12px;
		margin: 0;
		font-size: 13px;
	}
	dt {
		display: flex;
		gap: 3px;
	}
	dd {
		margin: 0;
		color: var(--ink-2);
	}
	kbd {
		font: 11px var(--mono);
		min-width: 18px;
		text-align: center;
		padding: 1px 5px;
		border-radius: 4px;
		border: 1px solid var(--line-strong);
		border-bottom-width: 2px;
		background: var(--bg);
		color: var(--ink-2);
	}
	.confirm {
		width: 540px;
		padding: 22px 24px 18px;
	}
	.cmd {
		margin: 14px 0 12px;
		padding: 12px 14px;
		border-radius: 8px;
		background: var(--ink);
		color: #f3f2ee;
		font: 13px var(--mono);
	}
	.cmd span {
		color: #8d8c88;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 4px;
		font: 12px/1.5 var(--mono);
		color: var(--ink-2);
	}
	li::before {
		content: '';
		display: inline-block;
		width: 6px;
		height: 6px;
		margin-right: 8px;
		border-radius: 50%;
		background: var(--line-strong);
		vertical-align: 1px;
	}
	li.must-fix::before {
		background: var(--mf);
	}
	li.nit::before {
		background: var(--nit);
	}
	li.tradeoff::before {
		background: var(--tr);
	}
	.note {
		margin: 14px 0 0;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--muted);
	}
	.row {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 18px;
	}
	.row button {
		all: unset;
		cursor: pointer;
		display: inline-flex;
		gap: 8px;
		align-items: center;
		padding: 8px 14px;
		border-radius: 8px;
		font-size: 13px;
		font-weight: 500;
	}
	.row button:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.ghost {
		color: var(--muted);
	}
	.go {
		background: var(--ink);
		color: var(--panel);
	}
	.go kbd {
		background: transparent;
		color: inherit;
		border-color: rgb(255 255 255 / 0.3);
	}
	.toasts {
		position: fixed;
		bottom: 76px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 30;
		display: grid;
		gap: 8px;
		justify-items: center;
		pointer-events: none;
	}
	.toast {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 9px 10px 9px 14px;
		border-radius: 10px;
		background: var(--ink);
		color: #f3f2ee;
		font-size: 13px;
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.5);
		animation: rise 0.18s ease-out;
	}
	.tick {
		color: #7fd3a6;
	}
	.txt code {
		margin-left: 10px;
		font: 11.5px var(--mono);
		color: #a9a8a3;
	}
	.toast button {
		all: unset;
		cursor: pointer;
		display: inline-flex;
		gap: 6px;
		align-items: center;
		padding: 3px 8px;
		border-radius: 6px;
		font-weight: 600;
		color: #9cc0ff;
	}
	.toast button:hover {
		background: rgb(255 255 255 / 0.08);
	}
	.toast kbd {
		background: transparent;
		color: inherit;
		border-color: rgb(255 255 255 / 0.25);
		font-size: 10px;
	}
	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
</style>
