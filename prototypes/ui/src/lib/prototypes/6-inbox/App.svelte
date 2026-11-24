<script lang="ts">
	import { page } from '$app/state';
	import { liveRun } from '#lib/mock/live.svelte.ts';
	import Detail from './Detail.svelte';
	import List from './List.svelte';
	import Tabs from './Tabs.svelte';
	import { Inbox } from './state.svelte.ts';

	/** Where the list of deliverables lives: a sidebar, or tabs across the top. */
	let { nav = 'sidebar' }: { nav?: 'sidebar' | 'tabs' } = $props();

	const inbox = new Inbox();
	const initial = page.url.searchParams.get('item');
	if (initial) inbox.select(initial);
	const live = liveRun();

	$effect(() => {
		// Track the live run's state and status; sync writes only to the inbox.
		void live.run.state;
		void live.run.status;
		inbox.syncLive(live.run);
	});

	let pane = $state<HTMLElement>();
	$effect(() => {
		void inbox.selectedId;
		pane?.scrollTo({ top: 0 });
	});

	const onkeydown = (e: KeyboardEvent) => {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.key === 'j' || e.key === 'ArrowDown') {
			inbox.move(1);
			e.preventDefault();
		} else if (e.key === 'k' || e.key === 'ArrowUp') {
			inbox.move(-1);
			e.preventDefault();
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			const p = inbox.primaryFor(inbox.selected);
			if (p && p.command !== '—') inbox.act(inbox.selected, p);
		}
	};
</script>

<svelte:window {onkeydown} />
<svelte:head>
	<title>ship · inbox</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link
		href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;550;600;650&family=JetBrains+Mono:wght@400;500;600&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<div class={['app', nav]}>
	{#if nav === 'tabs'}<Tabs {inbox} />{:else}<List {inbox} />{/if}
	<main bind:this={pane}>
		{#key inbox.selected.id}
			<Detail {inbox} d={inbox.selected} live={live.run} />
		{/key}
	</main>
	<ol class="toasts" aria-live="polite">
		{#each inbox.toasts as t (t.id)}
			<li>
				<span>{t.text}</span>
				{#if t.command}<code>$ {t.command}</code>{/if}
			</li>
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
		--dim: #5d6670;
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
	.app.tabs {
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: auto 1fr;
	}
	main {
		overflow-y: auto;
		min-height: 0;
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
		display: flex;
		gap: 14px;
		align-items: baseline;
		padding: 10px 16px;
		font-size: 13px;
		background: var(--raised);
		border: 1px solid var(--line-strong);
		border-radius: 9px;
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.5);
		animation: up 0.2s ease-out;
	}
	.toasts code {
		font: 12px var(--mono);
		color: var(--dim);
	}
	@keyframes up {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
</style>
