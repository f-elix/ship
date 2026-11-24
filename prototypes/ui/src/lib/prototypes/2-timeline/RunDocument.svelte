<script lang="ts">
	import { fade } from 'svelte/transition';
	import { NOW, clock, commandFor, describe, projectByKey, relTime } from '#lib';
	import type { Run } from '#lib';
	import { ESCALATION, count, derivePhases, findingById, runNow, summarize, type Phase } from './phases.ts';
	import { getTimeline } from './state.svelte.ts';
	import { statusWord, tone } from './words.ts';
	import PhaseNode from './PhaseNode.svelte';
	import FindingCard from './FindingCard.svelte';

	let { run }: { run: Run } = $props();

	const tl = getTimeline();

	let project = $derived(projectByKey(run.projectKey));
	let now = $derived(runNow(run, NOW));
	let items = $derived(derivePhases(run, now));
	let phases = $derived(items.filter((i): i is Phase => i.type === 'phase'));
	let summary = $derived(summarize(run, items));
	let command = $derived(commandFor(run));
	let lastEvent = $derived(run.events.at(-1));
	let terminal = $derived(run.status !== 'running' && run.status !== 'waiting');
	let followUps = $derived((tl.followUps[run.runId] ?? []).map((id) => tl.get(id)).filter((r) => r !== undefined));

	let openMustFix = $derived.by(() => {
		const triage = phases.findLast((p) => p.kind === 'triage');
		const t = triage?.events.find((e) => e._tag === 'FindingsTriaged');
		return t?._tag === 'FindingsTriaged' ? t.mustFix : [];
	});

	let toggles = $state<Record<string, boolean>>({});

	const defaultOpen = (p: Phase) =>
		p.status !== 'done' || (terminal && p === phases.at(-1) && run.status !== 'done');

	const isOpen = (p: Phase) => toggles[p.id] ?? defaultOpen(p);

	const setAll = (open: boolean) => {
		toggles = Object.fromEntries(phases.map((p) => [p.id, open]));
	};

	let allOpen = $derived(phases.every(isOpen));

	const askCancel = () =>
		tl.ask({
			title: `Cancel ${run.runId}?`,
			body: 'The current step stops and its lock permits are released. Commits already made stay on the branch; nothing is pushed.',
			command: `ship cancel ${run.runId}`,
			confirmLabel: 'Cancel run',
			tone: 'danger',
			onConfirm: () => tl.cancel(run.runId)
		});

	const askFollowUp = (kind: 'fix' | 'recheck') =>
		tl.ask({
			title: kind === 'fix' ? `Fix the findings on PR #${run.prNumber}` : `Recheck PR #${run.prNumber}`,
			body:
				kind === 'fix'
					? 'The fix agent gets the must-fix findings and nits, runs the checks, commits and pushes to the PR branch. Check the PR out first.'
					: 'The verifier asks, over the diff from the merge base to the head, whether each finding is fixed, and resolves the threads of the fixed ones.',
			command: `gh pr checkout ${run.prNumber} && ship ${kind} ${run.prNumber}`,
			confirmLabel: kind === 'fix' ? 'Start fix' : 'Start recheck',
			tone: 'default',
			onConfirm: () => tl.followUp(run.runId, kind)
		});

	const askRetry = () =>
		tl.ask({
			title: 'Retry from implement',
			body: 'ship resume retries a failed run from the step that failed, with the current env. The baseline already ran and is kept.',
			command: `ship resume ${run.runId}`,
			confirmLabel: 'Retry',
			tone: 'default',
			onConfirm: () => tl.retry(run.runId)
		});

	const askResume = () =>
		tl.ask({
			title: `Resume ${run.runId}`,
			body: 'The daemon stopped while this run was in check-fix. Resuming continues that step; finished checks are not run again.',
			command: `ship resume ${run.runId}`,
			confirmLabel: 'Resume',
			tone: 'default',
			onConfirm: () => tl.resume(run.runId)
		});
</script>

<article>
	<header class="doc-head">
		<p class="eyebrow">
			<span>{project?.name}</span>
			<span class="sep">/</span>
			<code>{run.runId}</code>
			<span class="sep">/</span>
			<span>{run.kind}</span>
		</p>
		<h1>{run.title}</h1>
		<p class="byline">
			<code>{command}</code> on branch <code>{run.branch ?? '—'}</code> in project
			<strong>{project?.name}</strong>, started {relTime(run.createdAt)}.
		</p>

		<div class="status-line">
			<span class={['status', tone(run.status)]}>
				<span class="pip" aria-hidden="true"></span>
				{statusWord(run)}
			</span>
			<code class="state">{run.state}</code>
			{#if run.escalationReason}<code class="state reason">{run.escalationReason}</code>{/if}
		</div>

		<p class="summary">{summary}</p>

		<div class="actions">
			{#if run.status === 'running' || run.status === 'waiting'}
				<button type="button" class="btn" onclick={askCancel}>Cancel run</button>
			{:else if run.status === 'escalated'}
				<button type="button" class="btn primary" onclick={() => askFollowUp('fix')}>Fix findings</button>
				<button type="button" class="btn" onclick={() => askFollowUp('recheck')}>Recheck</button>
			{:else if run.status === 'failed'}
				<button type="button" class="btn primary" onclick={askRetry}>Retry from implement</button>
			{:else if run.status === 'interrupted'}
				<button type="button" class="btn primary" onclick={askResume}>Resume</button>
			{/if}
			{#if run.prUrl}
				<a class="btn link" href={run.prUrl} target="_blank" rel="noreferrer">Open PR #{run.prNumber} ↗</a>
			{/if}
			{#if phases.length > 1}
				<button type="button" class="btn quiet" onclick={() => setAll(!allOpen)}>
					{allOpen ? 'Collapse all' : 'Expand all'}
				</button>
			{/if}
		</div>
	</header>

	<ol class="timeline">
		{#each items as item (item.id)}
			{#if item.type === 'phase'}
				<PhaseNode {run} phase={item} open={isOpen(item)} ontoggle={() => (toggles[item.id] = !isOpen(item))} />
			{:else}
				<li class="marker" in:fade>
					<span>
						{#if item.event._tag === 'RunInterrupted'}
							Interrupted at {clock(item.event.at)}; the daemon stopped.
						{:else if item.event._tag === 'RunResumed'}
							Resumed at {clock(item.event.at)} with <code>ship resume {run.runId}</code>.
						{:else}
							Cancelled at {clock(item.event.at)}.
						{/if}
					</span>
				</li>
			{/if}
		{/each}

		{#if run.status === 'running' && lastEvent}
			<li class="tail live">
				<span class="beacon" aria-hidden="true"></span>
				<span class="tail-label">Live</span>
				{#key lastEvent.seq}
					<span class="tail-text" in:fade={{ duration: 500 }}>{describe(lastEvent)}</span>
				{/key}
				<time>{clock(lastEvent.at)}</time>
			</li>
		{:else if run.status === 'waiting' && lastEvent}
			<li class="tail waiting">
				<span class="beacon" aria-hidden="true"></span>
				<span class="tail-label">Waiting</span>
				<span class="tail-text">{describe(run.events.findLast((e) => e._tag === 'LockWaiting') ?? lastEvent)}</span>
				<time>{clock(lastEvent.at)}</time>
			</li>
		{/if}
	</ol>

	{#if run.status === 'escalated' && run.escalationReason && project}
		{@const esc = ESCALATION[run.escalationReason]}
		<section class="callout amber" in:fade>
			<p class="callout-kicker">Escalated · <code>{run.escalationReason}</code></p>
			<h2>{esc.headline}.</h2>
			<p class="callout-body">{esc.body(project.caps)}</p>
			{#if openMustFix.length}
				<h3>Still open</h3>
				{#each openMustFix as id (id)}
					{@const f = findingById(run, id)}
					{#if f}<FindingCard finding={f} compact />{/if}
				{/each}
			{/if}
			{#if run.prUrl}
				<p class="callout-body">
					The draft is <a href={run.prUrl} target="_blank" rel="noreferrer">PR #{run.prNumber}</a> on
					<code>{run.branch}</code>, with {count(run.commits.length, 'commit')}. Fix the findings there, or recheck once someone has pushed a fix by hand.
				</p>
			{/if}
			<div class="actions">
				<button type="button" class="btn primary" onclick={() => askFollowUp('fix')}>Fix findings</button>
				<button type="button" class="btn" onclick={() => askFollowUp('recheck')}>Recheck</button>
			</div>
			{@render follow()}
		</section>
	{:else if run.status === 'failed'}
		{@const failedPhase = phases.findLast((p) => p.status === 'failed')}
		<section class="callout red" in:fade>
			<p class="callout-kicker">Failed{failedPhase ? ` in ${failedPhase.title.toLowerCase()}` : ''}</p>
			<h2>{run.error ?? 'The run stopped with an error.'}</h2>
			<p class="callout-body">
				Nothing was committed and no PR was opened. <code>ship resume {run.runId}</code> retries from the step that failed with the current env;
				the baseline is not run again.
			</p>
			<div class="actions">
				<button type="button" class="btn primary" onclick={askRetry}>Retry from implement</button>
			</div>
		</section>
	{:else if run.status === 'interrupted'}
		<section class="callout amber" in:fade>
			<p class="callout-kicker">Interrupted</p>
			<h2>The daemon stopped while this run was working.</h2>
			<p class="callout-body">
				<code>ship daemon restart --force</code> interrupted it during check-fix. Resuming picks up that step where it left off.
			</p>
			<div class="actions">
				<button type="button" class="btn primary" onclick={askResume}>Resume</button>
			</div>
		</section>
	{:else if run.status === 'done' || run.status === 'cancelled'}
		<footer class="colophon">
			<span class="fleuron" aria-hidden="true">❧</span>
			<p>
				{#if run.status === 'done'}
					Finished at {clock(run.updatedAt)}{run.prUrl ? '' : '.'}{#if run.prUrl}, with
						<a href={run.prUrl} target="_blank" rel="noreferrer">PR #{run.prNumber}</a> up.{/if}
				{:else}
					Cancelled at {clock(run.updatedAt)}. Nothing was pushed.
				{/if}
			</p>
		</footer>
	{/if}
</article>

{#snippet follow()}
	{#if followUps.length}
		<ul class="follow">
			{#each followUps as f (f.runId)}
				<li in:fade>
					<a href="/2-timeline/{f.runId}"><code>{f.runId}</code></a>
					<code>{commandFor(f)}</code>
					<span class={['status', tone(f.status)]}>{statusWord(f)}</span>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<style>
	article {
		width: 100%;
		max-width: 720px;
		margin: 0 auto;
	}

	.doc-head {
		padding-bottom: 34px;
		margin-bottom: 38px;
		border-bottom: 1px solid var(--rule);
	}

	.eyebrow {
		display: flex;
		gap: 8px;
		margin: 0 0 14px;
		font-size: 12.5px;
		letter-spacing: 0.04em;
		color: var(--muted);
	}

	.eyebrow .sep {
		color: var(--faint);
	}

	h1 {
		margin: 0;
		font: 500 44px/1.1 var(--serif);
		letter-spacing: -0.018em;
		text-wrap: balance;
	}

	.byline {
		margin: 14px 0 0;
		font: 17px/1.6 var(--serif);
		color: var(--ink-2);
	}

	.byline code {
		padding: 1px 5px;
		border-radius: 4px;
		background: var(--paper-sunk);
		font-size: 13.5px;
		color: var(--ink);
	}

	.byline strong {
		font-weight: 500;
		color: var(--ink);
	}

	.status-line {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 18px;
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font: 600 12px var(--sans);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
	}

	.status .pip {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: currentColor;
	}

	.status.blue {
		color: var(--blue);
	}
	.status.green {
		color: var(--green);
	}
	.status.red {
		color: var(--red);
	}
	.status.amber {
		color: var(--amber);
	}

	.state {
		font-size: 12px;
		color: var(--muted);
	}

	.state.reason {
		color: var(--amber);
	}

	.summary {
		margin: 16px 0 0;
		font: 19px/1.6 var(--serif);
		color: var(--ink);
		text-wrap: pretty;
	}

	.summary::first-letter {
		font-weight: 600;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 22px;
	}

	.btn {
		padding: 7px 14px;
		border: 1px solid var(--rule-strong);
		border-radius: 6px;
		background: var(--paper-raised);
		color: var(--ink);
		font: 500 13.5px var(--sans);
		text-decoration: none;
		cursor: pointer;
		transition:
			border-color 120ms,
			background 120ms;
	}

	.btn:hover {
		border-color: var(--ink-2);
	}

	.btn.primary {
		border-color: var(--ink);
		background: var(--ink);
		color: var(--paper-raised);
	}

	.btn.primary:hover {
		background: #3a362f;
	}

	.btn.quiet {
		margin-left: auto;
		border-color: transparent;
		background: none;
		color: var(--muted);
	}

	.btn.quiet:hover {
		color: var(--ink);
	}

	.timeline {
		position: relative;
		margin: 0 0 0 5px;
		padding: 0;
		list-style: none;
		border-left: 1px solid var(--rule-strong);
	}

	.marker {
		position: relative;
		padding: 0 0 26px 34px;
		font: italic 15px var(--serif);
		color: var(--muted);
	}

	.marker::before {
		content: '';
		position: absolute;
		left: -4px;
		top: 10px;
		width: 7px;
		height: 1px;
		background: var(--faint);
	}

	.tail {
		position: relative;
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 2px 0 6px 34px;
		font-size: 14px;
		color: var(--muted);
	}

	.beacon {
		position: absolute;
		left: -4px;
		top: 9px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--blue);
		animation: beacon 1.8s ease-in-out infinite;
	}

	.waiting .beacon {
		background: var(--amber);
	}

	@keyframes beacon {
		50% {
			opacity: 0.25;
			scale: 0.7;
		}
	}

	.tail-label {
		font: 600 11px var(--sans);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--blue);
	}

	.waiting .tail-label {
		color: var(--amber);
	}

	.tail-text {
		font: italic 15px var(--serif);
		color: var(--ink-2);
	}

	.tail time {
		margin-left: auto;
		font: 12px var(--mono);
		color: var(--faint);
	}

	.callout {
		--c: var(--amber);
		--c-soft: var(--amber-soft);
		margin: 30px 0 0 40px;
		padding: 24px 28px 24px;
		border: 1px solid color-mix(in srgb, var(--c) 30%, var(--rule));
		border-top: 3px solid var(--c);
		border-radius: 4px 4px 10px 10px;
		background: color-mix(in srgb, var(--c-soft) 45%, var(--paper-raised));
	}

	.callout.red {
		--c: var(--red);
		--c-soft: var(--red-soft);
	}

	.callout-kicker {
		margin: 0 0 6px;
		font: 600 11.5px var(--sans);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--c);
	}

	.callout-kicker code {
		text-transform: none;
		letter-spacing: 0;
	}

	.callout h2 {
		margin: 0 0 10px;
		font: 500 26px/1.25 var(--serif);
		letter-spacing: -0.01em;
	}

	.callout h3 {
		margin: 18px 0 4px;
		font: 600 11px var(--sans);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--muted);
	}

	.callout-body {
		margin: 0 0 10px;
		font: 17px/1.6 var(--serif);
		color: var(--ink-2);
	}

	.callout-body a {
		color: var(--ink);
	}

	.callout .actions {
		margin-top: 18px;
	}

	.follow {
		margin: 16px 0 0;
		padding: 12px 0 0;
		list-style: none;
		border-top: 1px solid color-mix(in srgb, var(--c) 25%, var(--rule));
	}

	.follow li {
		display: flex;
		align-items: baseline;
		gap: 12px;
		padding: 3px 0;
		font-size: 13.5px;
	}

	.follow a {
		color: var(--blue);
	}

	.follow .status {
		margin-left: auto;
		font-size: 11px;
	}

	.colophon {
		display: flex;
		align-items: baseline;
		gap: 14px;
		margin: 18px 0 0 40px;
		font: italic 17px var(--serif);
		color: var(--muted);
	}

	.colophon p {
		margin: 0;
	}

	.colophon a {
		color: var(--ink);
	}

	.fleuron {
		font-style: normal;
		font-size: 22px;
		color: var(--faint);
	}
</style>
