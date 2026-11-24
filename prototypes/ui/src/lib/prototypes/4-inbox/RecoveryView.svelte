<script lang="ts">
	import { commandFor, duration } from '#lib';
	import type { Run } from '#lib';
	import LogTail from './LogTail.svelte';
	import { resumePlans } from './data.ts';
	import { getInbox, type Entry } from './inbox.svelte.ts';

	let { entry, run }: { entry: Entry; run: Run } = $props();

	const inbox = getInbox();
	const plan = $derived(resumePlans[run.runId]);
	const failedStep = $derived(run.events.findLast((e) => e._tag === 'StepEnded' && e.outcome !== 'ok'));
	const startedStep = $derived(run.events.findLast((e) => e._tag === 'StepStarted'));
	const error = $derived(
		run.error ??
			(entry.kind === 'interrupted'
				? `daemon stopped while ${startedStep?._tag === 'StepStarted' ? startedStep.step : 'a step'} was running (ship daemon restart --force)`
				: 'unknown error')
	);
	const baselineFails = $derived(
		run.checks.filter((c) => c.baseline).flatMap((c) => c.results.filter((r) => r.exitCode !== 0))
	);
	const done = $derived(entry.status === 'archived');
</script>

<section class="recovery">
	<div class="error">
		<div class="icon" aria-hidden="true">
			<svg viewBox="0 0 20 20" width="18" height="18"
				>{#if entry.kind === 'failed'}<path d="M10 2.5 18 17H2Z M10 8v4 M10 14.2v.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />{:else}<path
						d="M7 5v10M13 5v10"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
					/>{/if}</svg
			>
		</div>
		<div>
			<p class="label">{entry.kind === 'failed' ? 'Run failed' : 'Run interrupted'} · state <code>{run.state}</code></p>
			<p class="msg">{error}</p>
			{#if failedStep?._tag === 'StepEnded'}
				<p class="meta">{failedStep.step} ran {duration(failedStep.durationMs)} · started by <code>{commandFor(run)}</code></p>
			{:else}
				<p class="meta">started by <code>{commandFor(run)}</code></p>
			{/if}
		</div>
	</div>

	{#if plan}
		<div class="plan">
			<h3>What <code>ship resume {run.runId}</code> will do</h3>
			<ol class="steps">
				{#each plan.keep as s (s)}
					<li class="keep"><span class="dot">✓</span>{s}<em>kept</em></li>
				{/each}
				<li class="redo"><span class="dot">↻</span>{plan.redo}<em>{entry.kind === 'failed' ? 'retried' : 'restarted'}</em></li>
				{#each plan.then as s (s)}
					<li class="then"><span class="dot"></span>{s}</li>
				{/each}
			</ol>
			<p class="note">{plan.note}</p>
			<div class="go">
				<button type="button" class="primary" disabled={done} onclick={() => inbox.resume(entry)}>
					{done ? entry.resolution : entry.kind === 'failed' ? 'Retry from implement' : 'Resume'}
					{#if !done}<kbd>r</kbd>{/if}
				</button>
				<code class="cmd">$ ship resume {run.runId}</code>
			</div>
		</div>
	{/if}

	{#if baselineFails.length}
		<div class="aside">
			<b>Also failing before the change:</b>
			{#each baselineFails as f (f.name)}
				<code>{f.name}</code> (exit {f.exitCode})
			{/each}
			— this will be listed in the PR body, not fixed.
			{#if baselineFails[0]?.outputTail}<pre>{baselineFails[0].outputTail}</pre>{/if}
		</div>
	{/if}

	<div>
		<h3>Last 10 log lines</h3>
		<LogTail events={run.events} />
	</div>
</section>

<style>
	.recovery {
		display: grid;
		gap: 24px;
	}
	h3 {
		margin: 0 0 10px;
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--muted);
	}
	h3 code {
		font: 600 12px var(--mono);
		text-transform: none;
		letter-spacing: 0;
		color: var(--ink);
	}
	.error {
		display: grid;
		grid-template-columns: 36px 1fr;
		gap: 14px;
		padding: 16px 18px;
		border-radius: 10px;
		background: var(--mf-wash);
		border: 1px solid color-mix(in oklab, var(--mf) 25%, transparent);
	}
	.icon {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--panel);
		color: var(--mf);
	}
	.label {
		margin: 0;
		font-size: 11.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--mf);
		font-weight: 600;
	}
	.label code {
		text-transform: none;
		letter-spacing: 0;
		font: 11.5px var(--mono);
	}
	.msg {
		margin: 4px 0 6px;
		font: 500 15px/1.45 var(--mono);
		color: var(--ink);
	}
	.meta {
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}
	.meta code {
		font: 11.5px var(--mono);
	}
	.plan {
		padding: 18px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel);
	}
	.steps {
		list-style: none;
		margin: 6px 0 14px;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0;
	}
	.steps li {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 6px 14px 6px 10px;
		font: 12.5px var(--mono);
		color: var(--muted);
		position: relative;
	}
	.steps li + li::before {
		content: '';
		position: absolute;
		left: -6px;
		width: 10px;
		height: 1px;
		background: var(--line-strong);
	}
	.steps em {
		font: italic 11px var(--sans);
		color: var(--faint);
	}
	.dot {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: 11px;
		border: 1.5px solid var(--line-strong);
	}
	.keep {
		color: var(--faint) !important;
	}
	.keep .dot {
		border-color: #23744a;
		color: #23744a;
	}
	.redo {
		color: var(--ink) !important;
		font-weight: 600;
		background: var(--accent-wash);
		border-radius: 999px;
	}
	.redo .dot {
		border-color: var(--accent);
		background: var(--accent);
		color: white;
	}
	.note {
		margin: 0 0 16px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--ink-2);
		max-width: 68ch;
	}
	.go {
		display: flex;
		align-items: center;
		gap: 14px;
	}
	.primary {
		all: unset;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 9px 16px;
		border-radius: 8px;
		background: var(--accent);
		color: white;
		font-weight: 600;
		font-size: 13.5px;
		box-shadow: 0 1px 0 rgb(0 0 0 / 0.1), inset 0 1px 0 rgb(255 255 255 / 0.15);
	}
	.primary:hover {
		filter: brightness(1.08);
	}
	.primary:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.primary:disabled {
		cursor: default;
		background: var(--line);
		color: var(--muted);
		box-shadow: none;
	}
	.primary kbd {
		font: 10.5px var(--mono);
		padding: 0 5px;
		border-radius: 3px;
		background: rgb(255 255 255 / 0.2);
	}
	.cmd {
		font: 12px var(--mono);
		color: var(--muted);
	}
	.aside {
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--ink-2);
		padding: 12px 16px;
		border-left: 3px solid var(--nit);
		background: var(--nit-wash);
		border-radius: 0 8px 8px 0;
	}
	.aside code {
		font: 12px var(--mono);
	}
	.aside pre {
		margin: 10px 0 0;
		font: 11.5px/1.55 var(--mono);
		color: var(--muted);
		white-space: pre-wrap;
	}
</style>
