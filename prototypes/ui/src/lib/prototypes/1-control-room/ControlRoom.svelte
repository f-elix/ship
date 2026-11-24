<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		clock,
		dailyCost,
		locks,
		NOW,
		projectByKey,
		projects,
		runs,
		usd,
		type Run,
		type RunEvent
	} from '#lib';
	import { liveRun } from '#lib/mock/live.svelte.ts';
	import EventStream from './EventStream.svelte';
	import Inspector from './Inspector.svelte';
	import PipelineRail from './PipelineRail.svelte';
	import RunHeader from './RunHeader.svelte';
	import Sidebar from './Sidebar.svelte';
	import { isActive, newRunId } from './model.ts';

	const live = liveRun();
	const LIVE_ID = 'r-7k2m';

	let localRuns = $state<Run[]>(structuredClone(runs.filter((r) => r.runId !== LIVE_ID)));
	/** Set once the live run is cancelled: its snapshot moves into localRuns and stops ticking. */
	let liveFrozen = $state(false);

	const allRuns = $derived(liveFrozen ? localRuns : [live.run, ...localRuns]);
	const selectedId = $derived(page.url.searchParams.get('run') ?? LIVE_ID);
	const selected = $derived(allRuns.find((r) => r.runId === selectedId) ?? allRuns[0]);
	const cap = $derived(projectByKey(selected.projectKey)?.caps.reviewRounds ?? 3);

	let filter = $state('');
	let filterEl = $state<HTMLInputElement>();
	let follow = $state(true);

	const groups = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		const match = (r: Run) =>
			!q ||
			[r.runId, r.title, r.branch ?? '', r.status, r.state, r.kind, projectByKey(r.projectKey)?.name ?? '']
				.join(' ')
				.toLowerCase()
				.includes(q);
		return projects
			.map((p) => ({
				name: p.name,
				path: p.path,
				runs: allRuns
					.filter((r) => r.projectKey === p.key && match(r))
					.toSorted(
						(a, b) =>
							Number(isActive(b.status)) - Number(isActive(a.status)) ||
							b.updatedAt.localeCompare(a.updatedAt)
					)
			}))
			.filter((g) => g.runs.length);
	});
	const ordered = $derived(groups.flatMap((g) => g.runs));

	const counts = $derived({
		running: allRuns.filter((r) => r.status === 'running').length,
		waiting: allRuns.filter((r) => r.status === 'waiting').length,
		attention: allRuns.filter((r) => ['escalated', 'failed', 'interrupted'].includes(r.status)).length
	});
	const today = dailyCost.at(-1) ?? 0;
	const maxDaily = Math.max(...dailyCost);

	function select(id: string) {
		if (id === selectedId) return;
		goto(`?run=${id}`, { replace: true, reset: false });
	}

	// --- Toasts and confirm ---------------------------------------------------------------

	let toasts = $state<{ id: number; text: string; tone: 'ok' | 'bad' | 'info' }[]>([]);
	let toastId = 0;
	function notify(text: string, tone: 'ok' | 'bad' | 'info' = 'info') {
		const id = ++toastId;
		toasts.push({ id, text, tone });
		setTimeout(() => {
			toasts = toasts.filter((t) => t.id !== id);
		}, 3600);
	}

	let confirmReq = $state<{ title: string; body: string; command: string; confirm: string; run: () => void } | null>(
		null
	);

	// --- Mutations (local only) -----------------------------------------------------------

	let offset = 0;
	const stamp = () => new Date(NOW.getTime() + ++offset * 1000).toISOString();
	const push = (r: Run, body: Record<string, unknown>) => {
		const at = stamp();
		r.events.push({ ...body, seq: r.events.length + 1, at } as RunEvent);
		r.updatedAt = at;
	};

	/** The editable copy of a run; freezes the live run first when it is the target. */
	function editable(id: string): Run | undefined {
		if (id === LIVE_ID && !liveFrozen) {
			localRuns.unshift($state.snapshot(live.run) as Run);
			liveFrozen = true;
		}
		return localRuns.find((r) => r.runId === id);
	}

	function askCancel() {
		const id = selected.runId;
		if (!isActive(selected.status)) return;
		confirmReq = {
			title: `Cancel ${id}?`,
			body: `The run stops at ${selected.state} and ends as cancelled. Commits already on ${selected.branch ?? 'the branch'} stay; nothing is pushed.`,
			command: `ship cancel ${id}`,
			confirm: 'cancel run',
			run: () => {
				const r = editable(id);
				if (!r) return;
				push(r, { _tag: 'RunCancelled' });
				push(r, { _tag: 'RunFinished', status: 'cancelled' });
				r.status = 'cancelled';
				r.state = 'cancelled';
				notify(`${id} cancelled · exit 1`, 'bad');
			}
		};
	}

	function resume() {
		const r = editable(selected.runId);
		if (!r || (r.status !== 'interrupted' && r.status !== 'failed')) return;
		const terminal = ['done', 'failed', 'escalated', 'cancelled'];
		const back = r.events.findLast((e) => e._tag === 'StateChanged' && !terminal.includes(e.to));
		const to = back?._tag === 'StateChanged' ? back.to : r.state;
		const failedStep = r.events.findLast((e) => e._tag === 'StepStarted');
		push(r, { _tag: 'RunResumed' });
		if (r.state !== to) push(r, { _tag: 'StateChanged', from: r.state, to });
		r.status = 'running';
		r.state = to;
		r.error = null;
		notify(`ship resume ${r.runId} · resuming ${to}`, 'ok');
		const step = failedStep?._tag === 'StepStarted' ? failedStep.step : null;
		if (step) {
			setTimeout(() => {
				if (r.status !== 'running') return;
				push(r, { _tag: 'StepStarted', step });
			}, 1400);
		}
	}

	function openPr() {
		if (selected.prUrl) notify(`opening ${selected.prUrl.replace('https://', '')}`, 'info');
	}

	function startFix() {
		const src = selected;
		if (!src.prNumber) return;
		const id = newRunId();
		const r: Run = {
			...structuredClone($state.snapshot(src) as Run),
			runId: id,
			kind: 'fix',
			status: 'running',
			state: 'fix',
			round: 1,
			createdAt: stamp(),
			updatedAt: stamp(),
			costUsd: 0,
			checks: [],
			findings: [],
			disproved: [],
			escalationReason: null,
			error: null,
			events: [],
			commits: [],
			planDir: null
		};
		push(r, { _tag: 'StateChanged', from: 'idle', to: 'fix' });
		push(r, { _tag: 'StepStarted', step: 'fix' });
		localRuns.unshift(r);
		notify(`started ship fix ${src.prNumber} as ${id}`, 'ok');
		select(id);
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			notify(`copied: ${text}`);
		} catch {
			notify(`couldn't reach the clipboard`, 'bad');
		}
	}

	// --- Keyboard -------------------------------------------------------------------------

	function onkeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement;
		if (t.closest('input, textarea, dialog')) return;
		const idx = ordered.findIndex((r) => r.runId === selected.runId);
		switch (e.key) {
			case 'j':
			case 'ArrowDown':
				if (ordered.length) select(ordered[Math.min(idx + 1, ordered.length - 1)].runId);
				break;
			case 'k':
			case 'ArrowUp':
				if (ordered.length) select(ordered[Math.max(idx - 1, 0)].runId);
				break;
			case '/':
				filterEl?.focus();
				break;
			case 'f':
				follow = !follow;
				break;
			case 'x':
				askCancel();
				break;
			case 'r':
				resume();
				break;
			case 'o':
				openPr();
				break;
			default:
				return;
		}
		e.preventDefault();
	}
</script>

<svelte:window {onkeydown} />

<svelte:head>
	<title>{selected.runId} · ship control room</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<div class="room">
	<div class="top">
		<div class="brand">
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 13h14l-2.5 4h-9zM10 3v8M10 4l5 6h-5" /></svg>
			<b>ship</b><span>control room</span>
		</div>
		<div class="kpis">
			<span class="kpi"><i class="k-run"></i>{counts.running} running</span>
			<span class="kpi"><i class="k-wait"></i>{counts.waiting} waiting</span>
			<span class={['kpi', counts.attention && 'alert']}><i class="k-att"></i>{counts.attention} need attention</span>
			<span class="div"></span>
			{#each locks as l (l.name)}
				<span class="kpi lockk">
					{l.name}
					<b>{l.held.length}/{l.permits}</b>{#if l.queue.length}<em>+{l.queue.length} queued</em>{/if}
				</span>
			{/each}
			<span class="div"></span>
			<span class="kpi spark" title="daily cost, last 14 days">
				<svg viewBox="0 0 70 16" aria-hidden="true">
					{#each dailyCost as c, i (i)}
						<rect
							x={i * 5}
							y={16 - Math.max((c / maxDaily) * 16, 0.5)}
							width="3.4"
							height={Math.max((c / maxDaily) * 16, 0.5)}
							class={i === dailyCost.length - 1 ? 'now' : ''}
						/>
					{/each}
				</svg>
				today <b>{usd(today)}</b>
			</span>
		</div>
		<div class="clock">{clock(NOW.toISOString())} UTC</div>
		<a class="back" href="/">← prototypes</a>
	</div>

	<Sidebar {groups} selectedId={selected.runId} bind:filter bind:filterEl onselect={select} />

	<main>
		<RunHeader
			run={selected}
			oncancel={askCancel}
			onresume={resume}
			onopenpr={openPr}
			onfix={startFix}
			oncopy={copy}
		/>
		<div class="railwrap">
			<PipelineRail run={selected} {cap} />
		</div>
		{#key selected.runId}
			<EventStream run={selected} bind:follow />
		{/key}
	</main>

	{#key selected.runId}
		<Inspector run={selected} onselect={select} />
	{/key}

	<footer class="hints">
		<span><kbd>j</kbd><kbd>k</kbd> move</span>
		<span><kbd>/</kbd> filter</span>
		<span><kbd>f</kbd> follow {follow ? 'on' : 'off'}</span>
		<span><kbd>x</kbd> cancel</span>
		<span><kbd>r</kbd> resume</span>
		<span><kbd>o</kbd> open PR</span>
		<span><kbd>esc</kbd> clear filter</span>
		<span class="right">mock data · nothing talks to shipd</span>
	</footer>

	<div class="toasts" aria-live="polite">
		{#each toasts as t (t.id)}
			<div class={['toast', t.tone]}>{t.text}</div>
		{/each}
	</div>

	{#if confirmReq}
		{@const req = confirmReq}
		<dialog
			{@attach (d) => d.showModal()}
			onclose={() => (confirmReq = null)}
			onclick={(e) => {
				if (e.target === e.currentTarget) e.currentTarget.close();
			}}
		>
			<form method="dialog">
				<h2>{req.title}</h2>
				<p>{req.body}</p>
				<code>$ {req.command}</code>
				<div class="dlg-actions">
					<button value="no">keep running</button>
					<button
						class="danger"
						value="yes"
						onclick={() => {
							req.run();
						}}>{req.confirm}</button
					>
				</div>
			</form>
		</dialog>
	{/if}
</div>

<style>
	.room {
		--bg: #08090b;
		--panel: #0d0f12;
		--hover: #14171c;
		--sel: #161a12;
		--line: #1b1f25;
		--line-strong: #2a3039;
		--faint: #4f5864;
		--dim: #7c8693;
		--text: #c3cad3;
		--bright: #eef2f6;
		--accent: #c8f53b;

		--s-running: var(--accent);
		--s-waiting: #f2a93b;
		--s-escalated: #ff7a45;
		--s-failed: #ff4f5e;
		--s-interrupted: #a58bff;
		--s-done: #4fc98a;
		--s-cancelled: #5d6672;

		--sev-must: #ff4f5e;
		--sev-trade: #f2a93b;
		--sev-nit: #7c8693;

		--c-state: #eef2f6;
		--c-checks: #5cc8ff;
		--c-locks: #e2b85c;
		--c-review: #c792ea;
		--c-cost: #8fd6b3;
		--c-git: #6fb6ff;
		--c-clef: #ff9ce6;

		--mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		--sans: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

		position: fixed;
		inset: 0;
		display: grid;
		grid-template-columns: 296px minmax(0, 1fr) 356px;
		grid-template-rows: 38px minmax(0, 1fr) 24px;
		grid-template-areas: 'top top top' 'side main insp' 'hints hints hints';
		background: var(--bg);
		color: var(--text);
		font-family: var(--sans);
		font-size: 13px;
		-webkit-font-smoothing: antialiased;
		color-scheme: dark;
		overflow: hidden;
	}
	.room :global(::selection) {
		background: color-mix(in srgb, var(--accent) 35%, transparent);
	}
	.room :global(:focus-visible) {
		outline: 1px solid var(--accent);
		outline-offset: 1px;
	}
	.room :global(::-webkit-scrollbar) {
		width: 8px;
		height: 8px;
	}
	.room :global(::-webkit-scrollbar-thumb) {
		background: var(--line-strong);
		border-radius: 4px;
		border: 2px solid transparent;
		background-clip: padding-box;
	}
	.room > :global(aside:first-of-type) {
		grid-area: side;
	}
	.room > :global(aside:last-of-type) {
		grid-area: insp;
	}
	main {
		grid-area: main;
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr);
		min-height: 0;
		min-width: 0;
	}
	.railwrap {
		padding: 0 18px 8px;
	}

	/* top bar */
	.top {
		grid-area: top;
		display: flex;
		align-items: center;
		gap: 18px;
		padding: 0 14px;
		border-bottom: 1px solid var(--line);
		background: var(--bg);
		font-family: var(--mono);
		font-size: 11px;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 268px;
	}
	.brand svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.5;
		stroke-linejoin: round;
	}
	.brand b {
		color: var(--bright);
		font-weight: 700;
		letter-spacing: 0.02em;
	}
	.brand span {
		color: var(--faint);
		text-transform: uppercase;
		letter-spacing: 0.14em;
		font-size: 10px;
	}
	.kpis {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 14px;
		color: var(--dim);
	}
	.kpi {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
	}
	.kpi i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}
	.k-run {
		background: var(--s-running);
		box-shadow: 0 0 6px var(--s-running);
	}
	.k-wait {
		background: var(--s-waiting);
	}
	.k-att {
		background: var(--s-escalated);
		border-radius: 1px !important;
	}
	.kpi.alert {
		color: var(--s-escalated);
	}
	.kpi b {
		color: var(--bright);
		font-weight: 500;
	}
	.kpi em {
		font-style: normal;
		color: var(--s-waiting);
	}
	.lockk {
		color: var(--c-locks);
	}
	.div {
		width: 1px;
		height: 14px;
		background: var(--line-strong);
	}
	.spark svg {
		width: 70px;
		height: 16px;
	}
	.spark rect {
		fill: var(--line-strong);
	}
	.spark rect.now {
		fill: var(--c-cost);
	}
	.clock {
		color: var(--dim);
		font-variant-numeric: tabular-nums;
	}
	.back {
		color: var(--faint);
		text-decoration: none;
	}
	.back:hover {
		color: var(--accent);
	}

	/* hints */
	.hints {
		grid-area: hints;
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 0 14px;
		border-top: 1px solid var(--line);
		background: var(--panel);
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--faint);
	}
	.hints span {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.hints .right {
		margin-left: auto;
	}
	kbd {
		display: inline-block;
		min-width: 15px;
		padding: 0 4px;
		border: 1px solid var(--line-strong);
		border-bottom-width: 2px;
		border-radius: 3px;
		font-family: var(--mono);
		font-size: 9.5px;
		line-height: 13px;
		text-align: center;
		color: var(--text);
		background: var(--bg);
	}

	/* toasts */
	.toasts {
		position: fixed;
		right: 372px;
		bottom: 38px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: flex-end;
		z-index: 20;
		pointer-events: none;
	}
	.toast {
		padding: 7px 12px 7px 10px;
		border: 1px solid var(--line-strong);
		border-left: 3px solid var(--dim);
		border-radius: 3px;
		background: #111419;
		color: var(--bright);
		font-family: var(--mono);
		font-size: 11.5px;
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.6);
		animation: toast 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.toast.ok {
		border-left-color: var(--accent);
	}
	.toast.bad {
		border-left-color: var(--s-failed);
	}
	@keyframes toast {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}

	/* dialog */
	dialog {
		width: 440px;
		padding: 0;
		border: 1px solid var(--line-strong);
		border-radius: 6px;
		background: var(--panel);
		color: var(--text);
		box-shadow: 0 30px 80px rgb(0 0 0 / 0.7);
	}
	dialog::backdrop {
		background: rgb(4 5 6 / 0.7);
		backdrop-filter: blur(2px);
	}
	form {
		padding: 18px 20px 16px;
	}
	h2 {
		margin: 0 0 8px;
		font-family: var(--mono);
		font-size: 14px;
		color: var(--bright);
	}
	dialog p {
		margin: 0 0 12px;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--text);
	}
	dialog code {
		display: block;
		padding: 6px 10px;
		border-radius: 3px;
		background: var(--bg);
		border: 1px solid var(--line);
		font-family: var(--mono);
		font-size: 11.5px;
		color: var(--accent);
	}
	.dlg-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}
	.dlg-actions button {
		height: 28px;
		padding: 0 12px;
		border-radius: 3px;
		border: 1px solid var(--line-strong);
		background: var(--bg);
		color: var(--text);
		font-family: var(--mono);
		font-size: 11.5px;
		cursor: pointer;
	}
	.dlg-actions .danger {
		border-color: var(--s-failed);
		background: var(--s-failed);
		color: #fff;
		font-weight: 600;
	}
</style>
