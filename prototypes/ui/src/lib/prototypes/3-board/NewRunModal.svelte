<script lang="ts">
	import { ago } from './model.ts';
	import { commandFor, openPrs, plans, projects } from '#lib';
	import type { RunKind } from '#lib';
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { NewRunSpec } from './board.svelte.ts';
	import { PROJECT_COLOR } from './model.ts';

	let {
		initialProject,
		onclose,
		onstart
	}: { initialProject: string | null; onclose: () => void; onstart: (s: NewRunSpec) => void } =
		$props();

	type Mode = 'plan' | 'pr';
	const PLAN_KINDS: { kind: RunKind; label: string; hint: string }[] = [
		{ kind: 'ship', label: 'ship run', hint: 'Implement → checks → review → fix → PR' },
		{ kind: 'implement', label: 'ship implement', hint: 'Implement and commit, no review or PR' }
	];
	const PR_KINDS: { kind: RunKind; label: string; hint: string }[] = [
		{ kind: 'review', label: 'ship review', hint: 'One review round, stored; post later' },
		{ kind: 'fix', label: 'ship fix', hint: 'Fix open threads, run checks, push' },
		{ kind: 'recheck', label: 'ship recheck', hint: 'Verify which findings are fixed' }
	];

	// svelte-ignore state_referenced_locally
	let projectKey = $state(initialProject ?? projects[0].key);
	let mode = $state<Mode>('plan');
	let kind = $state<RunKind>('ship');
	let planPath = $state<string | null>(null);
	let prNumber = $state<number | null>(null);
	let manualPr = $state('');
	let post = $state(false);

	const project = $derived(projects.find((p) => p.key === projectKey)!);
	const projectPlans = $derived(plans.filter((p) => p.project === projectKey));
	const projectPrs = $derived(openPrs.filter((p) => p.project === projectKey));
	const plan = $derived(projectPlans.find((p) => p.path === planPath) ?? null);
	const pr = $derived(projectPrs.find((p) => p.number === prNumber) ?? null);
	const effectivePr = $derived(prNumber ?? (/^\d+$/.test(manualPr) ? Number(manualPr) : null));

	const ready = $derived(mode === 'plan' ? plan !== null : effectivePr !== null);
	const command = $derived.by(() => {
		if (mode === 'plan') {
			if (!plan) return null;
			return [`git switch -c ${plan.branch}`, commandFor({ kind, planDir: plan.path, prNumber: null, reviewId: null })];
		}
		if (effectivePr === null) return null;
		const base = commandFor({ kind, planDir: null, prNumber: effectivePr, reviewId: null });
		return [`gh pr checkout ${effectivePr}`, kind === 'review' && post ? `${base} --post` : base];
	});

	function pickProject(key: string) {
		projectKey = key;
		planPath = null;
		prNumber = null;
		manualPr = '';
	}

	function pickMode(m: Mode) {
		mode = m;
		kind = m === 'plan' ? 'ship' : 'review';
	}

	function start() {
		if (!ready) return;
		if (mode === 'plan' && plan) {
			onstart({ project, kind, planDir: plan.path, prNumber: null, title: plan.title, branch: plan.branch });
		} else if (effectivePr !== null) {
			onstart({
				project,
				kind,
				planDir: null,
				prNumber: effectivePr,
				title: pr?.title ?? `PR #${effectivePr}`,
				branch: pr?.headRef ?? null
			});
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start();
	}
</script>

<svelte:window {onkeydown} />

<div class="scrim" transition:fade={{ duration: 160 }}>
	<button type="button" class="scrim-close" aria-label="Close" onclick={onclose}></button>
	<div
		class="modal"
		role="dialog"
		aria-modal="true"
		aria-labelledby="nr-title"
		transition:scale={{ start: 0.96, duration: 200, easing: cubicOut }}
	>
		<header>
			<h2 id="nr-title">New run</h2>
			<p>The daemon starts it in the project's checkout with your current env.</p>
		</header>

		<div class="body">
			<div class="field">
				<span class="flabel">Project</span>
				<div class="projects">
					{#each projects as p (p.key)}
						<button
							type="button"
							class={['proj', p.key === projectKey && 'on']}
							style:--pc={PROJECT_COLOR[p.name]}
							onclick={() => pickProject(p.key)}
						>
							<i></i>
							<span class="pname">{p.name}</span>
							<span class="ppath">{p.path}</span>
						</button>
					{/each}
				</div>
			</div>

			<div class="field">
				<span class="flabel">Start from</span>
				<div class="seg">
					<button type="button" class={[mode === 'plan' && 'on']} onclick={() => pickMode('plan')}>A plan dir</button>
					<button type="button" class={[mode === 'pr' && 'on']} onclick={() => pickMode('pr')}>A pull request</button>
				</div>
			</div>

			<div class="field">
				<span class="flabel">Command</span>
				<div class="kinds">
					{#each mode === 'plan' ? PLAN_KINDS : PR_KINDS as k (k.kind)}
						<button type="button" class={['kindopt', kind === k.kind && 'on']} onclick={() => (kind = k.kind)}>
							<code>{k.label}</code>
							<span>{k.hint}</span>
						</button>
					{/each}
				</div>
			</div>

			{#if mode === 'plan'}
				<div class="field">
					<span class="flabel">Plan</span>
					{#if projectPlans.length === 0}
						<p class="none">No plan dirs in {project.name}. Write one with the plan-out skill.</p>
					{:else}
						<div class="list">
							{#each projectPlans as p (p.path)}
								<button type="button" class={['item', planPath === p.path && 'on']} onclick={() => (planPath = p.path)}>
									<span class="radio"></span>
									<span class="ititle">{p.title}</span>
									<span class="imeta"><code>{p.path}</code> → <code>{p.branch}</code> · {ago(p.updatedAt)}</span>
								</button>
							{/each}
						</div>
						{#if plan}
							<pre class="preview">{plan.plan}</pre>
						{/if}
					{/if}
				</div>
			{:else}
				<div class="field">
					<span class="flabel">Pull request</span>
					<div class="list">
						{#each projectPrs as p (p.number)}
							<button
								type="button"
								class={['item', prNumber === p.number && 'on']}
								onclick={() => {
									prNumber = p.number;
									manualPr = '';
								}}
							>
								<span class="radio"></span>
								<span class="ititle">#{p.number} {p.title}</span>
								<span class="imeta">
									{p.author} · <code>{p.headRef}</code> · {p.unresolvedThreads} unresolved
									{p.unresolvedThreads === 1 ? 'thread' : 'threads'}{p.lastShipReview ? ` · reviewed in ${p.lastShipReview}` : ''}
								</span>
							</button>
						{/each}
						<label class="manual">
							<span>or PR number</span>
							<input
								type="text"
								inputmode="numeric"
								placeholder="e.g. 415"
								bind:value={manualPr}
								oninput={() => (prNumber = null)}
							/>
						</label>
					</div>
					{#if kind === 'review'}
						<label class="check"><input type="checkbox" bind:checked={post} /> Post the verified findings on the PR (<code>--post</code>)</label>
					{/if}
				</div>
			{/if}
		</div>

		<footer>
			<div class="cmd">
				{#if command}
					<span class="cwd">{project.path}</span>
					{#each command as line (line)}
						<code><span class="dollar">$</span> {line}</code>
					{/each}
				{:else}
					<span class="placeholder">Pick a {mode === 'plan' ? 'plan' : 'pull request'} to see the command</span>
				{/if}
			</div>
			<div class="buttons">
				<button type="button" class="ghost" onclick={onclose}>Cancel</button>
				<button type="button" class="go" disabled={!ready} onclick={start}>Start run <kbd>⌘↵</kbd></button>
			</div>
		</footer>
	</div>
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		background: rgba(22, 26, 44, 0.32);
		backdrop-filter: blur(3px);
		display: grid;
		place-items: center;
		z-index: 50;
	}
	.scrim-close {
		all: unset;
		position: absolute;
		inset: 0;
	}
	.modal {
		position: relative;
		width: 640px;
		max-height: calc(100vh - 80px);
		display: flex;
		flex-direction: column;
		background: var(--card);
		border-radius: 18px;
		box-shadow: 0 30px 80px -20px rgba(22, 26, 44, 0.45);
		overflow: hidden;
	}
	header {
		padding: 20px 24px 6px;
	}
	h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 650;
	}
	header p {
		margin: 4px 0 0;
		font-size: 12.5px;
		color: var(--ink-2);
	}
	.body {
		padding: 12px 24px 18px;
		overflow: auto;
		display: grid;
		gap: 16px;
	}
	.field {
		display: grid;
		gap: 7px;
	}
	.flabel {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		font-weight: 650;
		color: var(--ink-3);
	}
	button {
		font: inherit;
	}
	.projects {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}
	.proj {
		all: unset;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 1px 8px;
		align-items: center;
		padding: 10px 12px;
		border-radius: 10px;
		border: 1px solid var(--line);
		cursor: pointer;
		transition:
			border-color 140ms,
			box-shadow 140ms;
	}
	.proj i {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--pc);
	}
	.proj.on {
		border-color: var(--pc);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--pc) 15%, transparent);
	}
	.pname {
		font-weight: 600;
		font-size: 13px;
	}
	.ppath {
		grid-column: 2;
		font: 10.5px var(--mono);
		color: var(--ink-3);
	}
	.seg {
		display: inline-flex;
		background: var(--canvas);
		border-radius: 9px;
		padding: 3px;
		justify-self: start;
	}
	.seg button {
		all: unset;
		padding: 6px 14px;
		border-radius: 7px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--ink-2);
		cursor: pointer;
	}
	.seg button.on {
		background: white;
		color: var(--ink);
		box-shadow: var(--shadow-sm);
	}
	.kinds {
		display: flex;
		gap: 8px;
	}
	.kindopt {
		all: unset;
		flex: 1;
		display: grid;
		gap: 3px;
		padding: 9px 11px;
		border-radius: 10px;
		border: 1px solid var(--line);
		cursor: pointer;
	}
	.kindopt code {
		font: 600 12px var(--mono);
	}
	.kindopt span {
		font-size: 11.5px;
		color: var(--ink-2);
	}
	.kindopt.on {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.kindopt.on code {
		color: var(--accent);
	}
	.list {
		display: grid;
		gap: 6px;
	}
	.item {
		all: unset;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 10px;
		align-items: center;
		padding: 10px 12px;
		border-radius: 10px;
		border: 1px solid var(--line);
		cursor: pointer;
		transition: background 120ms;
	}
	.item:hover {
		background: #fafbfe;
	}
	.item.on {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.radio {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1.5px var(--line-2);
	}
	.item.on .radio {
		box-shadow: inset 0 0 0 4px var(--accent);
	}
	.ititle {
		font-weight: 600;
		font-size: 13px;
	}
	.imeta {
		grid-column: 2;
		font-size: 11.5px;
		color: var(--ink-2);
	}
	.imeta code,
	.check code {
		font: 11px var(--mono);
	}
	.preview {
		margin: 2px 0 0;
		font: 11.5px/1.6 var(--mono);
		background: var(--canvas);
		color: var(--ink-2);
		padding: 10px 12px;
		border-radius: 9px;
		white-space: pre-wrap;
	}
	.manual {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12px;
		color: var(--ink-2);
		padding: 4px 2px;
	}
	.manual input {
		font: 13px var(--mono);
		width: 120px;
		padding: 6px 9px;
		border: 1px solid var(--line);
		border-radius: 7px;
		outline: none;
	}
	.manual input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
	.check {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 12.5px;
		color: var(--ink-2);
	}
	.check input {
		accent-color: var(--accent);
	}
	.none {
		margin: 0;
		font-size: 12.5px;
		color: var(--ink-2);
		background: var(--canvas);
		padding: 12px;
		border-radius: 9px;
	}
	footer {
		border-top: 1px solid var(--line);
		padding: 14px 24px 18px;
		display: grid;
		gap: 12px;
		background: #fbfbfe;
	}
	.cmd {
		display: grid;
		gap: 2px;
		background: #15172a;
		color: #e7e8f5;
		border-radius: 10px;
		padding: 10px 12px;
		min-height: 40px;
		align-content: center;
	}
	.cwd {
		font: 11px var(--mono);
		color: #8b8fb3;
	}
	.cmd code {
		font: 12.5px var(--mono);
	}
	.dollar {
		color: #8d7dff;
	}
	.placeholder {
		font-size: 12px;
		color: #8b8fb3;
	}
	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.ghost,
	.go {
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
	.go {
		display: inline-flex;
		gap: 8px;
		align-items: center;
		background: var(--accent);
		color: white;
		box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--accent) 70%, transparent);
	}
	.go:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.go kbd {
		font: 600 10px var(--mono);
		background: rgba(255, 255, 255, 0.2);
		border-radius: 4px;
		padding: 1px 5px;
	}
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
