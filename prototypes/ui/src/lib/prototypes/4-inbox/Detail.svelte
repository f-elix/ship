<script lang="ts">
	import { projectByKey, relTime, usd } from '#lib';
	import BaselineView from './BaselineView.svelte';
	import RecoveryView from './RecoveryView.svelte';
	import RunningView from './RunningView.svelte';
	import ThreadsView from './ThreadsView.svelte';
	import TriageView from './TriageView.svelte';
	import { kindLabel, projectName } from './data.ts';
	import { getInbox } from './inbox.svelte.ts';

	const inbox = getInbox();

	const entry = $derived(inbox.selected);
	const row = $derived(
		inbox.selectedId?.startsWith('run:') ? inbox.runningRows.find((r) => `run:${r.runId}` === inbox.selectedId) : undefined
	);
	const run = $derived(entry ? inbox.run(entry.runId) : undefined);
	const actions = $derived(inbox.actions(entry));
	let hovered = $state<string | null>(null);
	const shown = $derived(actions.find((a) => a.key === hovered) ?? actions.find((a) => a.primary) ?? actions[0]);
	let paneEl = $state<HTMLElement>();

	$effect(() => {
		// New item: start at the top.
		void inbox.selectedId;
		paneEl?.scrollTo({ top: 0 });
	});
</script>

<section class="detail" aria-label="Detail">
	{#if entry}
		<div class="scroll" bind:this={paneEl}>
			<header>
				<div class="crumbs">
					<span class={['kind', `tone-${entry.tone}`]}>{kindLabel[entry.kind]}</span>
					<span>{projectName(entry.projectKey)}</span>
					{#if run?.branch}<code>{run.branch}</code>{/if}
					{#if entry.runId}<code>{entry.runId}</code>{/if}
					{#if entry.prNumber}<a href="https://{entry.projectKey}/pull/{entry.prNumber}" target="_blank" rel="noreferrer">#{entry.prNumber}{run?.status === 'escalated' ? ' (draft)' : ''}</a>{/if}
					<span class="spacer"></span>
					<span>{relTime(entry.at)}</span>
					{#if run && run.costUsd > 0}<span>{usd(run.costUsd)}</span>{/if}
				</div>
				<h1>{entry.title}</h1>
				<p class="reason">{entry.reason}</p>
				{#if run?.escalationReason}
					<p class="esc">
						Escalated <code>{run.escalationReason}</code> after round {run.round} of {projectByKey(run.projectKey)?.caps.reviewRounds}
						· commits {run.commits.map((c) => c.message).join(', ')} · +{run.diffStat.additions} −{run.diffStat.deletions} in {run.diffStat.files} files
					</p>
				{/if}
				{#if entry.kind === 'tradeoff' && run}
					<p class="esc live">
						<i></i> Still running — now <code>{run.state}</code>, round {run.round}. Last: {inbox.live.lastEvent._tag}
					</p>
				{/if}
			</header>

			{#if entry.status !== 'open'}
				<div class="banner">
					<b>{entry.status === 'archived' ? 'Done' : 'Snoozed'}</b> · {entry.resolution}
					<button type="button" onclick={() => (entry.status === 'archived' ? inbox.archive(entry.id) : inbox.snooze(entry.id))}>
						Move to inbox <kbd>{entry.status === 'archived' ? 'e' : 'h'}</kbd>
					</button>
				</div>
			{/if}

			<div class="body">
				{#if (entry.kind === 'escalated' || entry.kind === 'review' || entry.kind === 'tradeoff') && run}
					<TriageView {entry} {run} />
				{:else if (entry.kind === 'failed' || entry.kind === 'interrupted') && run}
					<RecoveryView {entry} {run} />
				{:else if entry.kind === 'baseline' && run}
					<BaselineView {run} />
				{:else if entry.kind === 'threads'}
					<ThreadsView {entry} />
				{/if}
			</div>
		</div>

		{#if actions.length}
			<footer class="bar">
				<div class="cmd">
					{#if shown?.command}<span class="prompt">$</span> {shown.command}{:else}<span class="hint">press <kbd>?</kbd> for shortcuts</span>{/if}
				</div>
				<div class="buttons">
					{#each actions as a (a.key)}
						<button
							type="button"
							class={[a.primary && 'primary']}
							aria-disabled={!!a.disabled}
							title={a.disabled}
							onmouseenter={() => (hovered = a.key)}
							onmouseleave={() => (hovered = null)}
							onfocus={() => (hovered = a.key)}
							onblur={() => (hovered = null)}
							onclick={() => inbox.runAction(a.key)}
						>
							{a.label}<kbd>{a.key}</kbd>
						</button>
					{/each}
				</div>
			</footer>
		{/if}
	{:else if row}
		<div class="scroll">
			<header>
				<div class="crumbs">
					<span class="kind tone-neutral">{row.status}</span>
					<span>{projectName(row.projectKey)}</span>
					<code>{row.runId}</code>
					<code>{row.kind}</code>
				</div>
				<h1>{row.title}</h1>
			</header>
			<div class="body"><RunningView {row} /></div>
		</div>
	{:else}
		<div class="nothing">Select an item</div>
	{/if}
</section>

<style>
	.detail {
		display: grid;
		grid-template-rows: 1fr auto;
		min-height: 0;
		height: 100vh;
		background: var(--bg);
	}
	.scroll {
		overflow-y: auto;
		min-height: 0;
		padding: 28px 40px 40px;
	}
	header,
	.body,
	.banner {
		max-width: 880px;
		margin: 0 auto;
	}
	header {
		padding-bottom: 22px;
	}
	.crumbs {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 12px;
		color: var(--muted);
	}
	.crumbs code {
		font: 11.5px var(--mono);
		color: var(--ink-2);
	}
	.crumbs a {
		color: var(--accent);
		text-decoration: none;
		font-weight: 500;
	}
	.crumbs a:hover {
		text-decoration: underline;
	}
	.spacer {
		flex: 1;
	}
	.kind {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 3px 8px;
		border-radius: 4px;
		color: var(--tc);
		background: color-mix(in oklab, var(--tc) 11%, transparent);
		--tc: var(--muted);
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
	h1 {
		margin: 14px 0 6px;
		font-size: 25px;
		line-height: 1.25;
		font-weight: 600;
		letter-spacing: -0.015em;
		color: var(--ink);
	}
	.reason {
		margin: 0;
		font-size: 15px;
		color: var(--ink-2);
	}
	.esc {
		margin: 12px 0 0;
		font-size: 12.5px;
		color: var(--muted);
		line-height: 1.5;
	}
	.esc code {
		font: 12px var(--mono);
		color: var(--mf);
	}
	.esc.live {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.esc.live code {
		color: var(--ink);
	}
	.esc.live i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--live);
		animation: pulse 1.4s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.3;
		}
	}
	.banner {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 20px;
		padding: 10px 14px;
		border-radius: 8px;
		background: var(--panel);
		border: 1px dashed var(--line-strong);
		font-size: 13px;
		color: var(--muted);
	}
	.banner b {
		color: var(--ink);
	}
	.banner button {
		all: unset;
		cursor: pointer;
		margin-left: auto;
		font-size: 12.5px;
		color: var(--accent);
		display: inline-flex;
		gap: 6px;
		align-items: center;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 12px 40px;
		border-top: 1px solid var(--line);
		background: color-mix(in oklab, var(--panel) 88%, transparent);
		backdrop-filter: blur(10px);
	}
	.cmd {
		flex: 1;
		font: 12.5px var(--mono);
		color: var(--ink-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.prompt {
		color: var(--faint);
	}
	.hint {
		font-family: var(--sans);
		color: var(--faint);
		font-size: 12px;
	}
	.buttons {
		display: flex;
		gap: 8px;
	}
	.buttons button {
		all: unset;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 9px;
		padding: 8px 13px;
		border-radius: 8px;
		font-size: 13px;
		font-weight: 500;
		color: var(--ink);
		background: var(--panel);
		border: 1px solid var(--line-strong);
	}
	.buttons button:hover {
		border-color: var(--ink-2);
	}
	.buttons button:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.buttons button.primary {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--panel);
	}
	.buttons button[aria-disabled='true'] {
		opacity: 0.45;
		cursor: not-allowed;
	}
	kbd {
		font: 10.5px var(--mono);
		padding: 0 5px;
		border-radius: 3px;
		border: 1px solid currentColor;
		opacity: 0.55;
	}
	.nothing {
		display: grid;
		place-items: center;
		color: var(--faint);
		font-size: 13px;
	}
</style>
