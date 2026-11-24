<script lang="ts">
	import { onDestroy } from 'svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import { backOut, cubicOut } from 'svelte/easing';
	import { goto } from '$app/navigation';
	import { duration } from '#lib';
	import type { Project } from '#lib';
	import { getLaunchpad } from './state.svelte.ts';
	import { blankConfig, configPath, toJson, validate, type ProjectConfig } from './config.ts';
	import ChecksEditor from './ChecksEditor.svelte';
	import JsonPreview from './JsonPreview.svelte';
	import Toggle from './Toggle.svelte';

	const lp = getLaunchpad();
	const STEPS = ['Folder', 'Detect', 'Review', 'Check'];

	let step = $state(0);
	let path = $state('');
	let force = $state(false);
	let timers: ReturnType<typeof setTimeout>[] = [];
	const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
	onDestroy(() => timers.forEach(clearTimeout));

	const name = $derived(path.trim().replace(/\/+$/, '').split('/').at(-1) ?? '');
	const key = $derived(
		!name ? '' : path.includes('acme') ? `github.com/acme/${name}` : `github.com/f-elix/${name}`
	);
	const existing = $derived(lp.projects.find((p) => p.key === key || p.path === path.trim()));
	const pathOk = $derived(path.trim().startsWith('~/') || path.trim().startsWith('/'));

	// --- Step 2: detection -----------------------------------------------------------------
	interface Source {
		file: string;
		found: string | null;
		state: 'pending' | 'reading' | 'done';
	}
	let sources = $state<Source[]>([]);
	let detected = $state(false);
	let draft = $state<ProjectConfig>(blankConfig());

	const notes = [
		"Workspace with 3 packages: checks use the root scripts, falling back to each package's own.",
		'lint: used justfile (`just lint`) over package.json (`pnpm run lint`).',
		'format runs `pnpm run format` on the whole tree after each agent step; a command taking `{files}` (e.g. `prettier --write --ignore-unknown {files}`) only touches changed files.',
		'test locks `db` because the pg package is a dependency: add `"locks": { "db": 1 }` to ship\'s global config (`config.json` in ship\'s home), then run `ship daemon restart`; or set its lock to `cpu` if tests do not share a database.',
		'CI also runs (hints only, not added): `pnpm run build`, `pnpm run e2e`.'
	];

	function detect() {
		step = 1;
		detected = false;
		sources = [
			{ file: 'justfile', found: '4 recipes: lint, dev, seed, release', state: 'pending' },
			{ file: 'Makefile', found: null, state: 'pending' },
			{ file: 'package.json', found: 'pnpm (packageManager), 9 scripts, workspace of 3', state: 'pending' },
			{ file: 'Cargo.toml', found: null, state: 'pending' },
			{ file: 'docker-compose.yml', found: 'postgres:17 image', state: 'pending' },
			{ file: '.github/workflows/ci.yml', found: '6 run steps (hints only)', state: 'pending' }
		];
		let t = 300;
		sources.forEach((_, i) => {
			later(t, () => (sources[i].state = 'reading'));
			t += 380;
			later(t, () => (sources[i].state = 'done'));
		});
		later(t + 350, () => {
			draft = {
				...blankConfig(),
				checks: [
					{ name: 'format', run: 'pnpm exec prettier --check .', fix: 'pnpm exec prettier --write .', lock: 'cpu' },
					{ name: 'lint', run: 'just lint', lock: 'cpu' },
					{ name: 'typecheck', run: 'pnpm run typecheck', lock: 'cpu' },
					{ name: 'test', run: 'pnpm run test', lock: 'db' }
				],
				format: 'pnpm run format'
			};
			detected = true;
		});
	}

	const issues = $derived(validate(draft, lp.global.locks));
	const errors = $derived(issues.filter((i) => i.level === 'error'));
	const issuePaths = $derived(new Set(errors.map((i) => i.path)));
	const json = $derived(toJson(draft));

	// --- Step 4: run every check once ------------------------------------------------------
	interface CheckRun {
		name: string;
		run: string;
		lock: string;
		state: 'queued' | 'waiting' | 'running' | 'passed' | 'failed' | 'skipped';
		progress: number;
		ms: number;
		tail?: string;
	}
	let checkRuns = $state<CheckRun[]>([]);
	let finished = $state(false);
	const failed = $derived(checkRuns.filter((c) => c.state === 'failed'));
	const passed = $derived(checkRuns.filter((c) => c.state === 'passed'));
	const skipped = $derived(checkRuns.filter((c) => c.state === 'skipped'));

	function writeAndRun() {
		step = 3;
		finished = false;
		const project: Project = {
			key,
			name,
			path: path.trim(),
			defaultBranch: 'main',
			checks: draft.checks.map((c) => ({ ...c })),
			format: draft.format || undefined,
			reviewersDisabled: [...draft.disable],
			clef: draft.clef,
			pr: { ...draft.pr },
			models: {},
			caps: { checkFixAttempts: draft.caps.checkFixAttempts ?? lp.global.caps.checkFixAttempts, reviewRounds: draft.caps.reviewRounds ?? lp.global.caps.reviewRounds },
			conventions: ['typescript', 'testing', 'comments', 'error-handling']
		};
		if (!existing) lp.addProject(project, JSON.parse(JSON.stringify(draft)));
		else lp.configs[existing.key] = JSON.parse(JSON.stringify(draft));

		checkRuns = draft.checks.map((c) => ({
			name: c.name,
			run: c.run,
			lock: c.lock || 'cpu',
			state: c.run.includes('{files}') ? 'skipped' : 'queued',
			progress: 0,
			ms: 0
		}));
		let cpuStart = 200;
		let longest = 0;
		checkRuns.forEach((c, i) => {
			if (c.state === 'skipped') return;
			const isDb = c.lock === 'db';
			const start = isDb ? cpuStart + 900 : cpuStart + i * 160;
			const total = c.name === 'test' ? 4200 : c.name === 'typecheck' ? 2600 : 1400 + i * 300;
			if (isDb) later(cpuStart + 100, () => (checkRuns[i].state = 'waiting'));
			const waitMs = isDb ? 2100 : 0;
			later(start + waitMs, () => (checkRuns[i].state = 'running'));
			const ticks = 12;
			for (let k = 1; k <= ticks; k++) {
				later(start + waitMs + (total / ticks) * k, () => (checkRuns[i].progress = k / ticks));
			}
			const end = start + waitMs + total + 60;
			longest = Math.max(longest, end);
			later(end, () => {
				const fail = c.name === 'typecheck';
				checkRuns[i].state = fail ? 'failed' : 'passed';
				checkRuns[i].ms = total * 9 + 312;
				if (fail)
					checkRuns[i].tail =
						"src/digest/schedule.ts(42,9): error TS2322: Type 'Date | undefined' is not assignable to type 'Date'.\n  Type 'undefined' is not assignable to type 'Date'.\n\nFound 1 error in src/digest/schedule.ts:42";
			});
		});
		later(longest + 300, () => (finished = true));
	}

	function finish() {
		lp.wizardOpen = false;
		goto(`/5-launchpad/${existing?.name ?? name}`);
	}

	const close = () => (lp.wizardOpen = false);

	const parts = (text: string) =>
		text.split(/(`[^`]+`)/).map((t, i) => ({ code: t.startsWith('`') && t.length > 1, text: t.replace(/^`|`$/g, ''), i }));
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div class="scrim" transition:fade|global={{ duration: 180 }} onclick={close} role="presentation"></div>
<div class="wizard" role="dialog" aria-modal="true" aria-label="Add a project" transition:scale|global={{ start: 0.94, duration: 360, easing: backOut }}>
	<header>
		<div class="title">
			<span class="eyebrow">ship init</span>
			<h2>Add a project</h2>
		</div>
		<ol class="stepper">
			{#each STEPS as s, i (s)}
				<li class={{ done: i < step, now: i === step }}>
					<span class="num">{#if i < step}✓{:else}{i + 1}{/if}</span>
					<span>{s}</span>
				</li>
			{/each}
		</ol>
		<button type="button" class="x" aria-label="Close" onclick={close}>×</button>
	</header>

	<div class="body">
		{#if step === 0}
			<div class="pane narrow" in:fly={{ x: 30, duration: 300, easing: cubicOut }}>
				<h3>Where does it live?</h3>
				<p class="lead">The folder of a git checkout. ship keys the config by its <code>origin</code> URL.</p>
				<label class="path">
					<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></svg>
					<input bind:value={path} placeholder="~/work/acme/notifications" aria-label="Project folder" onkeydown={(e) => e.key === 'Enter' && pathOk && (!existing || force) && detect()} />
				</label>
				<div class="suggest">
					<span>Recent folders</span>
					{#each ['~/work/acme/notifications', '~/Documents/projects/dotfiles', '~/work/acme/storefront'] as s (s)}
						<button type="button" onclick={() => (path = s)}>{s}</button>
					{/each}
				</div>
				{#if key}
					<div class="keyline" in:fly={{ y: 6, duration: 200 }}>
						<span>origin</span><code>git@{key.replace('/', ':')}.git</code>
						<span>config</span><code>{configPath(key)}</code>
					</div>
				{/if}
				{#if existing}
					<div class="warn" in:fly={{ y: 6, duration: 200 }}>
						<strong>{existing.name} already has a config.</strong>
						<span><code>ship init --write</code> refuses to replace it unless you pass <code>--force</code>.</span>
						<Toggle bind:checked={force} label="Replace it (--force)" />
					</div>
				{/if}
			</div>
		{:else if step === 1}
			<div class="pane" in:fly={{ x: 30, duration: 300, easing: cubicOut }}>
				<div class="detect">
					<div class="files">
						<h3>{detected ? 'Here’s a draft' : 'Detecting…'}</h3>
						<p class="lead mono">$ ship init --detect</p>
						<ul>
							{#each sources as s (s.file)}
								<li class={[s.state, { miss: s.state === 'done' && !s.found }]}>
									<span class="dot">
										{#if s.state === 'reading'}<span class="spin"></span>{:else if s.state === 'done'}{s.found ? '✓' : '–'}{/if}
									</span>
									<span class="fname">{s.file}</span>
									{#if s.state === 'done'}<span class="found" in:fade>{s.found ?? 'not found'}</span>{/if}
								</li>
							{/each}
						</ul>
					</div>
					<div class="draft">
						{#if detected}
							<div in:fly={{ y: 10, duration: 320, easing: backOut }}>
								<div class="drafted">
									{#each draft.checks as c, i (c.name)}
										<div class="dcheck" in:scale={{ start: 0.7, delay: i * 90, duration: 320, easing: backOut }}>
											<strong>{c.name}</strong>
											<code>{c.run}</code>
											<span class={['lock', c.lock]}>{c.lock}</span>
										</div>
									{/each}
								</div>
								<h4>Notes</h4>
								<ul class="notes">
									{#each notes as n, i (i)}
										<li in:fly={{ x: 8, delay: 300 + i * 70, duration: 260 }}>
											{#each parts(n) as p (p.i)}{#if p.code}<code>{p.text}</code>{:else}{p.text}{/if}{/each}
										</li>
									{/each}
								</ul>
							</div>
						{:else}
							<div class="skeleton">
								{#each [0, 1, 2, 3] as i (i)}<span style:--d="{i * 120}ms"></span>{/each}
							</div>
						{/if}
					</div>
				</div>
			</div>
		{:else if step === 2}
			<div class="pane review" in:fly={{ x: 30, duration: 300, easing: cubicOut }}>
				<div class="edit">
					<h3>Look it over</h3>
					<p class="lead">Edit anything. Nothing is saved until the next step.</p>
					<ChecksEditor bind:checks={draft.checks} locks={Object.keys(lp.global.locks)} {issuePaths} />
					<label class="field">
						<span>Format command</span>
						<input bind:value={draft.format} />
					</label>
					<div class="toggles">
						<Toggle bind:checked={draft.clef} label="Clef decisions" />
						<Toggle bind:checked={draft.pr.draft} label="Draft PRs" />
						<Toggle bind:checked={draft.pr.squash} label="Squash" />
					</div>
					<p class="more">Reviewers, models, caps and timeouts can be tuned later in the project's settings.</p>
				</div>
				<div class="preview">
					<JsonPreview value={json} path={configPath(key)} />
					{#if errors.length}
						<div class="val err">
							{#each errors as e (e.path + e.message)}<div><code>{e.path}</code> {e.message}</div>{/each}
						</div>
					{:else}
						<div class="val ok">✓ Valid. <code>ship init --write</code> would save this.</div>
					{/if}
				</div>
			</div>
		{:else}
			<div class="pane narrow" in:fly={{ x: 30, duration: 300, easing: cubicOut }}>
				<h3>{finished ? (failed.length ? 'Saved, with one heads-up' : 'All set') : 'Running every check once'}</h3>
				<p class="lead">
					Saved <code>{configPath(key)}</code>. Now each check runs through the daemon, sharing lock permits with active runs. Fix commands are skipped, like a baseline.
				</p>
				<div class="runs">
					{#each checkRuns as c (c.name)}
						<div class={['crun', c.state]}>
							<span class="cdot">
								{#if c.state === 'passed'}<span in:scale={{ start: 0.3, easing: backOut, duration: 300 }}>✓</span>
								{:else if c.state === 'failed'}<span in:scale={{ start: 0.3, easing: backOut, duration: 300 }}>!</span>
								{:else if c.state === 'running'}<span class="spin"></span>
								{:else if c.state === 'skipped'}–{/if}
							</span>
							<div class="cmain">
								<div class="ctop">
									<strong>{c.name}</strong>
									<code>{c.run}</code>
									<span class="cstate">
										{#if c.state === 'waiting'}waiting for {c.lock} (#1 in queue){:else if c.state === 'passed'}passed in {duration(c.ms)}{:else if c.state === 'failed'}failed (exit 2) in {duration(c.ms)}{:else if c.state === 'skipped'}skipped: uses {'{files}'}{:else if c.state === 'running'}{c.lock}{:else}queued{/if}
									</span>
								</div>
								<div class="bar"><i style:width="{c.state === 'skipped' ? 0 : c.progress * 100}%"></i></div>
								{#if c.tail}<pre in:fly={{ y: -4, duration: 220 }}>{c.tail}</pre>{/if}
							</div>
						</div>
					{/each}
				</div>
				{#if finished}
					<div class={['summary', failed.length ? 'warnbox' : 'okbox']} in:fly={{ y: 8, duration: 300, easing: backOut }}>
						{#if failed.length}
							<strong>{failed.map((f) => f.name).join(', ')} fails before any change.</strong>
							<span>The config stays saved. Runs won't hold a change to it; their PRs list it under “Checks failing before this change”. Fix it on {path.includes('acme') ? 'main' : 'the default branch'} when you can.</span>
						{:else}
							<strong>{passed.length} checks pass.</strong>
						{/if}
						<span class="tally">{passed.length} passed · {failed.length} failed{skipped.length ? ` · ${skipped.length} skipped` : ''} · exit {failed.length ? 1 : 0}</span>
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<footer>
		{#if step > 0 && step < 3}
			<button type="button" class="ghost" onclick={() => (step = step === 2 ? 1 : 0)}>Back</button>
		{/if}
		<span class="grow"></span>
		{#if step === 0}
			<button type="button" class="primary" disabled={!pathOk || (!!existing && !force)} onclick={detect}>Detect checks →</button>
		{:else if step === 1}
			<button type="button" class="primary" disabled={!detected} onclick={() => (step = 2)}>Looks right, review →</button>
		{:else if step === 2}
			<span class="cmdhint">ship init --write /tmp/ship-draft.json{force ? ' --force' : ''}</span>
			<button type="button" class="primary" disabled={errors.length > 0} onclick={writeAndRun}>Save and run checks</button>
		{:else}
			<button type="button" class="primary" disabled={!finished} onclick={finish}>Open {existing?.name ?? name} →</button>
		{/if}
	</footer>
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		background: rgba(43, 32, 24, 0.34);
		backdrop-filter: blur(4px);
		z-index: 60;
	}
	.wizard {
		position: fixed;
		z-index: 61;
		top: 5vh;
		left: 50%;
		translate: -50% 0;
		width: min(1060px, calc(100vw - 80px));
		height: 90vh;
		background: var(--card);
		border-radius: 32px;
		box-shadow: 0 40px 120px -30px rgba(50, 25, 5, 0.55);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	header {
		display: flex;
		align-items: center;
		gap: 30px;
		padding: 26px 30px 22px;
		border-bottom: 1px solid var(--line);
	}
	.eyebrow {
		font: 13px var(--mono);
		color: var(--accent-ink);
	}
	h2 {
		font: 750 26px var(--display);
		margin: 2px 0 0;
	}
	.stepper {
		flex: 1;
		display: flex;
		justify-content: center;
		gap: 8px;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.stepper li {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		font-weight: 600;
		color: var(--muted);
		padding: 6px 14px 6px 6px;
		border-radius: 999px;
		transition: background 0.3s;
	}
	.stepper li.now {
		background: var(--accent-soft);
		color: var(--accent-ink);
	}
	.stepper li.done {
		color: var(--teal);
	}
	.num {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--bg-2);
		font-size: 13px;
	}
	.now .num {
		background: var(--accent);
		color: #fff;
	}
	.done .num {
		background: var(--teal);
		color: #fff;
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
	.body {
		flex: 1;
		overflow: auto;
		padding: 34px 40px;
	}
	.pane.narrow {
		max-width: 680px;
		margin: 0 auto;
	}
	h3 {
		font: 750 30px/1.15 var(--display);
		margin: 0 0 8px;
		letter-spacing: -0.01em;
	}
	h4 {
		font: 700 12px var(--sans);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--muted);
		margin: 24px 0 10px;
	}
	.lead {
		color: var(--ink-2);
		font-size: 16px;
		line-height: 1.5;
		margin: 0 0 24px;
	}
	.lead.mono {
		font: 13px var(--mono);
		color: var(--muted);
	}
	code {
		font: 0.88em var(--mono);
		background: var(--bg-2);
		padding: 1px 6px;
		border-radius: 6px;
	}
	.path {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 6px 8px 6px 20px;
		background: var(--bg);
		border: 2px solid var(--line);
		border-radius: 22px;
		transition:
			border-color 0.2s,
			box-shadow 0.2s;
	}
	.path:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 5px var(--accent-soft);
	}
	.path svg {
		width: 24px;
		height: 24px;
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.8;
	}
	.path input {
		flex: 1;
		border: 0;
		outline: 0;
		background: none;
		font: 500 20px var(--mono);
		padding: 14px 0;
		color: var(--ink);
	}
	.suggest {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 14px;
		font-size: 13px;
		color: var(--muted);
	}
	.suggest button {
		font: 12.5px var(--mono);
		border: 0;
		background: var(--bg-2);
		color: var(--ink-2);
		padding: 6px 11px;
		border-radius: 999px;
		cursor: pointer;
		transition: background 0.15s;
	}
	.suggest button:hover {
		background: var(--accent-soft);
		color: var(--accent-ink);
	}
	.keyline {
		display: grid;
		grid-template-columns: 70px 1fr;
		gap: 8px 12px;
		margin-top: 26px;
		padding: 18px 20px;
		background: var(--bg);
		border-radius: 18px;
		font-size: 13px;
		color: var(--muted);
		align-items: center;
	}
	.keyline code {
		justify-self: start;
		background: var(--card);
	}
	.warn {
		display: grid;
		gap: 10px;
		margin-top: 16px;
		padding: 18px 20px;
		background: var(--amber-soft);
		border-radius: 18px;
		font-size: 14px;
	}
	.detect {
		display: grid;
		grid-template-columns: 340px 1fr;
		gap: 40px;
	}
	.files ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.files li {
		display: grid;
		grid-template-columns: 26px 1fr;
		gap: 2px 12px;
		align-items: center;
		padding: 8px 10px;
		border-radius: 12px;
		transition: background 0.2s;
	}
	.files li.pending {
		opacity: 0.4;
	}
	.files li.reading {
		background: var(--bg);
	}
	.files li .dot {
		grid-row: span 2;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--bg-2);
		font-size: 13px;
		font-weight: 700;
	}
	.files li.done .dot {
		background: var(--teal);
		color: #fff;
	}
	.files li.miss .dot {
		background: var(--bg-2);
		color: var(--muted);
	}
	.fname {
		font: 600 13.5px var(--mono);
	}
	.found {
		font-size: 12.5px;
		color: var(--muted);
		grid-column: 2;
	}
	.spin {
		display: inline-block;
		width: 14px;
		height: 14px;
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
	.drafted {
		display: grid;
		gap: 8px;
	}
	.dcheck {
		display: grid;
		grid-template-columns: 100px 1fr auto;
		align-items: center;
		gap: 12px;
		padding: 14px 16px;
		background: var(--bg);
		border-radius: 16px;
	}
	.dcheck code {
		background: none;
		padding: 0;
	}
	.lock {
		font: 700 11.5px var(--mono);
		padding: 3px 9px;
		border-radius: 999px;
		background: var(--bg-2);
	}
	.lock.db {
		background: var(--plum-soft);
		color: var(--plum);
	}
	.notes {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 8px;
	}
	.notes li {
		font-size: 13.5px;
		line-height: 1.5;
		color: var(--ink-2);
		padding-left: 18px;
		position: relative;
	}
	.notes li::before {
		content: '';
		position: absolute;
		left: 2px;
		top: 8px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
	}
	.skeleton {
		display: grid;
		gap: 8px;
		padding-top: 70px;
	}
	.skeleton span {
		height: 52px;
		border-radius: 16px;
		background: linear-gradient(90deg, var(--bg) 0%, var(--bg-2) 50%, var(--bg) 100%);
		background-size: 200% 100%;
		animation: shimmer 1.2s var(--d) infinite linear;
	}
	@keyframes shimmer {
		from {
			background-position: 200% 0;
		}
		to {
			background-position: -200% 0;
		}
	}
	.review {
		display: grid;
		grid-template-columns: 1fr 380px;
		gap: 32px;
		align-items: start;
	}
	.field {
		display: grid;
		gap: 6px;
		margin-top: 18px;
		font-weight: 600;
		font-size: 14px;
	}
	.field input {
		font: 13px var(--mono);
		background: var(--bg);
		border: 1.5px solid transparent;
		border-radius: 12px;
		padding: 10px 12px;
		color: var(--ink);
	}
	.field input:focus {
		outline: 0;
		border-color: var(--accent);
	}
	.toggles {
		display: flex;
		gap: 28px;
		margin-top: 20px;
	}
	.more {
		font-size: 13px;
		color: var(--muted);
		margin-top: 18px;
	}
	.preview {
		display: grid;
		gap: 12px;
		position: sticky;
		top: 0;
	}
	.val {
		padding: 12px 14px;
		border-radius: 14px;
		font-size: 13px;
		display: grid;
		gap: 4px;
	}
	.val.ok {
		background: var(--teal-soft);
		color: var(--teal);
	}
	.val.err {
		background: var(--red-soft);
		color: var(--red);
	}
	.runs {
		display: grid;
		gap: 10px;
	}
	.crun {
		display: grid;
		grid-template-columns: 30px 1fr;
		gap: 14px;
		padding: 14px 16px;
		background: var(--bg);
		border-radius: 18px;
		transition: background 0.3s;
	}
	.crun.failed {
		background: var(--red-soft);
	}
	.cdot {
		width: 30px;
		height: 30px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--bg-2);
		font-weight: 800;
		color: #fff;
	}
	.passed .cdot {
		background: var(--teal);
	}
	.failed .cdot {
		background: var(--red);
	}
	.skipped .cdot {
		color: var(--muted);
	}
	.waiting .cdot {
		background: var(--amber-soft);
	}
	.ctop {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	.ctop code {
		background: none;
		padding: 0;
		color: var(--muted);
		flex: 1;
	}
	.cstate {
		font-size: 12.5px;
		color: var(--ink-2);
		white-space: nowrap;
	}
	.waiting .cstate {
		color: var(--amber);
		font-weight: 600;
	}
	.failed .cstate {
		color: var(--red);
		font-weight: 600;
	}
	.bar {
		height: 6px;
		border-radius: 999px;
		background: var(--bg-2);
		margin-top: 10px;
		overflow: hidden;
	}
	.bar i {
		display: block;
		height: 100%;
		background: var(--accent);
		border-radius: inherit;
		transition: width 0.25s linear;
	}
	.passed .bar i {
		background: var(--teal);
	}
	.failed .bar i {
		background: var(--red);
	}
	.waiting .bar {
		background: repeating-linear-gradient(-45deg, var(--bg-2) 0 8px, var(--amber-soft) 8px 16px);
		background-size: 200% 100%;
		animation: shimmer 3s linear infinite;
	}
	pre {
		margin: 10px 0 0;
		padding: 12px 14px;
		background: var(--code-bg);
		color: var(--code-ink);
		border-radius: 12px;
		font: 12px/1.55 var(--mono);
		white-space: pre-wrap;
	}
	.summary {
		display: grid;
		gap: 6px;
		margin-top: 18px;
		padding: 18px 20px;
		border-radius: 18px;
		font-size: 14px;
		line-height: 1.5;
	}
	.warnbox {
		background: var(--amber-soft);
	}
	.okbox {
		background: var(--teal-soft);
	}
	.tally {
		font: 12.5px var(--mono);
		color: var(--muted);
	}
	footer {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 18px 30px;
		border-top: 1px solid var(--line);
		background: var(--bg);
	}
	.grow {
		flex: 1;
	}
	.cmdhint {
		font: 12.5px var(--mono);
		color: var(--muted);
	}
	.primary {
		font: 700 15px var(--sans);
		padding: 13px 24px;
		border-radius: 999px;
		border: 0;
		background: var(--accent);
		color: #fff;
		cursor: pointer;
		transition: transform 0.12s;
	}
	.primary:hover:not(:disabled) {
		transform: translateY(-1px);
	}
	.primary:active:not(:disabled) {
		transform: scale(0.97);
	}
	.primary:disabled {
		background: var(--line-2);
		color: var(--ink-2);
		cursor: not-allowed;
	}
	.ghost {
		font: 600 15px var(--sans);
		padding: 12px 18px;
		border-radius: 999px;
		border: 0;
		background: none;
		color: var(--ink-2);
		cursor: pointer;
	}
	.ghost:hover {
		background: var(--bg-2);
	}
</style>
