<script lang="ts">
	import { describe, relTime } from '#lib';
	import { kindLabel, projectName } from './data.ts';
	import { getInbox } from './inbox.svelte.ts';

	const inbox = getInbox();

	const titles = { decision: 'Needs decision', snoozed: 'Snoozed', done: 'Done', running: 'Running' };
	const heading = $derived(inbox.project ? projectName(inbox.project) : titles[inbox.folder]);
	const total = $derived(inbox.visibleIds.length);

	let listEl = $state<HTMLElement>();
	$effect(() => {
		const id = inbox.selectedId;
		listEl?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
	});
</script>

<section class="list" aria-label="Inbox">
	<header>
		<h1>{heading}</h1>
		<span class="count">{total}</span>
		{#if inbox.project}
			<button type="button" class="chip" onclick={() => inbox.setProject(null)}>{titles[inbox.folder]} ✕</button>
		{/if}
	</header>

	<div class="items" bind:this={listEl} role="listbox" aria-label={heading} tabindex="-1">
		{#if inbox.folder === 'running'}
			{#each inbox.runningRows.filter((r) => !inbox.project || r.projectKey === inbox.project) as r (r.runId)}
				{@const id = `run:${r.runId}`}
				<button type="button" role="option" aria-selected={inbox.selectedId === id} data-id={id} class={['item', 'run', inbox.selectedId === id && 'sel']} onclick={() => inbox.select(id, true)}>
					<span class="top">
						<i class={['pulse', r.status]}></i>
						<span class="proj">{projectName(r.projectKey)}</span>
						<code>{r.runId}</code>
						<span class="when">{r.lastLine ? relTime(r.updatedAt) : 'now'}</span>
					</span>
					<span class="title">{r.title}</span>
					<span class="reason mono">{r.state}{r.lastLine ? ` — ${describe(r.lastLine)}` : ` — ${r.command}`}</span>
				</button>
			{/each}
		{:else}
			{#each inbox.visible as e (e.id)}
				<div role="option" aria-selected={inbox.selectedId === e.id} data-id={e.id} class={['item', `tone-${e.tone}`, inbox.selectedId === e.id && 'sel', e.unread && 'unread']}>
					<button type="button" class="hit" aria-label="Open {e.title}" onclick={() => inbox.select(e.id, true)}></button>
					<span class="top">
						<i class="dot" aria-label={e.unread ? 'unread' : undefined}></i>
						<span class="proj">{projectName(e.projectKey)}</span>
						<span class="kind">{kindLabel[e.kind]}</span>
						<span class="when">{relTime(e.at)}</span>
					</span>
					<span class="title">{e.title}</span>
					<span class="reason">{e.status === 'open' ? e.reason : e.resolution}</span>
					<span class="quick">
						<button type="button" title="{e.status === 'archived' ? 'Move to inbox' : 'Archive'} (e)" onclick={() => inbox.archive(e.id)}>
							<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
								><path d="M2.5 4.5h11v2h-11ZM3.5 6.5v6h9v-6M6.5 9h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg
							>
						</button>
						<button type="button" title="{e.status === 'snoozed' ? 'Unsnooze' : 'Snooze'} (h)" onclick={() => inbox.snooze(e.id)}>
							<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
								><path d="M8 4.5V8l2 1.3M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg
							>
						</button>
					</span>
				</div>
			{/each}
		{/if}

		{#if total === 0}
			{#if inbox.folder === 'decision'}
				<div class="zero">
					<svg viewBox="0 0 120 80" width="132" height="88" aria-hidden="true">
						<path d="M10 58h100" stroke="var(--line-strong)" stroke-width="1.5" stroke-dasharray="2 5" stroke-linecap="round" />
						<path d="M34 50h52l-7 9H41Z" fill="var(--ink)" />
						<path d="M60 14v34M60 16l20 30H60" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" />
						<circle cx="94" cy="20" r="6" fill="none" stroke="var(--tr)" stroke-width="1.5" />
					</svg>
					<h2>Inbox zero</h2>
					<p>Nothing needs you{inbox.project ? ` in ${projectName(inbox.project)}` : ''}. {inbox.runningCount} run{inbox.runningCount === 1 ? ' is' : 's are'} sailing on their own.</p>
					<button type="button" onclick={() => inbox.setFolder('running')}>Peek at Running</button>
					<span class="hint">press <kbd>z</kbd> to undo the last archive</span>
				</div>
			{:else}
				<p class="empty">Nothing {inbox.folder === 'snoozed' ? 'snoozed' : 'here yet'}.</p>
			{/if}
		{/if}
	</div>

	<footer>
		<span><kbd>j</kbd><kbd>k</kbd> move</span>
		<span><kbd>↵</kbd> open</span>
		<span><kbd>e</kbd> archive</span>
		<span><kbd>h</kbd> snooze</span>
	</footer>
</section>

<style>
	.list {
		display: grid;
		grid-template-rows: auto 1fr auto;
		height: 100vh;
		min-height: 0;
		background: var(--panel);
		border-right: 1px solid var(--line);
	}
	header {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 20px 20px 14px;
		border-bottom: 1px solid var(--line);
	}
	h1 {
		margin: 0;
		font-size: 18px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--ink);
	}
	.count {
		font-size: 13px;
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}
	.chip {
		all: unset;
		cursor: pointer;
		margin-left: auto;
		font-size: 11.5px;
		color: var(--muted);
		padding: 2px 8px;
		border-radius: 999px;
		border: 1px solid var(--line);
	}
	.items {
		overflow-y: auto;
		min-height: 0;
		outline: none;
	}
	.item {
		all: unset;
		box-sizing: border-box;
		position: relative;
		display: grid;
		gap: 3px;
		width: 100%;
		padding: 12px 20px 13px 26px;
		border-bottom: 1px solid var(--line);
		cursor: pointer;
		--tc: var(--line-strong);
	}
	.tone-must-fix,
	.tone-error {
		--tc: var(--mf);
	}
	.tone-tradeoff {
		--tc: var(--tr);
	}
	.tone-nit {
		--tc: var(--nit);
	}
	.item::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 3px;
		background: transparent;
	}
	.item:hover {
		background: color-mix(in oklab, var(--bg) 70%, var(--panel));
	}
	.item.sel {
		background: var(--sel);
	}
	.item.sel::before {
		background: var(--ink);
	}
	.hit {
		all: unset;
		position: absolute;
		inset: 0;
		cursor: pointer;
	}
	.hit:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
	}
	.top {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11.5px;
		color: var(--faint);
		pointer-events: none;
	}
	.dot {
		position: absolute;
		left: 11px;
		top: 17px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: transparent;
	}
	.unread .dot {
		background: var(--accent);
	}
	.proj {
		color: var(--muted);
		font-weight: 500;
	}
	.kind {
		color: var(--tc);
		font-weight: 600;
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.when {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}
	.title {
		font-size: 14px;
		color: var(--ink-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		pointer-events: none;
	}
	.unread .title {
		color: var(--ink);
		font-weight: 600;
	}
	.reason {
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--muted);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		pointer-events: none;
		padding-left: 9px;
		border-left: 2px solid var(--tc);
	}
	.reason.mono {
		font: 11.5px/1.5 var(--mono);
		border-left-color: var(--line-strong);
	}
	.run code {
		font: 11px var(--mono);
	}
	.pulse {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--faint);
	}
	.pulse.running {
		background: var(--live);
	}
	.pulse.waiting {
		background: var(--tr);
	}
	.quick {
		position: absolute;
		right: 14px;
		top: 30px;
		display: none;
		gap: 2px;
		padding: 2px;
		border-radius: 7px;
		background: var(--panel);
		border: 1px solid var(--line);
		box-shadow: 0 2px 8px -4px rgb(0 0 0 / 0.2);
	}
	.item:hover .quick {
		display: flex;
	}
	.quick button {
		all: unset;
		cursor: pointer;
		display: grid;
		place-items: center;
		width: 26px;
		height: 24px;
		border-radius: 5px;
		color: var(--muted);
	}
	.quick button:hover {
		background: var(--bg);
		color: var(--ink);
	}
	.zero {
		display: grid;
		justify-items: center;
		gap: 8px;
		padding: 72px 32px;
		text-align: center;
	}
	.zero h2 {
		margin: 8px 0 0;
		font-size: 17px;
		font-weight: 600;
		color: var(--ink);
	}
	.zero p {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
		max-width: 260px;
		line-height: 1.5;
	}
	.zero button {
		all: unset;
		cursor: pointer;
		margin-top: 10px;
		font-size: 12.5px;
		padding: 6px 12px;
		border-radius: 7px;
		border: 1px solid var(--line-strong);
		color: var(--ink);
	}
	.zero .hint {
		font-size: 11.5px;
		color: var(--faint);
	}
	.empty {
		padding: 48px 20px;
		text-align: center;
		color: var(--faint);
		font-size: 13px;
	}
	footer {
		display: flex;
		gap: 14px;
		padding: 10px 20px;
		border-top: 1px solid var(--line);
		font-size: 11px;
		color: var(--faint);
	}
	kbd {
		font: 10px var(--mono);
		padding: 0 4px;
		margin-right: 3px;
		border: 1px solid var(--line-strong);
		border-bottom-width: 2px;
		border-radius: 3px;
		color: var(--muted);
		background: var(--panel);
	}
</style>
