<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import { backOut, cubicOut } from 'svelte/easing';
	import { goto } from '$app/navigation';
	import { relTime } from '#lib';
	import { getLaunchpad, type LaunchTarget } from './state.svelte.ts';
	import { MODELS, configPath, validate } from './config.ts';
	import Toggle from './Toggle.svelte';
	import Markdown from './Markdown.svelte';

	let { target }: { target: LaunchTarget } = $props();

	const lp = getLaunchpad();
	// The sheet is keyed by target in the layout, so reading the initial props once is intended.
	// svelte-ignore state_referenced_locally
	const { plan, project } = target;
	const config = $derived(lp.configs[project.key]);

	type StepState = 'pending' | 'checking' | 'ok' | 'fail';
	interface Step {
		id: string;
		label: string;
		detail: string;
		reason: string;
		failDetail: string;
	}

	// svelte-ignore state_referenced_locally
	let dirty = $state(plan.path === '.plans/guest-checkout');
	const steps: Step[] = [
		{ id: 'repo', label: 'Inside a git repository', detail: project.path, reason: 'not-a-git-repo', failDetail: '' },
		{ id: 'branch', label: 'On a feature branch', detail: `${plan.branch}, not ${project.defaultBranch}`, reason: 'on-default-branch', failDetail: `${project.defaultBranch} is the default branch; switch to a feature branch first` },
		{ id: 'plan', label: 'Plan files present', detail: `${plan.path}/spec.md · implementation-plan.md`, reason: 'missing-plan-files', failDetail: '' },
		{ id: 'config', label: 'Project config valid', detail: configPath(project.key), reason: 'invalid-config', failDetail: '' },
		{ id: 'tree', label: 'Clean tree outside the plan dir', detail: `${plan.path} is excluded from git`, reason: 'dirty-tree', failDetail: `${project.path} has uncommitted changes; commit or stash them first` }
	];
	let status = $state<Record<string, StepState>>(Object.fromEntries(steps.map((s) => [s.id, 'pending'])));
	let timers: ReturnType<typeof setTimeout>[] = [];

	const configErrors = $derived(validate(config, lp.global.locks).filter((i) => i.level === 'error'));

	const failing = $derived(steps.find((s) => status[s.id] === 'fail'));
	const allOk = $derived(steps.every((s) => status[s.id] === 'ok'));

	function shouldFail(id: string) {
		if (id === 'tree') return dirty;
		if (id === 'config') return configErrors.length > 0;
		return false;
	}

	function preflight() {
		timers.forEach(clearTimeout);
		timers = [];
		for (const s of steps) status[s.id] = 'pending';
		let t = 250;
		for (const s of steps) {
			timers.push(setTimeout(() => (status[s.id] = 'checking'), t));
			t += 420 + Math.random() * 260;
			const fail = shouldFail(s.id);
			timers.push(setTimeout(() => (status[s.id] = fail ? 'fail' : 'ok'), t));
			if (fail) return;
		}
	}

	onMount(() => {
		preflight();
		return () => timers.forEach(clearTimeout);
	});

	// Options
	let mode = $state<'run' | 'implement'>('run');
	let noChecks = $state(false);
	// svelte-ignore state_referenced_locally
	let draft = $state(config.pr.draft);
	// svelte-ignore state_referenced_locally
	let squash = $state(config.pr.squash);
	// svelte-ignore state_referenced_locally
	let clef = $state(config.clef);
	const overrideSteps = ['implement', 'fix', 'review', 'verify', 'pr'] as const;
	let models = $state<Record<string, string>>({ implement: '', fix: '', review: '', verify: '', pr: '' });
	let showSpec = $state(false);

	const inherited = (step: string) => config.models[step as keyof typeof config.models] || lp.global.models[step as keyof typeof lp.global.models];

	const command = $derived(mode === 'run' ? `ship run ${plan.path}` : `ship implement ${plan.path}${noChecks ? ' --no-checks' : ''}`);

	const overrides = $derived.by(() => {
		const out: string[] = [];
		if (mode === 'run') {
			if (draft !== config.pr.draft) out.push(`pr.draft: ${draft}`);
			if (squash !== config.pr.squash) out.push(`pr.squash: ${squash}`);
		}
		if (clef !== config.clef) out.push(`clef: ${clef}`);
		for (const s of overrideSteps) if (models[s] && models[s] !== inherited(s)) out.push(`models.${s}: ${models[s]}`);
		return out;
	});

	const pipeline = $derived(
		mode === 'run'
			? ['baseline', 'implement', 'checks', 'review', 'triage', 'fix', 'pr']
			: noChecks
				? ['implement', 'commit']
				: ['baseline', 'implement', 'checks', 'commit']
	);

	const typical = $derived.by(() => {
		const done = lp.runsFor(project.key).filter((r) => r.kind === 'ship' && r.costUsd > 0);
		if (!done.length) return null;
		return done.reduce((t, r) => t + r.costUsd, 0) / done.length;
	});

	let phase = $state<'form' | 'launching' | 'done'>('form');
	let runId = $state('');
	let copied = $state(false);

	function launch() {
		phase = 'launching';
		setTimeout(() => {
			runId = lp.startRun({ kind: mode === 'run' ? 'ship' : 'implement', project, title: plan.title, branch: plan.branch, planDir: plan.path });
			phase = 'done';
			lp.toast(`${runId} launched`, { tone: 'success', command, body: `${plan.title} · ${project.name}` });
		}, 1100);
	}

	const close = () => (lp.launch = null);

	async function copyCommand() {
		try {
			await navigator.clipboard.writeText(`cd ${project.path} && ${command}`);
		} catch {
			// Clipboard may be blocked; the feedback is what matters here.
		}
		copied = true;
		setTimeout(() => (copied = false), 1400);
	}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && phase !== 'launching' && close()} />

<div class="scrim" transition:fade|global={{ duration: 180 }} onclick={close} role="presentation"></div>
<aside class="sheet" aria-label="Launch {plan.path}" transition:fly|global={{ x: 600, duration: 420, easing: cubicOut, opacity: 1 }}>
	<header>
		<div>
			<span class="eyebrow">{project.name} · {plan.path}</span>
			<h2>{plan.title}</h2>
		</div>
		<button type="button" class="x" aria-label="Close" onclick={close}>×</button>
	</header>

	{#if phase === 'done'}
		<div class="done" in:scale={{ start: 0.85, duration: 500, easing: backOut }}>
			<div class="burst">
				{#each Array.from({ length: 10 }, (_, i) => i) as i (i)}
					<i style:--a="{i * 36}deg" style:--d="{(i % 3) * 60}ms"></i>
				{/each}
				<span class="badge">
					<svg viewBox="0 0 24 24"><path d="M6 12.5l4 3.8L18 8" /></svg>
				</span>
			</div>
			<h3><code>{runId}</code> is on its way</h3>
			<p>The daemon accepted the run. It starts with the baseline: every check once, before any change.</p>
			<div class="state-row">
				<span class="dot"></span><span class="mono">baseline.running</span><span class="muted">· just now</span>
			</div>
			<div class="cmd small"><span class="prompt">$</span> ship logs {runId} --follow</div>
			<div class="done-actions">
				<button
					type="button"
					class="primary"
					onclick={() => {
						close();
						goto(`/5-launchpad/${project.name}?run=${runId}#runs`);
					}}>Watch it on {project.name}</button
				>
				<button type="button" class="ghost" onclick={close}>Back to launchpad</button>
			</div>
		</div>
	{:else}
		<div class="scroll">
			<section>
				<h3>Preflight</h3>
				<ol class="checks">
					{#each steps as s (s.id)}
						{@const st = status[s.id]}
						<li class={st}>
							<span class="tick">
								{#if st === 'ok'}
									<svg viewBox="0 0 24 24" in:scale={{ start: 0.3, duration: 360, easing: backOut }}><path d="M6 12.5l4 3.8L18 8" /></svg>
								{:else if st === 'fail'}
									<svg viewBox="0 0 24 24" in:scale={{ start: 0.3, duration: 360, easing: backOut }}><path d="M8 8l8 8M16 8l-8 8" /></svg>
								{:else if st === 'checking'}
									<span class="spin"></span>
								{/if}
							</span>
							<span class="what">
								<span class="label">{s.label}</span>
								<span class="detail">{s.detail}</span>
							</span>
						</li>
						{#if st === 'fail'}
							<li class="error" in:fly={{ y: -6, duration: 260 }}>
								<code class="err">cannot start the run ({s.id === 'config' ? 'invalid-config' : s.reason}): {s.id === 'config' ? `${configPath(project.key)}: ${configErrors.map((e) => `${e.path} ${e.message}`).join('; ')}` : s.failDetail}</code>
								{#if s.id === 'tree'}
									<pre class="porcelain"><span>M</span>  src/lib/cart/totals.ts
<span>M</span>  src/routes/checkout/+page.svelte
<span>??</span> scratch/guest-flow.md</pre>
									<div class="fix-row">
										<button
											type="button"
											class="secondary"
											onclick={() => {
												dirty = false;
												lp.toast('Tree is clean', { body: '3 files committed as “WIP guest checkout groundwork”', command: 'git commit -am "WIP guest checkout groundwork"' });
												preflight();
											}}>I committed them, check again</button
										>
										<span class="muted">or <code>git stash push -u</code></span>
									</div>
								{:else}
									<div class="fix-row">
										<a class="secondary" href="/5-launchpad/{project.name}?tab=settings" onclick={close}>Open {project.name} settings</a>
									</div>
								{/if}
							</li>
						{/if}
					{/each}
				</ol>
				{#if allOk}
					<p class="ready" in:fly={{ y: 6, duration: 300 }}>All clear. The daemon would accept this run.</p>
				{/if}
				{#if !dirty && plan.path !== '.plans/guest-checkout'}
					<button
						type="button"
						class="linkish"
						onclick={() => {
							dirty = true;
							preflight();
						}}>Simulate a dirty tree</button
					>
				{/if}
			</section>

			<section>
				<h3>What to run</h3>
				<div class="modes" role="radiogroup" aria-label="Command">
					<button type="button" role="radio" aria-checked={mode === 'run'} class={{ on: mode === 'run' }} onclick={() => (mode = 'run')}>
						<strong>The whole loop</strong>
						<span>Implement, check, review, fix, open the PR</span>
					</button>
					<button type="button" role="radio" aria-checked={mode === 'implement'} class={{ on: mode === 'implement' }} onclick={() => (mode = 'implement')}>
						<strong>Implement only</strong>
						<span>Implement and commit; no review, no PR</span>
					</button>
				</div>
				<div class="pipeline">
					{#each pipeline as p, i (p)}
						<span class="stage" in:scale={{ start: 0.6, duration: 260, delay: i * 30, easing: backOut }}>{p}</span>
						{#if i < pipeline.length - 1}<span class="arrow">→</span>{/if}
					{/each}
				</div>

				<div class="opts">
					{#if mode === 'implement'}
						<Toggle bind:checked={noChecks} label="Skip checks (--no-checks)" hint="No baseline and no checks; commits the implementer's work as it is." />
					{:else}
						<Toggle bind:checked={draft} label="Open as a draft PR" hint="Always a draft when the run escalates." />
						<Toggle bind:checked={squash} label="Squash to one commit" hint="Before the PR opens." />
					{/if}
					<Toggle
						bind:checked={clef}
						label="Clef decisions"
						hint={lp.daemon.clefConfigured ? 'Reviewer routing, review model, lowering must-fix, unrelated check failures.' : 'No Cloudflare credentials: every decision falls back to the rules.'}
					/>
				</div>

				<div class="models">
					<span class="sub">Models for this run</span>
					<div class="model-grid">
						{#each overrideSteps as s (s)}
							<label class={{ changed: models[s] && models[s] !== inherited(s) }}>
								<span>{s}</span>
								<select bind:value={models[s]}>
									<option value="">{inherited(s)} (config)</option>
									{#each MODELS as m (m)}
										<option value={m}>{m}</option>
									{/each}
								</select>
							</label>
						{/each}
					</div>
				</div>
			</section>

			<section>
				<button type="button" class="spec-toggle" onclick={() => (showSpec = !showSpec)} aria-expanded={showSpec}>
					<span>spec.md</span>
					<span class="muted">updated {relTime(plan.updatedAt)}</span>
					<span class={['chev', { open: showSpec }]}>⌄</span>
				</button>
				{#if showSpec}
					<div class="spec" transition:fly={{ y: -8, duration: 220 }}>
						<Markdown source={plan.spec} />
					</div>
				{/if}
			</section>
		</div>

		<footer>
			<div class="cmd">
				<div><span class="prompt">$</span> cd {project.path}</div>
				<div>
					<span class="prompt">$</span>
					{#key command}<span class="flash">{command}</span>{/key}
				</div>
				{#if overrides.length}
					<div class="overrides" transition:fly={{ y: 4, duration: 200 }}>
						<span># run overrides, sent with the request; your config is unchanged</span>
						{#each overrides as o (o)}<span class="ov">{o}</span>{/each}
					</div>
				{/if}
				<button type="button" class="copy" onclick={copyCommand}>{copied ? 'Copied' : 'Copy'}</button>
			</div>
			<div class="launch-row">
				<span class="muted small-text">
					{#if typical}Typical {project.name} run: <strong>${typical.toFixed(2)}</strong>{/if}
				</span>
				<button type="button" class={['launch', phase]} disabled={!allOk || phase !== 'form'} onclick={launch}>
					<svg viewBox="0 0 24 24" class="rocket"><path d="M12 15l-3-3c1-4 4-8 9-9 0 5-4 8-9 9" /><path d="M9 12H5l2-3h4M12 15v4l3-2v-4" /><path d="M6 16c-1 1-1.5 3-1.5 3.5S7 19 8 18" /></svg>
					{phase === 'launching' ? 'Launching…' : failing ? 'Fix preflight first' : allOk ? 'Launch' : 'Checking…'}
				</button>
			</div>
		</footer>
	{/if}
</aside>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		background: rgba(43, 32, 24, 0.3);
		backdrop-filter: blur(2px);
		z-index: 60;
	}
	.sheet {
		position: fixed;
		z-index: 61;
		top: 12px;
		right: 12px;
		bottom: 12px;
		width: 580px;
		background: var(--card);
		border-radius: 30px;
		box-shadow: -30px 0 80px -30px rgba(50, 25, 5, 0.45);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		padding: 28px 30px 18px;
	}
	.eyebrow {
		font: 13px var(--mono);
		color: var(--accent-ink);
	}
	h2 {
		font: 750 28px/1.15 var(--display);
		margin: 6px 0 0;
		letter-spacing: -0.01em;
	}
	.x {
		width: 38px;
		height: 38px;
		border-radius: 50%;
		border: 0;
		background: var(--bg-2);
		font-size: 22px;
		cursor: pointer;
		color: var(--ink-2);
		transition: transform 0.2s;
	}
	.x:hover {
		transform: rotate(90deg);
	}
	.scroll {
		flex: 1;
		overflow: auto;
		padding: 0 30px 20px;
	}
	section {
		padding: 18px 0;
		border-top: 1px solid var(--line);
	}
	h3 {
		font: 700 12px var(--sans);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--muted);
		margin: 0 0 14px;
	}
	.checks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 4px;
	}
	.checks li {
		display: flex;
		gap: 14px;
		align-items: center;
		padding: 8px 10px;
		border-radius: 14px;
		transition: background 0.3s;
	}
	.checks li.pending {
		opacity: 0.45;
	}
	.checks li.checking {
		background: var(--bg);
	}
	.tick {
		flex: none;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--bg-2);
		transition: background 0.3s;
	}
	.ok .tick {
		background: var(--teal);
	}
	.fail .tick {
		background: var(--red);
	}
	.tick svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: #fff;
		stroke-width: 2.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.spin {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2.5px solid var(--accent-soft);
		border-top-color: var(--accent);
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.what {
		display: grid;
		gap: 1px;
	}
	.label {
		font-weight: 600;
		font-size: 15px;
	}
	.detail {
		font: 12.5px var(--mono);
		color: var(--muted);
	}
	.checks li.error {
		display: block;
		margin: 2px 0 6px 42px;
		padding: 14px 16px;
		background: var(--red-soft);
		border-radius: 16px;
	}
	.err {
		font: 12.5px/1.5 var(--mono);
		color: var(--red);
		display: block;
	}
	.porcelain {
		margin: 10px 0 0;
		font: 12.5px/1.6 var(--mono);
		color: var(--ink-2);
	}
	.porcelain span {
		color: var(--red);
		display: inline-block;
		width: 22px;
	}
	.fix-row {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 12px;
		font-size: 13px;
	}
	.fix-row code {
		font: 12px var(--mono);
	}
	.secondary {
		font: 600 13.5px var(--sans);
		background: var(--card);
		color: var(--ink);
		border: 0;
		border-radius: 999px;
		padding: 8px 14px;
		cursor: pointer;
		box-shadow: 0 1px 2px rgba(60, 30, 10, 0.12);
		text-decoration: none;
	}
	.secondary:active {
		transform: scale(0.97);
	}
	.ready {
		margin: 12px 0 0 10px;
		color: var(--teal);
		font-weight: 600;
		font-size: 14px;
	}
	.linkish {
		margin: 8px 0 0 10px;
		background: none;
		border: 0;
		padding: 0;
		color: var(--muted);
		font: 12.5px var(--sans);
		text-decoration: underline dotted;
		cursor: pointer;
	}
	.modes {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	.modes button {
		text-align: left;
		display: grid;
		gap: 3px;
		padding: 14px 16px;
		border-radius: 18px;
		border: 1.5px solid var(--line);
		background: var(--card);
		cursor: pointer;
		font: inherit;
		color: var(--ink);
		transition:
			border-color 0.2s,
			background 0.2s,
			transform 0.12s;
	}
	.modes button:active {
		transform: scale(0.98);
	}
	.modes button.on {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.modes strong {
		font-size: 15px;
	}
	.modes span {
		font-size: 13px;
		color: var(--ink-2);
	}
	.pipeline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin: 14px 0 18px;
	}
	.stage {
		font: 12px var(--mono);
		padding: 3px 9px;
		border-radius: 999px;
		background: var(--bg-2);
		color: var(--ink-2);
	}
	.arrow {
		color: var(--muted);
		font-size: 12px;
	}
	.opts {
		display: grid;
		gap: 14px;
	}
	.models {
		margin-top: 20px;
	}
	.sub {
		font-weight: 600;
		font-size: 14.5px;
	}
	.model-grid {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 8px;
		margin-top: 10px;
	}
	.model-grid label {
		display: grid;
		gap: 4px;
		font: 12px var(--mono);
		color: var(--muted);
	}
	.model-grid select {
		font: 600 13px var(--sans);
		padding: 7px 8px;
		border-radius: 10px;
		border: 1.5px solid var(--line);
		background: var(--card);
		color: var(--ink);
		width: 100%;
	}
	.model-grid label.changed select {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.spec-toggle {
		width: 100%;
		display: flex;
		gap: 10px;
		align-items: center;
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
		font: 600 14px var(--mono);
		color: var(--ink);
	}
	.spec-toggle .muted {
		font: 13px var(--sans);
		flex: 1;
		text-align: left;
	}
	.chev {
		transition: transform 0.2s;
		font-size: 18px;
	}
	.chev.open {
		transform: rotate(180deg);
	}
	.spec {
		margin-top: 12px;
		padding: 16px 18px;
		background: var(--bg);
		border-radius: 16px;
	}
	footer {
		padding: 16px 30px 24px;
		border-top: 1px solid var(--line);
		background: var(--bg);
	}
	.cmd {
		position: relative;
		background: var(--code-bg);
		color: var(--code-ink);
		border-radius: 16px;
		padding: 14px 16px;
		font: 13.5px/1.7 var(--mono);
	}
	.cmd.small {
		margin: 16px auto 0;
		max-width: 360px;
		font-size: 13px;
	}
	.prompt {
		color: var(--accent);
		margin-right: 6px;
	}
	.flash {
		animation: flash 0.6s ease-out;
		border-radius: 4px;
	}
	@keyframes flash {
		from {
			background: rgba(247, 181, 138, 0.35);
		}
		to {
			background: transparent;
		}
	}
	.overrides {
		margin-top: 6px;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		font-size: 12px;
	}
	.overrides > span:first-child {
		width: 100%;
		opacity: 0.55;
	}
	.ov {
		background: rgba(247, 181, 138, 0.16);
		color: #f7b58a;
		padding: 1px 8px;
		border-radius: 6px;
	}
	.copy {
		position: absolute;
		top: 10px;
		right: 10px;
		font: 600 12px var(--sans);
		color: var(--code-ink);
		background: rgba(255, 235, 210, 0.1);
		border: 0;
		border-radius: 8px;
		padding: 5px 10px;
		cursor: pointer;
	}
	.launch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 16px;
	}
	.small-text {
		font-size: 13.5px;
	}
	.launch {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font: 700 17px var(--display);
		padding: 14px 28px 14px 22px;
		border-radius: 999px;
		border: 0;
		background: var(--accent);
		color: #fff;
		cursor: pointer;
		box-shadow: 0 10px 24px -10px color-mix(in srgb, var(--accent) 80%, transparent);
		transition:
			transform 0.15s,
			box-shadow 0.2s,
			background 0.2s;
	}
	.launch:hover:not(:disabled) {
		transform: translateY(-2px);
		box-shadow: 0 16px 30px -12px color-mix(in srgb, var(--accent) 90%, transparent);
	}
	.launch:active:not(:disabled) {
		transform: scale(0.96);
	}
	.launch:disabled {
		background: var(--line-2);
		color: var(--ink-2);
		box-shadow: none;
		cursor: not-allowed;
	}
	.launch.launching {
		background: var(--accent);
		color: #fff;
	}
	.rocket {
		width: 22px;
		height: 22px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.launch:hover:not(:disabled) .rocket {
		animation: wobble 0.5s ease-in-out infinite alternate;
	}
	.launching .rocket {
		animation: liftoff 1.1s cubic-bezier(0.5, 0, 0.75, 0) forwards;
	}
	@keyframes wobble {
		from {
			transform: translate(0, 0) rotate(-4deg);
		}
		to {
			transform: translate(1px, -2px) rotate(4deg);
		}
	}
	@keyframes liftoff {
		0% {
			transform: translate(0, 0);
		}
		30% {
			transform: translate(-1px, 1px);
		}
		100% {
			transform: translate(60px, -60px) scale(0.6);
			opacity: 0;
		}
	}
	.done {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 0 40px 60px;
	}
	.burst {
		position: relative;
		width: 120px;
		height: 120px;
		display: grid;
		place-items: center;
		margin-bottom: 18px;
	}
	.burst i {
		position: absolute;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
		animation: burst 0.8s var(--d) cubic-bezier(0.2, 0.8, 0.3, 1) both;
	}
	.burst i:nth-child(3n) {
		background: var(--teal);
	}
	.burst i:nth-child(4n) {
		background: var(--amber);
	}
	@keyframes burst {
		from {
			transform: rotate(var(--a)) translateY(0) scale(1.4);
			opacity: 1;
		}
		to {
			transform: rotate(var(--a)) translateY(-58px) scale(0.4);
			opacity: 0;
		}
	}
	.badge {
		width: 84px;
		height: 84px;
		border-radius: 50%;
		background: var(--teal);
		display: grid;
		place-items: center;
		box-shadow: 0 16px 36px -14px var(--teal);
	}
	.badge svg {
		width: 42px;
		height: 42px;
		fill: none;
		stroke: #fff;
		stroke-width: 2.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.done h3 {
		font: 750 26px var(--display);
		text-transform: none;
		letter-spacing: -0.01em;
		color: var(--ink);
		margin: 0 0 8px;
	}
	.done h3 code {
		font-family: var(--mono);
		color: var(--accent-ink);
	}
	.done p {
		color: var(--ink-2);
		margin: 0 0 14px;
		max-width: 380px;
		line-height: 1.5;
	}
	.state-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
		animation: pulse 1.4s infinite;
	}
	@keyframes pulse {
		50% {
			box-shadow: 0 0 0 6px var(--accent-soft);
		}
	}
	.mono {
		font-family: var(--mono);
	}
	.muted {
		color: var(--muted);
	}
	.done-actions {
		display: flex;
		gap: 10px;
		margin-top: 26px;
	}
	.primary {
		font: 700 15px var(--sans);
		padding: 12px 22px;
		border-radius: 999px;
		border: 0;
		background: var(--accent);
		color: #fff;
		cursor: pointer;
	}
	.ghost {
		font: 600 15px var(--sans);
		padding: 12px 18px;
		border-radius: 999px;
		border: 0;
		background: var(--bg-2);
		color: var(--ink);
		cursor: pointer;
	}
	.primary:active,
	.ghost:active {
		transform: scale(0.97);
	}
</style>
