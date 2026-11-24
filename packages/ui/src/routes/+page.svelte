<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { ACTIONS } from '#lib/actions.ts';
	import Detail from '#lib/components/Detail.svelte';
	import List from '#lib/components/List.svelte';
	import type { ActionKind, DeliverableSummary, Stage } from '#lib/server/deliverables.ts';
	import { act, deliverable, deliverables } from './inbox.remote.ts';

	/** How long to wait before reconnecting to a daemon that went away. */
	const RECONNECT_MS = 2000;
	const STAGE_ORDER: ReadonlyArray<Stage> = ['decide', 'ready', 'working', 'closed'];

	const live = deliverables();
	let selectedId = $state<string | null>(page.url.searchParams.get('item'));
	let project = $state<string | null>(null);
	let busy = $state(false);
	let now = $state(Date.now());
	let toasts = $state<Array<{ id: number; text: string }>>([]);
	/** Why the last action was refused, shown on that deliverable's status card. */
	let refusal = $state<{ id: string; text: string } | null>(null);
	let toastId = 0;

	const all = $derived(live.current ?? []);
	const projects = $derived([...new Set(all.map((d) => d.projectName))].toSorted());
	const visible = $derived(
		all
			.filter((d) => project === null || d.projectName === project)
			.toSorted(
				(a, b) =>
					STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
					b.updatedAt.localeCompare(a.updatedAt)
			)
	);
	const selected = $derived(
		visible.find((d) => d.id === selectedId) ??
			visible.find((d) => d.stage !== 'closed') ??
			null
	);
	const detail = $derived(selected === null ? null : deliverable(selected.id));

	// The live list only summarizes; reload the open deliverable whenever its summary changes.
	let shown = '';
	$effect(() => {
		if (selected === null) return;
		const version = `${selected.id} ${selected.updatedAt} ${selected.stage}`;
		if (shown.startsWith(`${selected.id} `) && shown !== version) {
			void deliverable(selected.id).refresh();
		}
		shown = version;
	});

	// A live query stops for good on a server error or when the stream ends, which is how
	// the UI server reports a lost daemon; keep reconnecting until it is back.
	$effect(() => {
		if (live.error === undefined && !live.done) return;
		const timer = setTimeout(() => void live.reconnect(), RECONNECT_MS);
		return () => clearTimeout(timer);
	});

	// The same for the open deliverable, which a lost daemon fails too.
	$effect(() => {
		const query = detail;
		if (query?.error === undefined) return;
		const timer = setTimeout(() => void query.refresh(), RECONNECT_MS);
		return () => clearTimeout(timer);
	});

	// Relative times age with the clock alone.
	onMount(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	let pane = $state<HTMLElement>();

	const select = (id: string) => {
		if (refusal?.id !== id) refusal = null;
		if (id !== selected?.id) pane?.scrollTo({ top: 0 });
		selectedId = id;
		const url = new URL(page.url.href);
		url.searchParams.set('item', id);
		replaceState(url, {});
	};

	const move = (delta: number) => {
		const i = visible.findIndex((d) => d.id === selected?.id);
		const next = visible[Math.min(visible.length - 1, Math.max(0, i + delta))];
		if (next) select(next.id);
	};

	const toast = (text: string) => {
		const id = ++toastId;
		toasts.push({ id, text });
		setTimeout(() => (toasts = toasts.filter((t) => t.id !== id)), 3800);
	};

	const run = async (d: DeliverableSummary, action: ActionKind) => {
		if (busy) return;
		// Keep it in view: an archived deliverable leaves the open ones.
		select(d.id);
		refusal = null;
		busy = true;
		try {
			const result = await act({ id: d.id, action });
			if (result.ok) toast(`${ACTIONS[action].label}: done`);
			else refusal = { id: d.id, text: result.detail };
		} catch {
			refusal = {
				id: d.id,
				text: `${ACTIONS[action].label} failed; see the ship ui output.`
			};
		} finally {
			busy = false;
		}
		void deliverable(d.id).refresh();
	};

	/** ⌘↵ anywhere starts the open deliverable's main action; j/k belong to the list. */
	const onkeydown = (e: KeyboardEvent) => {
		if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
		const primary = selected?.actions[0];
		if (selected && primary) void run(selected, primary);
	};
</script>

<svelte:window {onkeydown} />
<svelte:head>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link
		href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;550;600;650&family=JetBrains+Mono:wght@400;500;600&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<div class="app">
	<List
		items={visible}
		selectedId={selected?.id ?? null}
		bind:project
		{projects}
		{now}
		connected={live.connected}
		onselect={select}
		onmove={move}
	/>
	<main bind:this={pane}>
		{#if live.error}
			<p class="banner" role="alert">
				{live.error.message} Reconnecting…
			</p>
		{/if}
		{#if selected}
			{#key selected.id}
				<Detail
					d={selected}
					detail={detail?.current}
					loadError={detail?.error?.message}
					refusal={refusal?.id === selected.id ? refusal.text : null}
					{now}
					{busy}
					onact={(action) => run(selected, action)}
				/>
			{/key}
		{:else if live.loading}
			<p class="empty">Loading…</p>
		{:else if visible.length}
			<p class="empty">Nothing needs you. Finished and archived work is under Closed.</p>
		{:else if live.ready}
			<p class="empty">
				Nothing to look at. Start a run with <code>ship run</code> or
				<code>ship review</code>.
			</p>
		{/if}
	</main>
	<ol class="toasts" aria-live="polite">
		{#each toasts as t (t.id)}
			<li>{t.text}</li>
		{/each}
	</ol>
</div>

<style>
	.app {
		--bg: #0c0e11;
		--sunk: #090b0d;
		--panel: #12151a;
		--raised: #191d23;
		--hover: #161a1f;
		--code: #0a0c0f;
		--card: #101317;
		--card-line: #1c2027;
		--line: #22272f;
		--line-soft: #1a1e24;
		--line-strong: #2d333c;
		--text: #e8eaed;
		--muted: #949ca7;
		--dim: #7e8792;
		--accent: #8ab4ff;
		--mf: #ff7070;
		--tr: #f2b65c;
		--nit: #8d9db5;
		--ok: #5fd39a;
		--err: #ff8f5e;
		--sans: 'Inter', system-ui, sans-serif;
		--mono: 'JetBrains Mono', ui-monospace, monospace;

		position: fixed;
		inset: 0;
		display: grid;
		grid-template-columns: 320px 1fr;
		color: var(--text);
		background: var(--bg);
		font: 14px/1.5 var(--sans);
		font-feature-settings: 'cv11', 'ss01';
		color-scheme: dark;
		-webkit-font-smoothing: antialiased;
	}
	main {
		overflow-y: auto;
		min-height: 0;
	}
	.banner {
		position: sticky;
		top: 0;
		z-index: 1;
		margin: 0;
		padding: 10px 24px;
		font-size: 13px;
		color: var(--err);
		background: color-mix(in srgb, var(--err) 12%, var(--bg));
		border-bottom: 1px solid color-mix(in srgb, var(--err) 30%, transparent);
	}
	.empty {
		max-width: 768px;
		margin: 0 auto;
		padding: 56px 48px;
		color: var(--dim);
	}
	.empty code {
		font: 13px var(--mono);
		color: var(--muted);
	}
	.toasts {
		position: fixed;
		left: 50%;
		bottom: 24px;
		transform: translateX(-50%);
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.toasts li {
		max-width: 560px;
		padding: 10px 16px;
		font-size: 13px;
		background: var(--raised);
		border: 1px solid var(--line-strong);
		border-radius: 9px;
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.5);
		animation: up 0.2s ease-out;
	}
	/* Narrow windows, or zoomed in: the list stacks above the open deliverable. */
	@media (max-width: 720px) {
		.app {
			grid-template-columns: 1fr;
			grid-template-rows: minmax(0, 40vh) 1fr;
		}
		.empty {
			padding: 32px 16px;
		}
	}
	@keyframes up {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
</style>
