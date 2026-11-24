<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { projects, usd } from '#lib';
	import type { Run } from '#lib';
	import { liveRun } from '#lib/mock/live.svelte.ts';
	import { Board } from '#lib/prototypes/3-board/board.svelte.ts';
	import type { NewRunSpec } from '#lib/prototypes/3-board/board.svelte.ts';
	import Drawer from '#lib/prototypes/3-board/Drawer.svelte';
	import NewRunModal from '#lib/prototypes/3-board/NewRunModal.svelte';
	import RunCard from '#lib/prototypes/3-board/RunCard.svelte';
	import TopBar from '#lib/prototypes/3-board/TopBar.svelte';
	import {
		COLUMNS,
		PROJECT_COLOR,
		ago,
		columnOf,
		projectColor,
		projectOf
	} from '#lib/prototypes/3-board/model.ts';
	import type { ColumnId, ConfirmRequest } from '#lib/prototypes/3-board/model.ts';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { crossfade, fade, fly, scale } from 'svelte/transition';

	const board = new Board(liveRun());

	const [send, receive] = crossfade({
		duration: 480,
		easing: cubicOut,
		fallback: (node) => scale(node, { start: 0.94, duration: 220, opacity: 0 })
	});

	let modal = $state<{ project: string | null } | null>(null);
	let confirm = $state<ConfirmRequest | null>(null);

	const selectedId = $derived(page.url.searchParams.get('run'));
	const selected = $derived(board.all.find((r) => r.runId === selectedId) ?? null);

	const visible = $derived(
		board.all.filter((r) => board.filter.length === 0 || board.filter.includes(r.projectKey))
	);

	const columnCount = $derived.by(() => {
		const c = Object.fromEntries(COLUMNS.map((col) => [col.id, 0])) as Record<ColumnId, number>;
		for (const r of visible) c[columnOf(r)]++;
		return c;
	});

	const template = $derived(
		COLUMNS.map((c) => {
			if (c.id === 'needs') return 'minmax(250px, 1.1fr)';
			if (c.id === 'shipped') return 'minmax(220px, 0.9fr)';
			return columnCount[c.id] === 0 ? '46px' : 'minmax(232px, 1fr)';
		}).join(' ')
	);

	const activeByProject = $derived.by(() => {
		const m: Record<string, number> = {};
		for (const r of board.all)
			if (r.status === 'running' || r.status === 'waiting') m[r.projectKey] = (m[r.projectKey] ?? 0) + 1;
		return m;
	});

	const lanes = $derived(
		board.swimlanes
			? projects
					.filter((p) => board.filter.length === 0 || board.filter.includes(p.key))
					.map((p) => ({ key: p.key, project: p, runs: visible.filter((r) => r.projectKey === p.key) }))
			: [{ key: 'all', project: null, runs: visible }]
	);

	const summary = $derived({
		active: visible.filter((r) => r.status === 'running' || r.status === 'waiting').length,
		needs: columnCount.needs,
		shipped: columnCount.shipped,
		spend: visible.reduce((t, r) => t + r.costUsd, 0)
	});

	const byUpdated = (a: Run, b: Run) => b.updatedAt.localeCompare(a.updatedAt);
	const cellRuns = (runs: Run[], col: ColumnId) => runs.filter((r) => columnOf(r) === col).sort(byUpdated);

	function open(id: string) {
		goto(`?run=${id}`, { reset: false, replace: selectedId !== null });
	}

	function close() {
		goto('?', { reset: false });
	}

	function startRun(spec: NewRunSpec) {
		modal = null;
		const id = board.start(spec);
		open(id);
	}

	function onkeydown(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t.closest('input, textarea, select')) return;
		if (e.key === 'Escape') {
			if (confirm) confirm = null;
			else if (!modal && selected) close();
		}
		if ((e.key === 'n' || e.key === 'N') && !modal && !confirm && !e.metaKey && !e.ctrlKey) {
			e.preventDefault();
			modal = { project: board.filter.length === 1 ? board.filter[0] : null };
		}
	}
</script>

<svelte:head>
	<title>Board · ship</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;650;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<svelte:window {onkeydown} />

{#snippet shippedRow(run: Run)}
	<button
		type="button"
		class={['srow', run.status, selectedId === run.runId && 'selected']}
		style:--pc={projectColor(run)}
		onclick={() => open(run.runId)}
	>
		<span class="sicon" aria-hidden="true">
			{#if run.status === 'done'}
				<svg viewBox="0 0 16 16" width="11" height="11"
					><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg
				>
			{:else}
				<svg viewBox="0 0 16 16" width="10" height="10"
					><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg
				>
			{/if}
		</span>
		<span class="stitle">{run.title}</span>
		<span class="smeta">
			<i></i>{projectOf(run).name} · <code>{run.kind}</code>{run.prNumber ? ` · #${run.prNumber}` : ''}
		</span>
		<span class="sright">
			<span>{ago(run.updatedAt)}</span>
			<span class="scost">{usd(run.costUsd)}</span>
		</span>
	</button>
{/snippet}

<div class="root">
	<TopBar
		{board}
		active={activeByProject}
		onnew={() => (modal = { project: board.filter.length === 1 ? board.filter[0] : null })}
	/>

	<div class="subbar">
		<div class="summary">
			<h1>All runs</h1>
			<span><b>{summary.active}</b> active</span>
			<span class="dotsep"></span>
			<span class={[summary.needs && 'hot']}><b>{summary.needs}</b> need you</span>
			<span class="dotsep"></span>
			<span><b>{summary.shipped}</b> shipped</span>
			<span class="dotsep"></span>
			<span><b>{usd(summary.spend)}</b> on these runs</span>
		</div>
		<div class="seg" role="group" aria-label="Layout">
			<button type="button" class={[!board.swimlanes && 'on']} onclick={() => (board.swimlanes = false)}>
				<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"
					><rect x="2" y="2.5" width="3" height="11" rx="1" fill="currentColor" /><rect x="6.5" y="2.5" width="3" height="7" rx="1" fill="currentColor" /><rect
						x="11"
						y="2.5"
						width="3"
						height="9"
						rx="1"
						fill="currentColor"
					/></svg
				>
				Flat
			</button>
			<button type="button" class={[board.swimlanes && 'on']} onclick={() => (board.swimlanes = true)}>
				<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"
					><rect x="2" y="2.5" width="12" height="3" rx="1" fill="currentColor" /><rect x="2" y="6.5" width="12" height="3" rx="1" fill="currentColor" /><rect
						x="2"
						y="10.5"
						width="12"
						height="3"
						rx="1"
						fill="currentColor"
					/></svg
				>
				By project
			</button>
		</div>
	</div>

	<main class={['board', board.swimlanes && 'lanes']}>
		<div class="grid heads" style:grid-template-columns={template}>
			{#each COLUMNS as c (c.id)}
				{@const n = columnCount[c.id]}
				<div
					class={['head', c.terminal && 'terminal', n === 0 && !c.terminal && 'collapsed', c.id]}
					style:--cc={c.color}
					title={n === 0 && !c.terminal ? `${c.label} · empty` : undefined}
				>
					<i></i>
					<span class="hlabel">{c.label}</span>
					<span class="hcount">{n}</span>
				</div>
			{/each}
		</div>

		{#each lanes as lane (lane.key)}
			<section class="lane" in:fade={{ duration: 200 }}>
				{#if lane.project}
					<div class="lanehead" style:--pc={PROJECT_COLOR[lane.project.name]}>
						<i></i>
						<b>{lane.project.name}</b>
						<code>{lane.project.path}</code>
						<span class="lanecount">{lane.runs.length} runs</span>
						<button type="button" class="laneadd" onclick={() => (modal = { project: lane.project?.key ?? null })}>
							+ run
						</button>
					</div>
				{/if}
				<div class="grid" style:grid-template-columns={template}>
					{#each COLUMNS as c (c.id)}
						{@const items = cellRuns(lane.runs, c.id)}
						<div
							class={['cell', c.id, c.terminal && 'terminal', columnCount[c.id] === 0 && !c.terminal && 'collapsed']}
							style:--cc={c.color}
						>
							{#each items as run (run.runId)}
								<div
									class="slot"
									animate:flip={{ duration: 380, easing: cubicOut }}
									in:receive={{ key: run.runId }}
									out:send={{ key: run.runId }}
								>
									{#if c.id === 'shipped'}
										{@render shippedRow(run)}
									{:else}
										<RunCard
											{run}
											live={board.isLive(run.runId)}
											selected={selectedId === run.runId}
											onopen={() => open(run.runId)}
										/>
									{/if}
								</div>
							{/each}
							{#if items.length === 0 && (c.terminal || columnCount[c.id] > 0)}
								<div class="emptycell">
									{c.id === 'needs' ? 'Nothing needs you' : c.id === 'shipped' ? 'Nothing shipped yet' : '—'}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{/each}
	</main>

	{#if selected}
		<Drawer
			run={selected}
			{board}
			live={board.isLive(selected.runId)}
			onclose={close}
			onconfirm={(c) => (confirm = c)}
			onopen={open}
		/>
	{/if}

	{#if modal}
		<NewRunModal initialProject={modal.project} onclose={() => (modal = null)} onstart={startRun} />
	{/if}

	{#if confirm}
		{@const c = confirm}
		<div class="scrim" transition:fade={{ duration: 140 }}>
			<button type="button" class="scrim-close" aria-label="Dismiss" onclick={() => (confirm = null)}></button>
			<div class="confirm" role="alertdialog" aria-modal="true" aria-labelledby="cf-title" transition:scale={{ start: 0.95, duration: 180 }}>
				<h3 id="cf-title">{c.title}</h3>
				<p>{c.body}</p>
				<code class="cfcmd"><span>$</span> {c.command}</code>
				<div class="cfbtns">
					<button type="button" class="ghost" onclick={() => (confirm = null)}>Keep</button>
					<button
						type="button"
						class={['cfgo', c.tone]}
						onclick={() => {
							c.action();
							confirm = null;
						}}
					>
						{c.confirmLabel}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<div class="toasts" aria-live="polite">
		{#each board.toasts as t (t.id)}
			<div
				class={['toast', t.tone]}
				animate:flip={{ duration: 200 }}
				in:fly={{ y: 16, duration: 220 }}
				out:fade={{ duration: 160 }}
			>
				<i></i>
				<div>
					<b>{t.title}</b>
					{#if t.detail}<code>{t.detail}</code>{/if}
				</div>
				<button type="button" aria-label="Dismiss" onclick={() => board.dismiss(t.id)}>×</button>
			</div>
		{/each}
	</div>

	<a class="back" href="/">← prototypes</a>
</div>

<style>
	.root {
		--canvas: #f2f3f9;
		--card: #ffffff;
		--ink: #161a2c;
		--ink-2: #4a5068;
		--ink-3: #8a90a6;
		--line: #e4e6ef;
		--line-2: #d6d9e6;
		--accent: #5b4bff;
		--accent-soft: #efedff;
		--ok: #12a36b;
		--warn: #e08a00;
		--danger: #e5484d;
		--mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		--shadow-sm: 0 1px 2px rgba(22, 26, 44, 0.06), 0 1px 1px rgba(22, 26, 44, 0.03);
		--shadow-md: 0 8px 20px -8px rgba(22, 26, 44, 0.18), 0 2px 4px rgba(22, 26, 44, 0.05);

		min-height: 100vh;
		min-width: 1280px;
		background:
			radial-gradient(1200px 400px at 80% -100px, #e9e6ff 0%, transparent 60%),
			radial-gradient(900px 300px at 0% 0%, #e6f1ff 0%, transparent 60%),
			var(--canvas);
		color: var(--ink);
		font:
			14px/1.45 Inter,
			system-ui,
			-apple-system,
			sans-serif;
		font-feature-settings: 'cv11', 'ss01';
		-webkit-font-smoothing: antialiased;
	}
	.subbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 18px 20px 10px;
	}
	.summary {
		display: flex;
		align-items: baseline;
		gap: 10px;
		font-size: 13px;
		color: var(--ink-2);
	}
	h1 {
		margin: 0 8px 0 0;
		font-size: 20px;
		font-weight: 680;
		letter-spacing: -0.015em;
		color: var(--ink);
	}
	.summary b {
		color: var(--ink);
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	.summary .hot,
	.summary .hot b {
		color: #c4262c;
	}
	.dotsep {
		width: 3px;
		height: 3px;
		border-radius: 50%;
		background: var(--line-2);
		align-self: center;
	}
	.seg {
		display: inline-flex;
		background: white;
		border: 1px solid var(--line);
		border-radius: 10px;
		padding: 3px;
		box-shadow: var(--shadow-sm);
	}
	.seg button {
		all: unset;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 11px;
		border-radius: 7px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--ink-2);
		cursor: pointer;
	}
	.seg button.on {
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 600;
	}
	.seg button:focus-visible {
		outline: 2px solid var(--accent);
	}

	.board {
		padding: 0 20px 60px;
	}
	.grid {
		display: grid;
		gap: 10px;
		transition: grid-template-columns 420ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	.heads {
		position: sticky;
		top: 60px;
		z-index: 10;
		padding: 8px 0;
		background: linear-gradient(var(--canvas) 70%, transparent);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 7px;
		height: 34px;
		padding: 0 10px;
		background: white;
		border-radius: 9px;
		box-shadow: var(--shadow-sm);
		border-top: 3px solid var(--cc);
		font-size: 12.5px;
		font-weight: 600;
		overflow: hidden;
		white-space: nowrap;
		transition: padding 300ms;
	}
	.head i {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--cc);
	}
	.hcount {
		margin-left: auto;
		font-size: 11px;
		font-weight: 650;
		color: color-mix(in srgb, var(--cc) 85%, black);
		background: color-mix(in srgb, var(--cc) 12%, white);
		padding: 0 7px;
		border-radius: 999px;
	}
	.head.collapsed {
		padding: 0;
		justify-content: center;
		background: color-mix(in srgb, var(--cc) 5%, white);
	}
	.head.collapsed .hlabel,
	.head.collapsed .hcount {
		display: none;
	}
	.head.needs {
		background: #fff5f5;
	}
	.head.shipped {
		background: #f8f9fc;
	}

	.lane {
		margin-top: 4px;
	}
	.lanes .lane {
		margin-top: 14px;
	}
	.lanehead {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 6px 4px 8px;
		font-size: 13px;
	}
	.lanehead i {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		background: var(--pc);
	}
	.lanehead code {
		font: 11px var(--mono);
		color: var(--ink-3);
	}
	.lanecount {
		font-size: 11.5px;
		color: var(--ink-3);
	}
	.laneadd {
		all: unset;
		margin-left: auto;
		font-size: 12px;
		font-weight: 600;
		color: var(--accent);
		padding: 3px 8px;
		border-radius: 6px;
		cursor: pointer;
	}
	.laneadd:hover {
		background: var(--accent-soft);
	}

	.cell {
		display: flex;
		flex-direction: column;
		gap: 9px;
		padding: 8px;
		border-radius: 12px;
		background: color-mix(in srgb, var(--cc) 4%, rgba(255, 255, 255, 0.45));
		min-height: calc(100vh - 190px);
		min-width: 0;
	}
	.lanes .cell {
		min-height: 96px;
	}
	.cell.collapsed {
		background: repeating-linear-gradient(
			180deg,
			transparent 0 10px,
			color-mix(in srgb, var(--cc) 8%, transparent) 10px 11px
		);
		padding: 0;
	}
	.cell.needs {
		background: linear-gradient(180deg, #fff1f1, #fff6f6 40%, rgba(255, 246, 246, 0.6));
		box-shadow: inset 0 0 0 1px #fbdede;
	}
	.cell.shipped {
		background: rgba(255, 255, 255, 0.55);
		box-shadow: inset 0 0 0 1px var(--line);
		gap: 4px;
	}
	.slot {
		min-width: 0;
	}
	.emptycell {
		display: grid;
		place-items: center;
		min-height: 64px;
		font-size: 12px;
		color: var(--ink-3);
		border: 1px dashed var(--line-2);
		border-radius: 10px;
	}

	.srow {
		all: unset;
		box-sizing: border-box;
		width: 100%;
		display: grid;
		grid-template-columns: 18px 1fr auto;
		gap: 1px 8px;
		align-items: center;
		padding: 7px 9px;
		border-radius: 9px;
		cursor: pointer;
		transition: background 120ms;
	}
	.srow:hover {
		background: white;
		box-shadow: var(--shadow-sm);
	}
	.srow.selected {
		background: white;
		box-shadow: 0 0 0 2px var(--accent-soft), inset 0 0 0 1px var(--accent);
	}
	.sicon {
		grid-row: 1 / 3;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		color: white;
		background: var(--ok);
	}
	.srow.cancelled .sicon {
		background: #b4b9ca;
	}
	.stitle {
		font-size: 12.5px;
		font-weight: 550;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.srow.cancelled .stitle {
		color: var(--ink-3);
		text-decoration: line-through;
	}
	.smeta {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		color: var(--ink-3);
		white-space: nowrap;
		overflow: hidden;
	}
	.smeta i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--pc);
	}
	.smeta code {
		font: 10.5px var(--mono);
	}
	.sright {
		grid-row: 1 / 3;
		grid-column: 3;
		display: grid;
		justify-items: end;
		font-size: 10.5px;
		color: var(--ink-3);
	}
	.scost {
		font-variant-numeric: tabular-nums;
		color: var(--ink-2);
	}

	.scrim {
		position: fixed;
		inset: 0;
		background: rgba(22, 26, 44, 0.3);
		backdrop-filter: blur(2px);
		display: grid;
		place-items: center;
		z-index: 60;
	}
	.scrim-close {
		all: unset;
		position: absolute;
		inset: 0;
	}
	.confirm {
		position: relative;
		width: 440px;
		background: white;
		border-radius: 16px;
		padding: 20px 22px 18px;
		box-shadow: 0 30px 80px -20px rgba(22, 26, 44, 0.45);
		display: grid;
		gap: 10px;
	}
	.confirm h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 650;
	}
	.confirm p {
		margin: 0;
		font-size: 13px;
		color: var(--ink-2);
		line-height: 1.5;
	}
	.cfcmd {
		font: 12px var(--mono);
		background: #15172a;
		color: #e7e8f5;
		padding: 9px 11px;
		border-radius: 9px;
	}
	.cfcmd span {
		color: #8d7dff;
	}
	.cfbtns {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 4px;
	}
	.ghost,
	.cfgo {
		all: unset;
		font-size: 13px;
		font-weight: 600;
		padding: 8px 14px;
		border-radius: 9px;
		cursor: pointer;
	}
	.ghost {
		color: var(--ink-2);
	}
	.ghost:hover {
		background: var(--canvas);
	}
	.cfgo.primary {
		background: var(--accent);
		color: white;
	}
	.cfgo.danger {
		background: var(--danger);
		color: white;
	}
	.ghost:focus-visible,
	.cfgo:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.toasts {
		position: fixed;
		left: 20px;
		bottom: 44px;
		display: grid;
		gap: 8px;
		z-index: 70;
	}
	.toast {
		display: grid;
		grid-template-columns: 8px 1fr auto;
		align-items: center;
		gap: 10px;
		min-width: 300px;
		max-width: 420px;
		background: #15172a;
		color: white;
		padding: 10px 10px 10px 14px;
		border-radius: 12px;
		box-shadow: 0 12px 30px -10px rgba(22, 26, 44, 0.5);
		font-size: 13px;
	}
	.toast i {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #8d7dff;
	}
	.toast.ok i {
		background: #3ddc97;
	}
	.toast.warn i {
		background: #f5b041;
	}
	.toast.danger i {
		background: #ff6b6f;
	}
	.toast div {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.toast code {
		font: 11px var(--mono);
		color: #a5a9c9;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.toast button {
		all: unset;
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		border-radius: 6px;
		color: #a5a9c9;
		cursor: pointer;
		font-size: 16px;
	}
	.toast button:hover {
		background: rgba(255, 255, 255, 0.1);
		color: white;
	}
	.back {
		position: fixed;
		left: 20px;
		bottom: 14px;
		font-size: 11.5px;
		color: var(--ink-3);
		text-decoration: none;
		z-index: 5;
	}
	.back:hover {
		color: var(--accent);
	}
</style>
