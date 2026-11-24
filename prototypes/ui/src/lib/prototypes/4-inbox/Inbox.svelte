<script lang="ts">
	import { liveRun } from '#lib/mock/live.svelte.ts';
	import Detail from './Detail.svelte';
	import { choicesFor } from './FindingCard.svelte';
	import ItemList from './ItemList.svelte';
	import Overlays from './Overlays.svelte';
	import Rail from './Rail.svelte';
	import { InboxState, setInbox, type Folder } from './inbox.svelte.ts';

	let { initial, onselect }: { initial: string | null; onselect: (id: string | null) => void } = $props();

	// The URL seeds the selection once; afterwards the inbox owns it and writes it back.
	// svelte-ignore state_referenced_locally
	const inbox = setInbox(new InboxState(liveRun(), initial, (id) => onselect(id)));

	const folderKeys: Record<string, Folder> = { '1': 'decision', '2': 'snoozed', '3': 'done', '4': 'running' };

	const openFindings = () => {
		const run = inbox.selected && inbox.selected.status !== 'archived' ? inbox.run(inbox.selected.runId) : undefined;
		return run && ['escalated', 'review', 'tradeoff'].includes(inbox.selected!.kind) ? { run, list: inbox.currentFindings(run) } : null;
	};

	function onkeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

		if (inbox.confirm) {
			if (e.key === 'Escape') inbox.confirm = null;
			else if (e.key === 'Enter') inbox.accept();
			else return;
			e.preventDefault();
			return;
		}
		if (inbox.showKeys) {
			if (e.key === 'Escape' || e.key === '?') {
				inbox.showKeys = false;
				e.preventDefault();
			}
			return;
		}

		const findings = inbox.mode === 'detail' ? openFindings() : null;
		const key = e.key;

		if (findings && findings.list.length) {
			const current = findings.list[inbox.findingCursor];
			if (key === 'j' || key === 'ArrowDown') {
				inbox.findingCursor = Math.min(findings.list.length - 1, inbox.findingCursor + 1);
				return e.preventDefault();
			}
			if (key === 'k' || key === 'ArrowUp') {
				inbox.findingCursor = Math.max(0, inbox.findingCursor - 1);
				return e.preventDefault();
			}
			const choice = current && choicesFor(current.severity).find((c) => c.key === key);
			if (choice && current) {
				inbox.decide(findings.run.runId, current, choice.d);
				return e.preventDefault();
			}
		}

		switch (key) {
			case 'j':
			case 'ArrowDown':
				inbox.move(1);
				break;
			case 'k':
			case 'ArrowUp':
				inbox.move(-1);
				break;
			case 'Enter':
				if (!inbox.selectedId) return;
				inbox.select(inbox.selectedId, true);
				break;
			case 'Escape':
				inbox.mode = 'list';
				break;
			case 'e':
				if (!inbox.runAction('e')) inbox.archive();
				break;
			case 'h':
				inbox.snooze();
				break;
			case 'u':
				inbox.toggleUnread();
				break;
			case 'z':
				inbox.undo();
				break;
			case 'f':
			case 'r':
			case 'c':
			case 'p':
				if (!inbox.runAction(key) && key === 'r') inbox.toast('Nothing to resume here');
				break;
			case '?':
				inbox.showKeys = true;
				break;
			default:
				if (folderKeys[key]) inbox.setFolder(folderKeys[key]);
				else return;
		}
		e.preventDefault();
	}
</script>

<svelte:window {onkeydown} />

<svelte:head>
	<title>Inbox · ship</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
</svelte:head>

<div class="inbox">
	<Rail />
	<ItemList />
	<Detail />
	<Overlays />
</div>

<style>
	.inbox {
		--bg: #f6f5f2;
		--panel: #ffffff;
		--rail: #efeee9;
		--sel: #f1f0ec;
		--ink: #1c1c1e;
		--ink-2: #3d3d42;
		--muted: #6b6b72;
		--faint: #9c9ba2;
		--line: #e7e5df;
		--line-strong: #d4d1c9;
		--code-bg: #fbfaf8;
		--mf: #c4321f;
		--mf-wash: #fcebe8;
		--tr: #b06a00;
		--tr-wash: #fcf2e0;
		--nit: #557089;
		--nit-wash: #ebf0f5;
		--clef: #6a4fb9;
		--clef-wash: #f0ecfa;
		--accent: #2b59c3;
		--accent-wash: #eaf0fb;
		--live: #1f9d61;
		--focus: #2b59c3;
		--sans: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
		--mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;

		display: grid;
		grid-template-columns: 236px 392px minmax(0, 1fr);
		height: 100vh;
		overflow: hidden;
		min-width: 1280px;
		font: 14px/1.45 var(--sans);
		font-feature-settings: 'cv11', 'ss01';
		color: var(--ink);
		background: var(--bg);
		-webkit-font-smoothing: antialiased;
	}
	.inbox :global(::selection) {
		background: #cfdcf7;
	}
</style>
