<script lang="ts">
	import { describe, projects } from '#lib';
	import { projectName } from './data.ts';
	import { getInbox, type Folder } from './inbox.svelte.ts';

	const inbox = getInbox();

	const folders: { id: Exclude<Folder, 'running'>; label: string; key: string; icon: string }[] = [
		{ id: 'decision', label: 'Needs decision', key: '1', icon: 'M2.5 9.5h3l1.5 2h2l1.5-2h3M2.5 9.5 4.5 3.5h7l2 6v3h-11Z' },
		{ id: 'snoozed', label: 'Snoozed', key: '2', icon: 'M8 4v4l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z' },
		{ id: 'done', label: 'Done', key: '3', icon: 'M3 8.5 6.5 12 13 4.5' }
	];
	const hues: Record<string, string> = { ship: '#2b59c3', storefront: '#1f9d61', 'billing-api': '#b26b00' };
</script>

<nav class="rail" aria-label="Folders">
	<div class="brand">
		<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"
			><path d="M4 16h16l-2.5 4h-11Z" fill="currentColor" /><path d="M12 3v11M12 4l6 9h-6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg
		>
		<span>ship</span>
		<em>inbox</em>
	</div>

	<ul class="folders">
		{#each folders as f (f.id)}
			{@const n = inbox.count(f.id)}
			<li>
				<button type="button" class={['folder', inbox.folder === f.id && !inbox.project && 'on']} onclick={() => inbox.setFolder(f.id)}>
					<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"
						><path d={f.icon} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg
					>
					<span class="label">{f.label}</span>
					{#if f.id === 'decision' && inbox.unreadCount}<span class="unread" title="{inbox.unreadCount} unread"></span>{/if}
					<span class={['n', f.id === 'decision' && n > 0 && 'strong']}>{n || ''}</span>
				</button>
			</li>
		{/each}
		<li class="quiet">
			<button
				type="button"
				class={['folder', inbox.folder === 'running' && 'on']}
				onclick={() => (inbox.folder === 'running' ? (inbox.runningOpen = !inbox.runningOpen) : inbox.setFolder('running'))}
				aria-expanded={inbox.runningOpen}
			>
				<span class={['chev', inbox.runningOpen && 'open']} aria-hidden="true">›</span>
				<span class="label">Running</span>
				<span class="n">{inbox.runningRows.length}</span>
			</button>
			{#if inbox.runningOpen}
				<ul class="runs">
					{#each inbox.runningRows as r (r.runId)}
						<li>
							<button
								type="button"
								class={[inbox.selectedId === `run:${r.runId}` && 'on']}
								onclick={() => {
									inbox.folder = 'running';
									inbox.select(`run:${r.runId}`);
								}}
							>
								<i class={['pulse', r.status]}></i>
								<code>{r.runId}</code>
								<span class="state">{r.state}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</li>
	</ul>

	<h2>Projects</h2>
	<ul class="projects">
		{#each projects as p (p.key)}
			{@const n = inbox.count('decision', p.key)}
			<li>
				<button type="button" class={['folder', inbox.project === p.key && 'on']} onclick={() => inbox.setProject(p.key)}>
					<i class="hue" style:--hue={hues[p.name] ?? '#888'}></i>
					<span class="label">{projectName(p.key)}</span>
					<span class="n">{n || ''}</span>
				</button>
			</li>
		{/each}
	</ul>

	<div class="foot">
		<button type="button" class="status" onclick={() => inbox.setFolder('running')} title="Open the Running folder">
			<span class="line">
				<i class="pulse running"></i>
				<b>{inbox.runningCount}</b> running
				{#if inbox.waitingCount}<span class="sep">·</span><b>{inbox.waitingCount}</b> waiting{/if}
				<span class="sep">·</span>db lock queue <b>{inbox.dbQueue}</b>
			</span>
			<span class="ticker">{inbox.live.run.runId} {describe(inbox.live.lastEvent)}</span>
		</button>
		<div class="links">
			<a href="/">← prototypes</a>
			<button type="button" onclick={() => (inbox.showKeys = true)}><kbd>?</kbd> shortcuts</button>
		</div>
	</div>
</nav>

<style>
	.rail {
		display: flex;
		flex-direction: column;
		height: 100vh;
		padding: 18px 12px 12px;
		background: var(--rail);
		border-right: 1px solid var(--line);
		min-width: 0;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 10px 20px;
		color: var(--ink);
	}
	.brand span {
		font-weight: 700;
		font-size: 16px;
		letter-spacing: -0.02em;
	}
	.brand em {
		font-style: normal;
		font-size: 12px;
		color: var(--faint);
		padding-left: 6px;
		border-left: 1px solid var(--line-strong);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.folders,
	.projects {
		display: grid;
		gap: 1px;
	}
	.folder {
		all: unset;
		box-sizing: border-box;
		cursor: pointer;
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 10px;
		border-radius: 6px;
		font-size: 13.5px;
		color: var(--ink-2);
	}
	.folder:hover {
		background: color-mix(in oklab, var(--ink) 5%, transparent);
	}
	.folder:focus-visible {
		outline: 2px solid var(--focus);
	}
	.folder.on {
		background: var(--panel);
		color: var(--ink);
		font-weight: 500;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
	}
	.folder svg {
		color: var(--muted);
	}
	.label {
		flex: 1;
	}
	.n {
		font-size: 12px;
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}
	.n.strong {
		color: var(--ink);
		font-weight: 600;
	}
	.unread {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
	}
	.quiet {
		margin-top: 6px;
	}
	.quiet > .folder {
		color: var(--faint);
		font-size: 12.5px;
	}
	.quiet > .folder.on {
		color: var(--ink);
	}
	.chev {
		width: 15px;
		text-align: center;
		transition: transform 0.15s;
	}
	.chev.open {
		transform: rotate(90deg);
	}
	.runs {
		padding: 2px 0 4px 18px;
	}
	.runs button {
		all: unset;
		box-sizing: border-box;
		cursor: pointer;
		width: 100%;
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 3px 8px;
		border-radius: 5px;
		font-size: 11.5px;
		color: var(--muted);
	}
	.runs button:hover,
	.runs button.on {
		background: color-mix(in oklab, var(--ink) 5%, transparent);
		color: var(--ink);
	}
	.runs code {
		font: 11px var(--mono);
	}
	.state {
		font: 11px var(--mono);
		color: var(--faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex: none;
		background: var(--faint);
	}
	.pulse.running {
		background: var(--live);
		animation: pulse 1.6s ease-in-out infinite;
	}
	.pulse.waiting {
		background: var(--tr);
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	h2 {
		margin: 22px 10px 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--faint);
	}
	.hue {
		width: 8px;
		height: 8px;
		margin: 0 3px;
		border-radius: 2px;
		background: var(--hue);
	}
	.foot {
		margin-top: auto;
		display: grid;
		gap: 10px;
	}
	.status {
		all: unset;
		cursor: pointer;
		display: grid;
		gap: 3px;
		padding: 9px 10px;
		border-radius: 7px;
		border: 1px solid var(--line);
		background: color-mix(in oklab, var(--panel) 60%, transparent);
		font-size: 11.5px;
		color: var(--muted);
		min-width: 0;
	}
	.status:hover {
		background: var(--panel);
	}
	.line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 2px 4px;
	}
	.line .pulse {
		margin-right: 3px;
	}
	.line b {
		color: var(--ink);
		font-weight: 600;
	}
	.sep {
		color: var(--faint);
	}
	.ticker {
		font: 10.5px var(--mono);
		color: var(--faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.links {
		display: flex;
		justify-content: space-between;
		padding: 0 4px;
		font-size: 11.5px;
	}
	.links a,
	.links button {
		all: unset;
		cursor: pointer;
		color: var(--faint);
	}
	.links a:hover,
	.links button:hover {
		color: var(--ink);
	}
	kbd {
		font: 10px var(--mono);
		padding: 0 4px;
		border: 1px solid currentColor;
		border-radius: 3px;
	}
</style>
