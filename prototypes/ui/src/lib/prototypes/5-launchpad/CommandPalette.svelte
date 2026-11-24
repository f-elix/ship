<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { backOut } from 'svelte/easing';
	import { goto } from '$app/navigation';
	import { relTime } from '#lib';
	import { getLaunchpad } from './state.svelte.ts';

	const lp = getLaunchpad();
	const base = '/5-launchpad';

	type Group = 'Actions' | 'Runs' | 'Projects';
	interface Item {
		id: string;
		group: Group;
		label: string;
		hint: string;
		icon: 'rocket' | 'eye' | 'wrench' | 'refresh' | 'play' | 'stop' | 'gear' | 'folder' | 'run' | 'plus' | 'key';
		run: () => void;
	}

	let query = $state('');
	let active = $state(0);
	let list = $state<HTMLElement>();

	const items = $derived.by((): Item[] => {
		const out: Item[] = [];
		for (const plan of lp.plans) {
			const project = lp.projectOf(plan.project);
			if (!project) continue;
			out.push({ id: `ship:${plan.path}`, group: 'Actions', label: `Ship ${plan.path}`, hint: `${project.name} · ${plan.title}`, icon: 'rocket', run: () => (lp.launch = { plan, project }) });
		}
		for (const pr of lp.prs) {
			const project = lp.projectOf(pr.project);
			if (!project) continue;
			const go = () => goto(`${base}/${project.name}#prs`);
			out.push({ id: `review:${pr.number}`, group: 'Actions', label: `Review ${project.name}#${pr.number}`, hint: `ship review ${pr.number}`, icon: 'eye', run: () => startPr('review', pr.number, project.name) });
			if (pr.unresolvedThreads > 0) {
				out.push({ id: `fix:${pr.number}`, group: 'Actions', label: `Fix ${project.name}#${pr.number}`, hint: `ship fix ${pr.number} · ${pr.unresolvedThreads} open threads`, icon: 'wrench', run: () => startPr('fix', pr.number, project.name) });
				out.push({ id: `recheck:${pr.number}`, group: 'Actions', label: `Recheck ${project.name}#${pr.number}`, hint: `ship recheck ${pr.number}`, icon: 'refresh', run: go });
			}
		}
		for (const r of lp.runs) {
			if (r.status === 'interrupted' || r.status === 'failed')
				out.push({ id: `resume:${r.runId}`, group: 'Actions', label: `Resume ${r.runId}`, hint: `${r.status} at ${r.state} · ${r.title}`, icon: 'play', run: () => lp.resumeRun(r.runId) });
			if (r.status === 'running' || r.status === 'waiting')
				out.push({ id: `cancel:${r.runId}`, group: 'Actions', label: `Cancel ${r.runId}`, hint: `${r.state} · ${r.title}`, icon: 'stop', run: () => lp.confirm({ title: `Cancel ${r.runId}?`, body: `${r.title} stops where it is and ends as cancelled.`, command: `ship cancel ${r.runId}`, confirmLabel: 'Cancel run', tone: 'danger', onConfirm: () => lp.cancelRun(r.runId) }) });
		}
		for (const p of lp.projects)
			out.push({ id: `settings:${p.name}`, group: 'Actions', label: `Open settings: ${p.name}`, hint: `~/.ship/projects/${p.key}.json`, icon: 'gear', run: () => goto(`${base}/${p.name}?tab=settings`) });
		out.push(
			{ id: 'add', group: 'Actions', label: 'Add project', hint: 'ship init --detect, then --write', icon: 'plus', run: () => (lp.wizardOpen = true) },
			{ id: 'restart', group: 'Actions', label: 'Restart daemon', hint: `pid ${lp.daemon.pid} · ${lp.activeRuns.length} active runs`, icon: 'refresh', run: () => goto(`${base}/settings?daemon=restart`) },
			{ id: 'creds', group: 'Actions', label: 'Check Cloudflare credentials', hint: 'ship auth cloudflare', icon: 'key', run: () => goto(`${base}/settings#clef`) },
			{ id: 'global', group: 'Actions', label: 'Global settings', hint: '~/.ship/config.json', icon: 'gear', run: () => goto(`${base}/settings`) }
		);
		for (const r of lp.runs) {
			const project = lp.projectOf(r.projectKey);
			out.push({ id: `run:${r.runId}`, group: 'Runs', label: `${r.runId} ${r.title}`, hint: `${r.kind} · ${r.status} · ${relTime(r.updatedAt)}`, icon: 'run', run: () => goto(`${base}/${project?.name}?run=${r.runId}#runs`) });
		}
		for (const p of lp.projects)
			out.push({ id: `project:${p.name}`, group: 'Projects', label: p.name, hint: p.path, icon: 'folder', run: () => goto(`${base}/${p.name}`) });
		return out;
	});

	function startPr(kind: 'review' | 'fix', number: number, projectName: string) {
		const project = lp.project(projectName)!;
		const pr = lp.prs.find((p) => p.number === number && p.project === project.key)!;
		const id = lp.startRun({ kind, project, title: pr.title, branch: pr.headRef, prNumber: number });
		lp.toast(`${kind === 'review' ? 'Reviewing' : 'Fixing'} ${projectName}#${number}`, { command: `ship ${kind} ${number}`, tone: 'success', body: `${id} started in ${project.path}` });
	}

	/** Subsequence match: consecutive and word-start hits score higher. Returns matched indexes. */
	function fuzzy(text: string, q: string): { score: number; hits: number[] } | null {
		if (!q) return { score: 0, hits: [] };
		const t = text.toLowerCase();
		const hits: number[] = [];
		let score = 0;
		let ti = 0;
		for (const ch of q.toLowerCase()) {
			if (ch === ' ') continue;
			const at = t.indexOf(ch, ti);
			if (at < 0) return null;
			const prev = hits.at(-1);
			score += prev === at - 1 ? 6 : 1;
			if (at === 0 || /[\s/#:.\-]/.test(t[at - 1])) score += 4;
			hits.push(at);
			ti = at + 1;
		}
		return { score: score - text.length * 0.02, hits };
	}

	const results = $derived.by(() => {
		const q = query.trim();
		const scored = items
			.map((item) => ({ item, m: fuzzy(item.label, q) ?? (q ? fuzzyHint(item, q) : null) }))
			.filter((r): r is { item: Item; m: { score: number; hits: number[] } } => r.m !== null);
		if (q) scored.sort((a, b) => b.m.score - a.m.score);
		const limit = q ? 40 : 14;
		return scored.slice(0, limit);
	});

	function fuzzyHint(item: Item, q: string) {
		const m = fuzzy(item.hint, q);
		return m ? { score: m.score - 8, hits: [] } : null;
	}

	const grouped = $derived.by(() => {
		const order: Group[] = ['Actions', 'Runs', 'Projects'];
		let index = 0;
		return order
			.map((group) => ({ group, rows: results.filter((r) => r.item.group === group) }))
			.filter((g) => g.rows.length)
			.map((g) => ({ ...g, rows: g.rows.map((r) => ({ ...r, index: index++ })) }));
	});

	const flat = $derived(grouped.flatMap((g) => g.rows));

	function close() {
		lp.paletteOpen = false;
	}
	function choose(item: Item | undefined) {
		if (!item) return;
		close();
		item.run();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
		else if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = (active + 1) % Math.max(flat.length, 1);
			scrollActive();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = (active - 1 + flat.length) % Math.max(flat.length, 1);
			scrollActive();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			choose(flat[active]?.item);
		}
	}

	function scrollActive() {
		requestAnimationFrame(() => list?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }));
	}

	const segments = (label: string, hits: number[]) => {
		const set = new Set(hits);
		const out: { text: string; hit: boolean; i: number }[] = [];
		for (let i = 0; i < label.length; i++) {
			const hit = set.has(i);
			const last = out.at(-1);
			if (last && last.hit === hit) last.text += label[i];
			else out.push({ text: label[i], hit, i });
		}
		return out;
	};

	const focus = (node: HTMLInputElement) => {
		node.focus();
	};
</script>

<svelte:window {onkeydown} />

{#snippet icon(name: Item['icon'])}
	<svg viewBox="0 0 24 24" aria-hidden="true">
		{#if name === 'rocket'}
			<path d="M12 15l-3-3c1-4 4-8 9-9 0 5-4 8-9 9" /><path d="M9 12H5l2-3h4M12 15v4l3-2v-4" /><path d="M6 16c-1 1-1.5 3-1.5 3.5S7 19 8 18" />
		{:else if name === 'eye'}
			<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" />
		{:else if name === 'wrench'}
			<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5a4 4 0 0 0-2-2z" />
		{:else if name === 'refresh'}
			<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4" />
		{:else if name === 'play'}
			<path d="M8 5.5v13l10-6.5z" />
		{:else if name === 'stop'}
			<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
		{:else if name === 'gear'}
			<circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
		{:else if name === 'folder'}
			<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
		{:else if name === 'plus'}
			<path d="M12 5v14M5 12h14" />
		{:else if name === 'key'}
			<circle cx="8" cy="15" r="3.5" /><path d="M10.5 12.5L19 4M16 7l2.5 2.5M14 9l2 2" />
		{:else}
			<circle cx="12" cy="12" r="7.5" /><path d="M12 8v4l2.5 2" />
		{/if}
	</svg>
{/snippet}

	<div class="scrim" transition:fade|global={{ duration: 140 }} onclick={close} role="presentation"></div>
	<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" transition:fly|global={{ y: -16, duration: 300, easing: backOut }}>
		<div class="search">
			<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>
			<input
				{@attach focus}
				bind:value={query}
				oninput={() => (active = 0)}
				placeholder="Type a plan, a PR, a run id…"
				aria-label="Search actions, runs and projects"
				role="combobox"
				aria-expanded="true"
				aria-controls="lp-palette-list"
				aria-activedescendant={flat[active] ? `lp-opt-${flat[active].index}` : undefined}
			/>
			<kbd>esc</kbd>
		</div>
		<div class="list" id="lp-palette-list" role="listbox" bind:this={list}>
			{#each grouped as g (g.group)}
				<div class="group">{g.group}</div>
				{#each g.rows as row (row.item.id)}
					<div
						id={`lp-opt-${row.index}`}
						role="option"
						tabindex="-1"
						aria-selected={row.index === active}
						data-active={row.index === active}
						class={['row', row.item.icon, { active: row.index === active }]}
						onmousemove={() => (active = row.index)}
						onclick={() => choose(row.item)}
						onkeydown={(e) => e.key === 'Enter' && choose(row.item)}
					>
						<span class="ic">{@render icon(row.item.icon)}</span>
						<span class="label">
							{#each segments(row.item.label, row.m.hits) as s (s.i)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}
						</span>
						<span class="hint">{row.item.hint}</span>
						<span class="enter">↵</span>
					</div>
				{/each}
			{:else}
				<div class="empty">
					<strong>Nothing matches “{query}”.</strong>
					<span>Try a plan dir like <code>.plans/guest-checkout</code>, a PR like <code>#412</code> or a run id.</span>
				</div>
			{/each}
		</div>
		<footer>
			<span><kbd>↑</kbd><kbd>↓</kbd> move</span>
			<span><kbd>↵</kbd> run</span>
			<span class="grow"></span>
			<span>{items.length} things you can do</span>
		</footer>
	</div>


<style>
	svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	kbd {
		font: 600 11px var(--mono);
		padding: 2px 6px;
		border-radius: 6px;
		background: var(--bg-2);
		color: var(--ink-2);
		box-shadow: inset 0 -1px 0 var(--line-2);
	}
	.scrim {
		position: fixed;
		inset: 0;
		background: rgba(43, 32, 24, 0.28);
		backdrop-filter: blur(4px);
		z-index: 70;
	}
	.palette {
		position: fixed;
		z-index: 71;
		top: 12vh;
		left: 50%;
		translate: -50% 0;
		width: 680px;
		background: var(--card);
		border-radius: 26px;
		box-shadow: 0 40px 100px -30px rgba(50, 25, 5, 0.55);
		overflow: hidden;
	}
	.search {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 18px 22px;
		border-bottom: 1px solid var(--line);
		color: var(--accent);
	}
	.search svg {
		width: 22px;
		height: 22px;
	}
	input {
		flex: 1;
		border: 0;
		outline: 0;
		background: none;
		font: 500 19px var(--sans);
		color: var(--ink);
	}
	input::placeholder {
		color: var(--muted);
	}
	.list {
		max-height: 420px;
		overflow: auto;
		padding: 8px 10px 10px;
	}
	.group {
		font: 700 11px var(--sans);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--muted);
		padding: 12px 12px 6px;
	}
	.row {
		display: grid;
		grid-template-columns: 34px minmax(0, auto) 1fr 20px;
		align-items: center;
		gap: 12px;
		padding: 9px 12px;
		border-radius: 14px;
		cursor: pointer;
	}
	.row.active {
		background: var(--accent-soft);
	}
	.ic {
		width: 34px;
		height: 34px;
		border-radius: 11px;
		display: grid;
		place-items: center;
		background: var(--bg-2);
		color: var(--ink-2);
		transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.active .ic {
		background: var(--accent);
		color: #fff;
		transform: rotate(-6deg) scale(1.05);
	}
	.rocket .ic {
		color: var(--accent-ink);
	}
	.label {
		font-weight: 600;
		font-size: 15px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 360px;
	}
	mark {
		background: none;
		color: var(--accent-ink);
		text-decoration: underline 2px color-mix(in srgb, var(--accent) 50%, transparent);
		text-underline-offset: 3px;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.enter {
		color: var(--accent-ink);
		opacity: 0;
		font-weight: 700;
	}
	.active .enter {
		opacity: 1;
	}
	.empty {
		display: grid;
		gap: 6px;
		padding: 36px 20px;
		text-align: center;
		color: var(--ink-2);
	}
	.empty code {
		font: 12.5px var(--mono);
		background: var(--bg-2);
		padding: 1px 6px;
		border-radius: 6px;
	}
	footer {
		display: flex;
		gap: 16px;
		padding: 11px 22px;
		border-top: 1px solid var(--line);
		font-size: 12.5px;
		color: var(--muted);
		background: var(--bg);
	}
	footer kbd {
		margin-right: 3px;
	}
	.grow {
		flex: 1;
	}
</style>
