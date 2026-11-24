<script lang="ts">
	import { clock, commandFor, describe, duration, elapsed, shortSha, usd } from '#lib';
	import type { Finding, Run, Severity } from '#lib';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { Board } from './board.svelte.ts';
	import StageTrack from './StageTrack.svelte';
	import {
		SEVERITIES,
		SEVERITY_COLOR,
		STATUS_STYLE,
		TONE_COLOR,
		ago,
		attention,
		eventTone,
		projectColor,
		projectOf,
		roundLabel
	} from './model.ts';
	import type { ConfirmRequest } from './model.ts';

	let {
		run,
		board,
		live,
		onclose,
		onconfirm,
		onopen
	}: {
		run: Run;
		board: Board;
		live: boolean;
		onclose: () => void;
		onconfirm: (c: ConfirmRequest) => void;
		onopen: (id: string) => void;
	} = $props();

	type Tab = 'overview' | 'checks' | 'findings' | 'log';

	// Writable deriveds: reset whenever another run is opened.
	let tab = $derived.by((): Tab => {
		void run.runId;
		return 'overview';
	});
	let openCell = $derived.by((): string | null => {
		void run.runId;
		return null;
	});
	let newestFirst = $state(true);
	let quiet = $state(false);
	let showDisproved = $state(false);

	const project = $derived(projectOf(run));
	const alert = $derived(attention(run));
	const status = $derived(STATUS_STYLE[run.status]);
	const command = $derived(commandFor(run));
	const active = $derived(run.status === 'running' || run.status === 'waiting');
	const round = $derived(roundLabel(run));

	// --- overview
	const clefDecisions = $derived(
		run.events.flatMap((e) => (e._tag === 'ClefDecision' ? [e] : []))
	);
	const costByStep = $derived.by(() => {
		const m = new Map<string, number>();
		for (const e of run.events) if (e._tag === 'AgentCost') m.set(e.step, (m.get(e.step) ?? 0) + e.costUsd);
		return [...m.entries()].sort((a, b) => b[1] - a[1]);
	});
	const costMax = $derived(Math.max(0.01, ...costByStep.map(([, v]) => v)));
	const prEvent = $derived(run.events.findLast((e) => e._tag === 'PrOpened'));

	// --- checks
	const checkNames = $derived(project.checks.map((c) => c.name));
	const baselineFailed = $derived(
		new Set(
			run.checks
				.filter((r) => r.baseline)
				.flatMap((r) => r.results.filter((x) => x.exitCode !== 0).map((x) => x.name))
		)
	);
	const waitingCheck = $derived.by(() => {
		if (run.state !== 'checks.waiting') return null;
		const e = run.events.findLast((x) => x._tag === 'LockWaiting');
		return e?._tag === 'LockWaiting' ? e : null;
	});
	const failingCount = $derived(
		run.checks.reduce(
			(n, r) => n + r.results.filter((x) => x.exitCode !== 0 && !r.baseline).length,
			0
		)
	);

	// --- findings
	const grouped = $derived(
		SEVERITIES.map((s) => ({
			severity: s,
			items: run.findings.filter((f) => f.severity === s).sort((a, b) => b.round - a.round)
		}))
	);
	const reportedSoFar = $derived(
		run.events.reduce((n, e) => (e._tag === 'FindingsReported' ? n + e.count : n), 0)
	);
	const verdictKind = (f: Finding) => {
		const k = f.verdict.split(':')[0].replace(/\.$/, '');
		return ['traced', 'structural', 'code reading'].includes(k) ? k : 'verified';
	};
	const verdictRest = (f: Finding) => f.verdict.split(':').slice(1).join(':').trim();

	// --- log
	const NOISE = new Set(['LockAcquired', 'LockReleased', 'AgentCost', 'CheckStarted']);
	const logEvents = $derived.by(() => {
		const list = quiet ? run.events.filter((e) => !NOISE.has(e._tag)) : run.events;
		return newestFirst ? [...list].reverse() : list;
	});

	// --- actions
	interface Action {
		label: string;
		tone: 'primary' | 'secondary' | 'danger';
		href?: string;
		onclick?: () => void;
	}

	const cancel = () =>
		onconfirm({
			title: `Cancel ${run.runId}?`,
			body: `The run stops where it is and ends as cancelled. Commits already made stay on ${run.branch ?? 'the branch'}.`,
			command: `ship cancel ${run.runId}`,
			confirmLabel: 'Cancel run',
			tone: 'danger',
			action: () => board.cancel(run.runId)
		});

	const actions = $derived.by((): Action[] => {
		const a: Action[] = [];
		const prLink = run.prUrl ? [{ label: `Open PR #${run.prNumber ?? ''}`, tone: 'secondary' as const, href: run.prUrl }] : [];
		switch (run.status) {
			case 'running':
			case 'waiting':
				a.push({ label: 'Cancel run', tone: 'danger', onclick: cancel });
				break;
			case 'interrupted':
				a.push({ label: 'Resume', tone: 'primary', onclick: () => board.resume(run.runId) });
				a.push({ label: 'Cancel', tone: 'danger', onclick: cancel });
				break;
			case 'failed':
				a.push({ label: 'Resume from failed step', tone: 'primary', onclick: () => board.resume(run.runId) });
				break;
			case 'escalated':
				a.push({
					label: 'Fix findings',
					tone: 'primary',
					onclick: () =>
						onconfirm({
							title: `Fix the findings on PR #${run.prNumber}?`,
							body: 'The fix agent takes the must-fix findings and nits, runs the checks, commits and pushes to the PR branch.',
							command: `gh pr checkout ${run.prNumber} && ship fix ${run.prNumber}`,
							confirmLabel: 'Start fix',
							tone: 'primary',
							action: () => onopen(board.followUp(run, 'fix', project))
						})
				});
				a.push({ label: 'Recheck', tone: 'secondary', onclick: () => onopen(board.followUp(run, 'recheck', project)) });
				a.push(...prLink);
				break;
			case 'done':
				a.push(...prLink);
				if (run.prNumber)
					a.push({ label: 'Recheck', tone: 'secondary', onclick: () => onopen(board.followUp(run, 'recheck', project)) });
				break;
			case 'cancelled':
				a.push({ label: 'Start again', tone: 'primary', onclick: () => onopen(board.restart(run, project)) });
				break;
		}
		return a;
	});

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Clipboard can be unavailable; the toast still confirms intent in the prototype.
		}
		board.toast({ title: 'Copied', detail: text, tone: 'info' });
	}
</script>

<aside
	class="drawer"
	style:--pc={projectColor(run)}
	transition:fly={{ x: 48, duration: 260, easing: cubicOut }}
	aria-label="Run {run.runId}"
>
	<header>
		<div class="row1">
			<span class="ptag"><i></i>{project.name}</span>
			<span class="kind">{run.kind}</span>
			<span class="status" style:color={status.fg} style:background={status.bg}>
				{#if active}<i></i>{/if}{run.status}
			</span>
			{#if live}<span class="live">live</span>{/if}
			<button type="button" class="rid" onclick={() => copy(run.runId)} title="Copy run id">{run.runId}</button>
			<button type="button" class="close" onclick={onclose} aria-label="Close drawer">
				<svg viewBox="0 0 16 16" width="16" height="16"
					><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg
				>
			</button>
		</div>
		<h2>{run.title}</h2>
		<div class="sub">
			{#if run.branch}<span class="mono">{run.branch}</span><span class="sep">·</span>{/if}
			<span>state <code>{run.state}</code></span><span class="sep">·</span>
			<span>started {ago(run.createdAt)}</span>
		</div>
		<StageTrack {run} labels />
		{#if actions.length}
			<div class="actions">
				{#each actions as a (a.label)}
					{#if a.href}
						<a class={['btn', a.tone]} href={a.href} target="_blank" rel="noreferrer">
							{a.label}
							<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
								><path d="M6 3h7v7M13 3 5 11" fill="none" stroke="currentColor" stroke-width="1.6" /></svg
							>
						</a>
					{:else}
						<button type="button" class={['btn', a.tone]} onclick={a.onclick}>{a.label}</button>
					{/if}
				{/each}
			</div>
		{/if}
		<nav class="tabs" aria-label="Run detail">
			{#each [['overview', 'Overview', null], ['checks', 'Checks', failingCount || null], ['findings', 'Findings', run.findings.length || null], ['log', 'Log', run.events.length]] as const as [id, label, n] (id)}
				<button type="button" class={['tab', tab === id && 'on']} onclick={() => (tab = id)}>
					{label}
					{#if n}<span class="n">{n}</span>{/if}
				</button>
			{/each}
		</nav>
	</header>

	<div class="body">
		{#if tab === 'overview'}
			{#if alert}
				<div class="callout">
					<div class="ctitle">
						<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"
							><path d="M8 1.8 15 14H1Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /><path
								d="M8 6v3.5M8 11.6v.1"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
							/></svg
						>
						{alert.label}
						{#if run.escalationReason}<code>{run.escalationReason}</code>{/if}
					</div>
					<p>{alert.detail}</p>
				</div>
			{/if}

			<div class="stats">
				<div class="stat"><span>Cost</span><b>{usd(run.costUsd)}</b></div>
				<div class="stat"><span>Elapsed</span><b>{elapsed(run.createdAt, run.updatedAt)}</b></div>
				<div class="stat"><span>Round</span><b>{round ?? '—'}</b></div>
				<div class="stat">
					<span>Diff</span>
					<b
						><em class="add">+{run.diffStat.additions}</em>
						<em class="del">−{run.diffStat.deletions}</em></b
					>
					<small>{run.diffStat.files} files</small>
				</div>
			</div>

			<section>
				<h4>Command</h4>
				<div class="cmd">
					<span class="cwd">{run.cwd}</span>
					<code><span class="dollar">$</span> {command}</code>
					<button type="button" onclick={() => copy(command)}>Copy</button>
				</div>
			</section>

			{#if run.prUrl || prEvent}
				<section>
					<h4>Pull request</h4>
					<a class="prcard" href={run.prUrl ?? ''} target="_blank" rel="noreferrer">
						<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
							><circle cx="4" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3" /><circle
								cx="4"
								cy="12.5"
								r="1.6"
								fill="none"
								stroke="currentColor"
								stroke-width="1.3"
							/><circle cx="12" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3" /><path
								d="M4 5v6M12 11V6.5A2 2 0 0 0 10 4.5H7.5"
								fill="none"
								stroke="currentColor"
								stroke-width="1.3"
							/></svg
						>
						<span class="prtitle">#{run.prNumber} {run.title}</span>
						{#if prEvent?._tag === 'PrOpened' && prEvent.draft}<span class="draft">draft</span>{/if}
						<span class="url">{run.prUrl?.replace('https://', '')}</span>
					</a>
				</section>
			{/if}

			{#if run.commits.length}
				<section>
					<h4>Commits <span class="count">{run.commits.length}</span></h4>
					<ul class="commits">
						{#each run.commits as c (c.sha)}
							<li><code>{shortSha(c.sha)}</code>{c.message}</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if clefDecisions.length}
				<section>
					<h4>Clef decisions</h4>
					<ul class="clef">
						{#each clefDecisions as d (d.seq)}
							<li>
								<div class="clefhead">
									<span class="decision">{d.decision}</span>
									<span class="prob">p={d.probability.toFixed(2)}</span>
								</div>
								<div class="pbar"><i style:width="{d.probability * 100}%"></i></div>
								<p>{d.detail}</p>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if costByStep.length}
				<section>
					<h4>Cost by step</h4>
					<ul class="costs">
						{#each costByStep as [step, v] (step)}
							<li>
								<span class="step">{step}</span>
								<span class="cbar"><i style:width="{(v / costMax) * 100}%"></i></span>
								<span class="cv">{usd(v)}</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{:else if tab === 'checks'}
			{#if run.checks.length === 0}
				<p class="empty">No checks have run{run.kind === 'review' || run.kind === 'recheck' ? ' — this kind of run does not run checks' : ' yet'}.</p>
			{:else}
				<div class="matrix" style:--n={checkNames.length}>
					<div class="mhead corner">round</div>
					{#each project.checks as c (c.name)}
						<div class="mhead" title={c.run}>
							<span>{c.name}</span>
							<code class="lockb">{c.lock}</code>
						</div>
					{/each}
					{#each run.checks as row (`${row.baseline}:${row.round}:${row.attempt}`)}
						{@const rowKey = `${row.baseline}:${row.round}:${row.attempt}`}
						{@const isLast = row === run.checks.at(-1)}
						<div class="rlabel">
							<b>{row.baseline ? 'baseline' : `round ${row.round}`}</b>
							<small>{row.baseline ? 'before change' : row.attempt ? `after check-fix ${row.attempt}` : 'first pass'}</small>
						</div>
						{#each checkNames as name (name)}
							{@const r = row.results.find((x) => x.name === name)}
							{@const key = `${rowKey}:${name}`}
							{#if r && r.exitCode === 0}
								<div class="cell pass" title="exit 0 · {duration(r.durationMs)}">
									<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"
										><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg
									>
									<small>{duration(r.durationMs)}</small>
								</div>
							{:else if r}
								{@const pre = !row.baseline && baselineFailed.has(name)}
								<button
									type="button"
									class={['cell', 'fail', pre && 'pre', openCell === key && 'open']}
									onclick={() => (openCell = openCell === key ? null : key)}
									title={pre ? 'Failed in the baseline too; not held to it' : `exit ${r.exitCode}`}
								>
									<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"
										><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg
									>
									<small>exit {r.exitCode}</small>
								</button>
							{:else if isLast && waitingCheck?.check === name}
								<div class="cell waiting" title="waiting for {waitingCheck.resource}">
									<small>waiting · {waitingCheck.resource}</small>
								</div>
							{:else}
								<div class="cell none">—</div>
							{/if}
						{/each}
						{#each checkNames as name (name)}
							{@const r = row.results.find((x) => x.name === name)}
							{#if openCell === `${rowKey}:${name}` && r?.outputTail}
								<div class="tail" transition:fly={{ y: -6, duration: 160 }}>
									<div class="tailhead">
										<span><b>{name}</b> · {project.checks.find((c) => c.name === name)?.run}</span>
										{#if !row.baseline && baselineFailed.has(name)}
											<span class="prenote">failing before this change, not held to it</span>
										{/if}
									</div>
									<pre>{r.outputTail}</pre>
								</div>
							{/if}
						{/each}
					{/each}
				</div>
				<p class="legend">
					<span><i class="lg pass"></i>passed</span>
					<span><i class="lg fail"></i>failed</span>
					<span><i class="lg pre"></i>failed in baseline too</span>
					<span>Click a failed cell for its output.</span>
				</p>
			{/if}
		{:else if tab === 'findings'}
			{#if run.findings.length === 0}
				<p class="empty">
					{#if reportedSoFar && active}
						{reportedSoFar} finding{reportedSoFar === 1 ? '' : 's'} reported so far. They show here once the verifier has traced them.
					{:else}
						No findings.
					{/if}
				</p>
			{:else}
				{#each grouped as g (g.severity)}
					{#if g.items.length}
						<section class="sev" style:--sc={SEVERITY_COLOR[g.severity as Severity]}>
							<h4><i></i>{g.severity} <span class="count">{g.items.length}</span></h4>
							{#each g.items as f (f.id)}
								<article class="finding">
									<div class="fhead">
										<span class="reviewer">{f.reviewer}</span>
										<code class="file">{f.file}{f.line ? `:${f.line}` : ''}</code>
										<span class="fround">r{f.round} · {f.id}</span>
									</div>
									<p class="claim">{f.claim}</p>
									<p class="evidence">{f.evidence}</p>
									<div class="verdict">
										<span class="vk">{verdictKind(f)}</span>
										<span>{verdictRest(f) || f.verdict}</span>
									</div>
									{#if f.repeats}<div class="repeats">repeats {f.repeats} from an earlier round</div>{/if}
								</article>
							{/each}
						</section>
					{/if}
				{/each}
			{/if}
			{#if run.disproved.length}
				<section class="disproved">
					<button type="button" class="disbtn" onclick={() => (showDisproved = !showDisproved)}>
						{showDisproved ? '▾' : '▸'} Disproved by the verifier <span class="count">{run.disproved.length}</span>
					</button>
					{#if showDisproved}
						{#each run.disproved as d (d.claim)}
							<article class="dis" transition:fly={{ y: -4, duration: 140 }}>
								<div class="fhead">
									<span class="reviewer">{d.reviewer}</span>
									<code class="file">{d.file}{d.line ? `:${d.line}` : ''}</code>
								</div>
								<p class="claim struck">{d.claim}</p>
								<p class="evidence">{d.reason}</p>
							</article>
						{/each}
					{/if}
				</section>
			{/if}
		{:else}
			<div class="logbar">
				<label><input type="checkbox" bind:checked={newestFirst} /> newest first</label>
				<label><input type="checkbox" bind:checked={quiet} /> hide locks, costs, check starts</label>
				<span class="lcount">{logEvents.length} events</span>
			</div>
			<ol class="log">
				{#each logEvents as e (e.seq)}
					<li style:--tc={TONE_COLOR[eventTone(e)]}>
						<time>{clock(e.at)}</time>
						<i></i>
						<span class="tag">{e._tag}</span>
						<span class="desc">{describe(e)}</span>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</aside>

<style>
	.drawer {
		position: fixed;
		top: 68px;
		right: 8px;
		bottom: 8px;
		width: 580px;
		background: var(--card);
		border-radius: 16px;
		border: 1px solid var(--line);
		box-shadow:
			0 24px 60px -12px rgba(22, 26, 44, 0.28),
			0 4px 12px rgba(22, 26, 44, 0.06);
		display: flex;
		flex-direction: column;
		z-index: 30;
		overflow: hidden;
	}
	header {
		padding: 16px 20px 0;
		display: grid;
		gap: 12px;
		border-bottom: 1px solid var(--line);
		background: linear-gradient(180deg, color-mix(in srgb, var(--pc) 6%, white), white 70%);
	}
	.row1 {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 11.5px;
	}
	.ptag {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-weight: 600;
		color: color-mix(in srgb, var(--pc) 75%, black);
		background: color-mix(in srgb, var(--pc) 12%, white);
		padding: 2px 8px 2px 7px;
		border-radius: 999px;
	}
	.ptag i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--pc);
	}
	.kind {
		font: 600 11px var(--mono);
		border: 1px solid var(--line);
		padding: 1px 6px;
		border-radius: 5px;
		color: var(--ink-2);
		background: white;
	}
	.status {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 999px;
	}
	.status i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
		animation: blink 1.2s infinite;
	}
	.live {
		font-size: 9.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent);
	}
	.rid {
		all: unset;
		margin-left: auto;
		font: 500 12px var(--mono);
		color: var(--ink-2);
		padding: 3px 7px;
		border-radius: 6px;
		cursor: copy;
	}
	.rid:hover {
		background: var(--canvas);
	}
	.close {
		all: unset;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 8px;
		color: var(--ink-2);
		cursor: pointer;
	}
	.close:hover {
		background: var(--canvas);
		color: var(--ink);
	}
	h2 {
		margin: 0;
		font-size: 19px;
		line-height: 1.3;
		font-weight: 650;
		letter-spacing: -0.01em;
	}
	.sub {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		font-size: 12px;
		color: var(--ink-2);
		margin-top: -6px;
	}
	.sub code,
	.mono {
		font-family: var(--mono);
		font-size: 11.5px;
	}
	.sep {
		color: var(--ink-3);
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.btn {
		all: unset;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		font-weight: 600;
		padding: 7px 12px;
		border-radius: 8px;
		cursor: pointer;
		transition:
			background 120ms,
			box-shadow 120ms,
			transform 120ms;
	}
	.btn:active {
		transform: translateY(1px);
	}
	.btn:focus-visible,
	.tab:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.btn.primary {
		background: var(--accent);
		color: white;
		box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--accent) 70%, transparent);
	}
	.btn.primary:hover {
		background: #4b3bf0;
	}
	.btn.secondary {
		background: white;
		color: var(--ink);
		box-shadow:
			inset 0 0 0 1px var(--line),
			var(--shadow-sm);
	}
	.btn.secondary:hover {
		box-shadow:
			inset 0 0 0 1px var(--line-2),
			var(--shadow-md);
	}
	.btn.danger {
		color: #b42328;
		background: white;
		box-shadow: inset 0 0 0 1px #f5c9c9;
	}
	.btn.danger:hover {
		background: #fff3f3;
	}
	.tabs {
		display: flex;
		gap: 2px;
		margin: 2px -4px 0;
	}
	.tab {
		all: unset;
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 9px 10px 11px;
		font-size: 13px;
		font-weight: 500;
		color: var(--ink-2);
		cursor: pointer;
	}
	.tab:hover {
		color: var(--ink);
	}
	.tab.on {
		color: var(--ink);
		font-weight: 600;
	}
	.tab.on::after {
		content: '';
		position: absolute;
		left: 8px;
		right: 8px;
		bottom: -1px;
		height: 2px;
		border-radius: 2px;
		background: var(--accent);
	}
	.n,
	.count {
		font-size: 10.5px;
		font-weight: 650;
		color: var(--ink-2);
		background: var(--canvas);
		padding: 1px 6px;
		border-radius: 999px;
	}
	.body {
		flex: 1;
		overflow: auto;
		padding: 18px 20px 28px;
		display: grid;
		align-content: start;
		gap: 20px;
	}
	section {
		display: grid;
		gap: 9px;
	}
	h4 {
		margin: 0;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--ink-3);
		font-weight: 650;
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.empty {
		color: var(--ink-2);
		font-size: 13px;
		background: var(--canvas);
		padding: 18px;
		border-radius: 10px;
		margin: 0;
	}
	.callout {
		background: #fff3f2;
		border: 1px solid #f9d3d0;
		border-radius: 12px;
		padding: 12px 14px;
		color: #8f1c21;
	}
	.ctitle {
		display: flex;
		align-items: center;
		gap: 7px;
		font-weight: 650;
		font-size: 13.5px;
	}
	.ctitle code {
		font: 500 11px var(--mono);
		background: white;
		padding: 1px 6px;
		border-radius: 5px;
		margin-left: auto;
	}
	.callout p {
		margin: 6px 0 0;
		font-size: 12.5px;
		line-height: 1.5;
		color: #a3353a;
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 8px;
	}
	.stat {
		display: grid;
		gap: 3px;
		background: var(--canvas);
		border-radius: 10px;
		padding: 10px 12px;
	}
	.stat span {
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-3);
		font-weight: 600;
	}
	.stat b {
		font-size: 15px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	.stat small {
		font-size: 11px;
		color: var(--ink-3);
	}
	em {
		font-style: normal;
	}
	.add {
		color: var(--ok);
	}
	.del {
		color: var(--danger);
	}
	.cmd {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 2px 10px;
		align-items: center;
		background: #15172a;
		color: #e7e8f5;
		border-radius: 10px;
		padding: 10px 12px;
	}
	.cwd {
		grid-column: 1;
		font: 11px var(--mono);
		color: #8b8fb3;
	}
	.cmd code {
		font: 12.5px var(--mono);
	}
	.dollar {
		color: #8d7dff;
	}
	.cmd button {
		all: unset;
		grid-row: 1 / 3;
		grid-column: 2;
		font-size: 11.5px;
		font-weight: 600;
		padding: 5px 9px;
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.08);
		cursor: pointer;
	}
	.cmd button:hover {
		background: rgba(255, 255, 255, 0.16);
	}
	.prcard {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 2px 10px;
		align-items: center;
		color: var(--ink);
		text-decoration: none;
		border: 1px solid var(--line);
		border-radius: 10px;
		padding: 10px 12px;
		transition: box-shadow 140ms;
	}
	.prcard:hover {
		box-shadow: var(--shadow-md);
	}
	.prcard svg {
		color: var(--ok);
	}
	.prtitle {
		font-weight: 600;
		font-size: 13px;
	}
	.draft {
		font-size: 10.5px;
		font-weight: 600;
		color: var(--ink-2);
		background: var(--canvas);
		padding: 1px 7px;
		border-radius: 999px;
	}
	.url {
		grid-column: 2 / -1;
		font: 11px var(--mono);
		color: var(--ink-3);
	}
	.commits {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
		font-size: 13px;
	}
	.commits li {
		display: flex;
		gap: 10px;
		align-items: baseline;
	}
	.commits code {
		font: 11.5px var(--mono);
		color: var(--accent);
		background: var(--accent-soft);
		padding: 1px 6px;
		border-radius: 5px;
	}
	.clef {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 10px;
	}
	.clef li {
		border: 1px solid var(--line);
		border-radius: 10px;
		padding: 10px 12px;
		display: grid;
		gap: 6px;
	}
	.clefhead {
		display: flex;
		justify-content: space-between;
		font-size: 12.5px;
	}
	.decision {
		font-weight: 600;
	}
	.prob {
		font: 600 11.5px var(--mono);
		color: #8f3bb8;
	}
	.pbar {
		height: 4px;
		background: var(--canvas);
		border-radius: 4px;
		overflow: hidden;
	}
	.pbar i {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, #c77dea, #8f3bb8);
		border-radius: 4px;
	}
	.clef p {
		margin: 0;
		font-size: 12px;
		color: var(--ink-2);
	}
	.costs {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.costs li {
		display: grid;
		grid-template-columns: 80px 1fr 52px;
		gap: 10px;
		align-items: center;
		font-size: 12px;
	}
	.step {
		font-family: var(--mono);
		color: var(--ink-2);
	}
	.cbar {
		height: 8px;
		background: var(--canvas);
		border-radius: 4px;
		overflow: hidden;
	}
	.cbar i {
		display: block;
		height: 100%;
		background: color-mix(in srgb, var(--accent) 55%, white);
		border-radius: 4px;
	}
	.cv {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	/* checks */
	.matrix {
		display: grid;
		grid-template-columns: 120px repeat(var(--n), 1fr);
		gap: 4px;
	}
	.mhead {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		font-size: 12px;
		font-weight: 600;
		padding: 4px 0 6px;
	}
	.mhead.corner {
		justify-content: flex-start;
		color: var(--ink-3);
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.lockb {
		font: 500 9.5px var(--mono);
		color: var(--ink-3);
		background: var(--canvas);
		padding: 0 4px;
		border-radius: 3px;
	}
	.rlabel {
		display: grid;
		align-content: center;
		font-size: 12px;
		line-height: 1.25;
	}
	.rlabel small {
		color: var(--ink-3);
		font-size: 10.5px;
	}
	.cell {
		all: unset;
		box-sizing: border-box;
		display: grid;
		place-items: center;
		gap: 1px;
		height: 46px;
		border-radius: 8px;
		font-size: 10.5px;
	}
	.cell small {
		font-size: 10px;
		opacity: 0.8;
	}
	.cell.pass {
		background: #e9f8f0;
		color: #0d7a50;
	}
	.cell.fail {
		background: #ffeceb;
		color: #c0262c;
		cursor: pointer;
		box-shadow: inset 0 0 0 1px #f7c6c4;
		transition: transform 120ms;
	}
	.cell.fail:hover {
		transform: scale(1.03);
	}
	.cell.fail.pre {
		background: #fff4dc;
		color: #8a5300;
		box-shadow: inset 0 0 0 1px #f3dca8;
	}
	.cell.fail.open {
		box-shadow: inset 0 0 0 2px currentColor;
	}
	.cell.waiting {
		background: repeating-linear-gradient(-45deg, #fff4dc 0 6px, #fdedc9 6px 12px);
		color: #8a5300;
		font-weight: 600;
	}
	.cell.none {
		background: var(--canvas);
		color: var(--ink-3);
	}
	.tail {
		grid-column: 1 / -1;
		background: #15172a;
		border-radius: 10px;
		overflow: hidden;
		margin: 2px 0 6px;
	}
	.tailhead {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		font: 11px var(--mono);
		color: #a5a9c9;
		padding: 8px 12px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.07);
	}
	.tailhead b {
		color: white;
	}
	.prenote {
		color: #f5c26b;
	}
	pre {
		margin: 0;
		padding: 10px 12px 12px;
		font: 11.5px/1.55 var(--mono);
		color: #f0b5b5;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		font-size: 11.5px;
		color: var(--ink-3);
		margin: 0;
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.lg {
		width: 10px;
		height: 10px;
		border-radius: 3px;
	}
	.lg.pass {
		background: #bfe9d3;
	}
	.lg.fail {
		background: #f7c6c4;
	}
	.lg.pre {
		background: #f3dca8;
	}

	/* findings */
	.sev h4 {
		color: color-mix(in srgb, var(--sc) 85%, black);
	}
	.sev h4 i {
		width: 9px;
		height: 9px;
		border-radius: 3px;
		background: var(--sc);
	}
	.finding,
	.dis {
		border: 1px solid var(--line);
		border-left: 3px solid var(--sc);
		border-radius: 10px;
		padding: 11px 13px;
		display: grid;
		gap: 7px;
	}
	.dis {
		border-left-color: var(--line-2);
		background: var(--canvas);
	}
	.fhead {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11.5px;
		min-width: 0;
	}
	.reviewer {
		font-weight: 650;
		color: var(--ink);
	}
	.file {
		font: 11px var(--mono);
		color: var(--ink-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fround {
		margin-left: auto;
		font: 10.5px var(--mono);
		color: var(--ink-3);
		flex: none;
	}
	.claim {
		margin: 0;
		font-size: 13px;
		line-height: 1.45;
		font-weight: 500;
	}
	.struck {
		text-decoration: line-through;
		color: var(--ink-2);
	}
	.evidence {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--ink-2);
	}
	.verdict {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 11.5px;
		color: var(--ink-2);
		background: var(--canvas);
		border-radius: 7px;
		padding: 6px 8px;
	}
	.vk {
		flex: none;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #0d6b47;
		background: #dff4e9;
		padding: 1px 6px;
		border-radius: 4px;
	}
	.repeats {
		font-size: 11.5px;
		font-weight: 600;
		color: #b42328;
	}
	.disbtn {
		all: unset;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink-2);
		cursor: pointer;
	}

	/* log */
	.logbar {
		display: flex;
		gap: 16px;
		align-items: center;
		font-size: 12px;
		color: var(--ink-2);
	}
	.logbar label {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		cursor: pointer;
	}
	.logbar input {
		accent-color: var(--accent);
	}
	.lcount {
		margin-left: auto;
		color: var(--ink-3);
	}
	.log {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}
	.log li {
		display: grid;
		grid-template-columns: 62px 10px 128px 1fr;
		gap: 8px;
		align-items: baseline;
		padding: 5px 6px;
		border-radius: 6px;
		font-size: 12px;
		animation: rise 260ms ease-out;
	}
	.log li:hover {
		background: var(--canvas);
	}
	.log time {
		font: 11px var(--mono);
		color: var(--ink-3);
	}
	.log i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--tc);
		align-self: center;
	}
	.tag {
		font: 600 10.5px var(--mono);
		color: var(--tc);
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.desc {
		color: var(--ink);
		word-break: break-word;
	}
	@keyframes blink {
		50% {
			opacity: 0.3;
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(-3px);
		}
	}
</style>
