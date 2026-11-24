<script lang="ts">
	import type { LayoutProps } from './$types';
	import { page } from '$app/state';
	import { Launchpad, setLaunchpad } from '#lib/prototypes/5-launchpad/state.svelte.ts';
	import CommandPalette from '#lib/prototypes/5-launchpad/CommandPalette.svelte';
	import LaunchSheet from '#lib/prototypes/5-launchpad/LaunchSheet.svelte';
	import InitWizard from '#lib/prototypes/5-launchpad/InitWizard.svelte';
	import Toasts from '#lib/prototypes/5-launchpad/Toasts.svelte';
	import ConfirmDialog from '#lib/prototypes/5-launchpad/ConfirmDialog.svelte';

	let { children }: LayoutProps = $props();

	const lp = new Launchpad();
	setLaunchpad(lp);

	const path = $derived(page.url.pathname);

	function onkeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			lp.paletteOpen = !lp.paletteOpen;
		}
	}
</script>

<svelte:window {onkeydown} />

<svelte:head>
	<title>Launchpad · ship</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Figtree:wght@400..800&family=JetBrains+Mono:wght@400..700&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<div class="lp">
	<header class="top">
		<a class="brand" href="/5-launchpad" aria-label="Launchpad home">
			<span class="mark" aria-hidden="true">
				<svg viewBox="0 0 32 32"><path d="M5 20h22l-3.5 6h-15z" /><path d="M16 4v14M16 5l8 11h-8" /></svg>
			</span>
			<span class="word">launchpad</span>
		</a>
		<nav>
			<a href="/5-launchpad" class={{ on: path === '/5-launchpad' }}>Home</a>
			{#each lp.projects as p (p.key)}
				<a href="/5-launchpad/{p.name}" class={{ on: path === `/5-launchpad/${p.name}` }}>{p.name}</a>
			{/each}
			<a href="/5-launchpad/settings" class={{ on: path === '/5-launchpad/settings' }}>Settings</a>
		</nav>
		<span class="grow"></span>
		<button type="button" class="trigger" onclick={() => (lp.paletteOpen = true)}>
			<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>
			<span>Ship, review, resume…</span>
			<kbd>⌘K</kbd>
		</button>
		<a class={['daemon', { off: !lp.daemon.running }]} href="/5-launchpad/settings" title="ship daemon status">
			<i></i>{lp.daemon.running ? `daemon ${lp.daemon.version}` : 'daemon stopped'}
		</a>
	</header>

	<main>
		{@render children()}
	</main>

	<footer class="foot">
		<a href="/">← prototypes</a>
		<span>Launchpad · mocked data, nothing talks to ship</span>
	</footer>

	{#if lp.paletteOpen}<CommandPalette />{/if}
	{#if lp.launch}
		{#key lp.launch.plan.path}<LaunchSheet target={lp.launch} />{/key}
	{/if}
	{#if lp.wizardOpen}<InitWizard />{/if}
	<ConfirmDialog />
	<Toasts />
</div>

<style>
	.lp {
		--bg: #f6f0e7;
		--bg-2: #efe5d6;
		--card: #fffcf7;
		--ink: #2b2019;
		--ink-2: #5f5047;
		--muted: #9a8878;
		--line: #ebdfcd;
		--line-2: #dccdb8;
		--accent: #e2571e;
		--accent-ink: #b5420f;
		--accent-soft: #fde4d4;
		--teal: #11766b;
		--teal-soft: #d6efe8;
		--plum: #7d3f92;
		--plum-soft: #f0e2f4;
		--amber: #b97a06;
		--amber-soft: #faedc8;
		--red: #c2352b;
		--red-soft: #fadcd7;
		--slate: #6c6a66;
		--slate-soft: #ebe6df;
		--code-bg: #2b2019;
		--code-ink: #f4e9dc;
		--radius: 28px;
		--shadow-sm: 0 1px 0 rgba(90, 55, 20, 0.04), 0 6px 18px -10px rgba(90, 55, 20, 0.16);
		--shadow: 0 1px 0 rgba(90, 55, 20, 0.04), 0 14px 34px -16px rgba(90, 55, 20, 0.28);
		--display: 'Bricolage Grotesque', 'Figtree', system-ui, sans-serif;
		--sans: 'Figtree', system-ui, -apple-system, sans-serif;
		--mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;

		min-height: 100vh;
		min-width: 1280px;
		background:
			radial-gradient(1200px 500px at 85% -10%, #fbe3cf 0%, transparent 60%),
			radial-gradient(900px 500px at -10% 10%, #f3eadc 0%, transparent 60%),
			var(--bg);
		color: var(--ink);
		font: 15px/1.5 var(--sans);
		-webkit-font-smoothing: antialiased;
		display: flex;
		flex-direction: column;
	}
	.lp :global(::selection) {
		background: var(--accent-soft);
	}
	.top {
		position: sticky;
		top: 0;
		z-index: 30;
		display: flex;
		align-items: center;
		gap: 28px;
		padding: 16px 48px;
		background: color-mix(in srgb, var(--bg) 82%, transparent);
		border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		text-decoration: none;
		color: var(--ink);
	}
	.mark {
		width: 38px;
		height: 38px;
		border-radius: 13px;
		background: var(--accent);
		display: grid;
		place-items: center;
		box-shadow: 0 6px 16px -6px var(--accent);
		transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.brand:hover .mark {
		transform: rotate(-10deg) translateY(-2px);
	}
	.mark svg {
		width: 24px;
		height: 24px;
		fill: none;
		stroke: #fff;
		stroke-width: 2.2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.word {
		font: 800 21px var(--display);
		letter-spacing: -0.02em;
	}
	nav {
		display: flex;
		gap: 4px;
	}
	nav a {
		font-weight: 600;
		font-size: 14.5px;
		color: var(--ink-2);
		text-decoration: none;
		padding: 7px 14px;
		border-radius: 999px;
		transition: background 0.15s;
	}
	nav a:hover {
		background: var(--bg-2);
	}
	nav a.on {
		background: var(--ink);
		color: var(--bg);
	}
	.grow {
		flex: 1;
	}
	.trigger {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 300px;
		padding: 9px 10px 9px 14px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--card);
		color: var(--muted);
		font: 14px var(--sans);
		cursor: pointer;
		transition:
			box-shadow 0.2s,
			border-color 0.2s,
			transform 0.12s;
	}
	.trigger span {
		flex: 1;
		text-align: left;
	}
	.trigger svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
	}
	.trigger:hover {
		box-shadow: 0 0 0 4px var(--accent-soft);
		border-color: var(--accent);
	}
	.trigger:active {
		transform: scale(0.98);
	}
	kbd {
		font: 600 11px var(--mono);
		padding: 2px 6px;
		border-radius: 6px;
		background: var(--bg-2);
		color: var(--ink-2);
		box-shadow: inset 0 -1px 0 var(--line-2);
	}
	.daemon {
		display: flex;
		align-items: center;
		gap: 8px;
		font: 12.5px var(--mono);
		color: var(--ink-2);
		text-decoration: none;
		padding: 7px 12px;
		border-radius: 999px;
		background: var(--card);
		border: 1px solid var(--line);
	}
	.daemon i {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--teal);
		box-shadow: 0 0 0 3px var(--teal-soft);
	}
	.daemon.off i {
		background: var(--red);
		box-shadow: 0 0 0 3px var(--red-soft);
	}
	main {
		flex: 1;
		width: 100%;
		max-width: 1360px;
		margin: 0 auto;
		padding: 40px 48px 60px;
	}
	.foot {
		display: flex;
		justify-content: space-between;
		padding: 18px 48px 26px;
		font-size: 13px;
		color: var(--muted);
	}
	.foot a {
		color: var(--muted);
		text-decoration: none;
	}
	.foot a:hover {
		color: var(--accent-ink);
	}
</style>
