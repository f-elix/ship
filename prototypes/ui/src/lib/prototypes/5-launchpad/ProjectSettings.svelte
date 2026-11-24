<script lang="ts">
	import { fly } from 'svelte/transition';
	import { reviewers } from '#lib';
	import type { Project } from '#lib';
	import { getLaunchpad } from './state.svelte.ts';
	import { MODELS, MODEL_STEPS, STEP_HINTS, TIMEOUT_KEYS, cloneConfig, configPath, toJson, validate } from './config.ts';
	import ChecksEditor from './ChecksEditor.svelte';
	import JsonPreview from './JsonPreview.svelte';
	import Toggle from './Toggle.svelte';

	let { project }: { project: Project } = $props();
	const lp = getLaunchpad();

	// Keyed by project in the page, so the draft starts from the saved config once.
	// svelte-ignore state_referenced_locally
	const initial = lp.configs[project.key];
	let draft = $state(cloneConfig(initial));
	let saved = $state(JSON.stringify(initial));
	let checksKey = $state(0);

	const json = $derived(toJson(draft));
	const issues = $derived(validate(draft, lp.global.locks));
	const errors = $derived(issues.filter((i) => i.level === 'error'));
	const issuePaths = $derived(new Set(issues.filter((i) => i.level === 'error').map((i) => i.path)));
	const dirty = $derived(JSON.stringify(draft) !== saved);
	const lockNames = $derived(Object.keys(lp.global.locks));
	const enabledCount = $derived(reviewers.length - draft.disable.length);
	let shake = $state(false);

	function toggleReviewer(name: string) {
		if (draft.disable.includes(name)) draft.disable = draft.disable.filter((n) => n !== name);
		else draft.disable.push(name);
	}

	function save() {
		if (errors.length) {
			shake = true;
			setTimeout(() => (shake = false), 500);
			return;
		}
		lp.configs[project.key] = cloneConfig(draft);
		saved = JSON.stringify(draft);
		lp.toast('Config saved', {
			tone: 'success',
			body: 'The next run loads it; active runs keep the config they started with.',
			command: configPath(project.key)
		});
	}

	function revert() {
		draft = cloneConfig(lp.configs[project.key]);
		checksKey++;
	}

	const globalModel = (s: (typeof MODEL_STEPS)[number]) => lp.global.models[s];
</script>

<div class="settings">
	<div class="form">
		<section class="card">
			<header>
				<h3>Checks</h3>
				<p>Run on every pass, each holding its lock while it runs. A <code>fix</code> command runs first on every pass except the baseline.</p>
			</header>
			{#key checksKey}
				<ChecksEditor bind:checks={draft.checks} locks={lockNames} {issuePaths} />
			{/key}
			<label class="field">
				<span class="flabel">Format command <em>after every agent step, before checks</em></span>
				<input class="mono" bind:value={draft.format} placeholder="pnpm exec prettier --write {'{files}'}" />
			</label>
		</section>

		<section class="card">
			<header>
				<h3>Reviewers <span class="count">{enabledCount} of {reviewers.length} on</span></h3>
				<p>Each round picks reviewers by their triggers{draft.clef ? ', then Clef may add others' : ''}. A disabled reviewer never runs here.</p>
			</header>
			<div class="reviewers">
				{#each reviewers as r (r.name)}
					{@const on = !draft.disable.includes(r.name)}
					<button type="button" class={['rv', { on }]} aria-pressed={on} onclick={() => toggleReviewer(r.name)}>
						<span class="rv-top">
							<span class="rv-name">{r.name}</span>
							{#if r.model}<span class={['badge', r.model]}>{r.model}</span>{/if}
						</span>
						<span class="rv-trig">{r.triggers}</span>
						<span class="tip" role="tooltip">{r.description}{r.model ? '' : ' Uses the review model for the change’s risk.'}</span>
						<span class="sw" aria-hidden="true"><i></i></span>
					</button>
				{/each}
			</div>
		</section>

		<section class="card two">
			<div>
				<header><h3>Clef</h3></header>
				<Toggle
					bind:checked={draft.clef}
					label="Ask Clef for judgement calls"
					hint="Reviewer routing, review model by risk, convention topics, lowering taste-only must-fix, unlabelled threads, unrelated check failures. Falls back to the rules when off or unavailable."
				/>
			</div>
			<div>
				<header><h3>Pull request</h3></header>
				<div class="stack">
					<Toggle bind:checked={draft.pr.draft} label="Open as draft" hint="Always a draft when escalated." />
					<Toggle bind:checked={draft.pr.squash} label="Squash before opening" hint="ship pr never squashes." />
				</div>
			</div>
		</section>

		<section class="card">
			<header>
				<h3>Models</h3>
				<p>Per step; empty inherits <code>~/.ship/config.json</code>.</p>
			</header>
			<div class="models">
				{#each MODEL_STEPS as s (s)}
					<div class={['model', { set: draft.models[s] }]}>
						<span class="m-step">{s}</span>
						<span class="m-hint">{STEP_HINTS[s]}</span>
						<span class="seg" role="radiogroup" aria-label="{s} model">
							<button type="button" role="radio" aria-checked={!draft.models[s]} class={{ on: !draft.models[s] }} onclick={() => (draft.models[s] = '')}>
								inherit <em>{globalModel(s)}</em>
							</button>
							{#each MODELS as m (m)}
								<button type="button" role="radio" aria-checked={draft.models[s] === m} class={[m, { on: draft.models[s] === m }]} onclick={() => (draft.models[s] = m)}>{m}</button>
							{/each}
						</span>
					</div>
				{/each}
			</div>
		</section>

		<section class="card two">
			<div>
				<header><h3>Caps</h3><p>Loops before escalating.</p></header>
				<div class="caps">
					{@render cap('checkFixAttempts', 'Check-fix attempts per round', 'M', 0, lp.global.caps.checkFixAttempts)}
					{@render cap('reviewRounds', 'Review rounds', 'N', 1, lp.global.caps.reviewRounds)}
				</div>
			</div>
			<div>
				<header><h3>Timeouts</h3><p>Lock waits don't count. Empty inherits.</p></header>
				<div class="timeouts">
					{#each TIMEOUT_KEYS as k (k)}
						<label class={{ bad: issuePaths.has(`timeouts.${k}`) }}>
							<span>{k}</span>
							<input bind:value={draft.timeouts[k]} placeholder={lp.timeoutDefault(k)} />
						</label>
					{/each}
				</div>
			</div>
		</section>
	</div>

	<aside class="side">
		<JsonPreview value={json} path={configPath(project.key)} />
		<div class={['validation', errors.length ? 'err' : 'ok']}>
			{#if errors.length === 0}
				<strong>✓ Valid</strong>
				<span>ship would load this config as it is.</span>
			{:else}
				<strong>{errors.length} problem{errors.length === 1 ? '' : 's'} to fix before saving</strong>
			{/if}
			{#each issues as i (i.path + i.message)}
				<div class={['issue', i.level]} transition:fly={{ y: -4, duration: 180 }}>
					<code>{i.path}</code>
					<span>{i.message}</span>
				</div>
			{/each}
		</div>
	</aside>
</div>

{#if dirty}
	<div class="savebar" transition:fly={{ y: 80, duration: 320 }}>
		<span><i></i>Unsaved changes to <code>{configPath(project.key)}</code></span>
		<button type="button" class="ghost" onclick={revert}>Revert</button>
		<button type="button" class={['save', { shake, blocked: errors.length > 0 }]} onclick={save}>
			{errors.length ? `Fix ${errors.length} problem${errors.length === 1 ? '' : 's'}` : 'Save config'}
		</button>
	</div>
{/if}

{#snippet cap(key: 'checkFixAttempts' | 'reviewRounds', label: string, letter: string, min: number, inherited: number)}
	{@const v = draft.caps[key]}
	<div class="cap">
		<span class="cap-label"><b>{letter}</b> {label}</span>
		<div class="stepper">
			<button type="button" aria-label="Fewer" onclick={() => (draft.caps[key] = Math.max(min, (v ?? inherited) - 1))}>−</button>
			<span class={['val', { inherit: v === null }]}>{v ?? inherited}</span>
			<button type="button" aria-label="More" onclick={() => (draft.caps[key] = (v ?? inherited) + 1)}>+</button>
		</div>
		{#if v === null}
			<span class="inh">inherited</span>
		{:else}
			<button type="button" class="reset" onclick={() => (draft.caps[key] = null)}>reset</button>
		{/if}
	</div>
{/snippet}

<style>
	.settings {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 420px;
		gap: 28px;
		align-items: start;
		padding-bottom: 90px;
	}
	.form {
		display: grid;
		gap: 20px;
	}
	.card {
		background: var(--card);
		border-radius: var(--radius);
		padding: 26px 28px;
		box-shadow: var(--shadow-sm);
	}
	.card.two {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 36px;
	}
	header {
		margin-bottom: 16px;
	}
	h3 {
		font: 700 20px var(--display);
		margin: 0;
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	header p {
		margin: 4px 0 0;
		color: var(--ink-2);
		font-size: 14px;
		line-height: 1.5;
	}
	code {
		font: 0.88em var(--mono);
		background: var(--bg-2);
		padding: 1px 5px;
		border-radius: 5px;
	}
	.count {
		font: 600 13px var(--sans);
		color: var(--accent-ink);
		background: var(--accent-soft);
		padding: 2px 9px;
		border-radius: 999px;
	}
	.field {
		display: grid;
		gap: 6px;
		margin-top: 20px;
	}
	.flabel {
		font-weight: 600;
		font-size: 14px;
	}
	.flabel em {
		font-style: normal;
		font-weight: 400;
		color: var(--muted);
		margin-left: 6px;
	}
	.field input,
	.timeouts input {
		font: 13px var(--mono);
		color: var(--ink);
		background: var(--bg);
		border: 1.5px solid transparent;
		border-radius: 12px;
		padding: 10px 12px;
	}
	.field input:focus,
	.timeouts input:focus {
		outline: 0;
		border-color: var(--accent);
		background: var(--card);
	}
	.reviewers {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
	}
	.rv {
		position: relative;
		text-align: left;
		display: grid;
		gap: 4px;
		padding: 14px 14px 14px 16px;
		border-radius: 18px;
		border: 1.5px solid var(--line);
		background: var(--bg);
		cursor: pointer;
		font: inherit;
		color: var(--ink);
		transition:
			transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1),
			background 0.2s,
			border-color 0.2s,
			opacity 0.2s;
		opacity: 0.6;
	}
	.rv.on {
		opacity: 1;
		background: var(--card);
		border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
	}
	.rv:hover {
		transform: translateY(-2px);
	}
	.rv:active {
		transform: scale(0.97);
	}
	.rv-top {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-right: 36px;
	}
	.rv-name {
		font-weight: 700;
		font-size: 14.5px;
	}
	.rv:not(.on) .rv-name {
		text-decoration: line-through;
		text-decoration-color: var(--muted);
	}
	.rv-trig {
		font: 12px var(--mono);
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.badge {
		font: 700 10.5px var(--mono);
		padding: 2px 7px;
		border-radius: 999px;
		text-transform: lowercase;
	}
	.badge.opus {
		background: var(--plum-soft);
		color: var(--plum);
	}
	.badge.sonnet {
		background: var(--accent-soft);
		color: var(--accent-ink);
	}
	.badge.haiku {
		background: var(--teal-soft);
		color: var(--teal);
	}
	.sw {
		position: absolute;
		top: 14px;
		right: 14px;
		width: 28px;
		height: 16px;
		border-radius: 999px;
		background: var(--line-2);
		transition: background 0.2s;
	}
	.sw i {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #fff;
		transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.on .sw {
		background: var(--accent);
	}
	.on .sw i {
		transform: translateX(12px);
	}
	.tip {
		position: absolute;
		left: 10px;
		right: 10px;
		bottom: calc(100% + 8px);
		background: var(--ink);
		color: var(--bg);
		font-size: 12.5px;
		line-height: 1.45;
		padding: 10px 12px;
		border-radius: 12px;
		opacity: 0;
		transform: translateY(4px);
		pointer-events: none;
		transition:
			opacity 0.15s,
			transform 0.15s;
		z-index: 5;
		box-shadow: 0 12px 30px -12px rgba(40, 20, 5, 0.5);
	}
	.rv:hover .tip,
	.rv:focus-visible .tip {
		opacity: 1;
		transform: none;
		transition-delay: 0.25s;
	}
	.stack {
		display: grid;
		gap: 14px;
	}
	.models {
		display: grid;
		gap: 4px;
	}
	.model {
		display: grid;
		grid-template-columns: 130px 1fr auto;
		align-items: center;
		gap: 14px;
		padding: 8px 0;
		border-bottom: 1px dashed var(--line);
	}
	.model:last-child {
		border-bottom: 0;
	}
	.m-step {
		font: 600 13.5px var(--mono);
	}
	.model.set .m-step {
		color: var(--accent-ink);
	}
	.m-hint {
		font-size: 13px;
		color: var(--muted);
	}
	.seg {
		display: inline-flex;
		background: var(--bg);
		border-radius: 999px;
		padding: 3px;
		gap: 2px;
	}
	.seg button {
		font: 600 12.5px var(--sans);
		border: 0;
		background: none;
		padding: 6px 12px;
		border-radius: 999px;
		cursor: pointer;
		color: var(--ink-2);
		transition: background 0.15s;
	}
	.seg button em {
		font-style: normal;
		opacity: 0.6;
		font-weight: 500;
	}
	.seg button.on {
		background: var(--card);
		color: var(--ink);
		box-shadow: 0 1px 3px rgba(60, 30, 10, 0.15);
	}
	.seg button.on.opus {
		background: var(--plum);
		color: #fff;
	}
	.seg button.on.sonnet {
		background: var(--accent);
		color: #fff;
	}
	.seg button.on.haiku {
		background: var(--teal);
		color: #fff;
	}
	.caps {
		display: grid;
		gap: 16px;
	}
	.cap {
		display: grid;
		grid-template-columns: 1fr auto 60px;
		align-items: center;
		gap: 12px;
	}
	.cap-label {
		font-size: 14px;
	}
	.cap-label b {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 7px;
		background: var(--bg-2);
		font: 700 12px var(--mono);
		margin-right: 4px;
	}
	.stepper {
		display: flex;
		align-items: center;
		background: var(--bg);
		border-radius: 999px;
		padding: 3px;
	}
	.stepper button {
		width: 30px;
		height: 30px;
		border-radius: 50%;
		border: 0;
		background: var(--card);
		font-size: 17px;
		cursor: pointer;
		color: var(--ink);
		box-shadow: 0 1px 2px rgba(60, 30, 10, 0.12);
	}
	.stepper button:active {
		transform: scale(0.9);
	}
	.val {
		width: 36px;
		text-align: center;
		font: 700 16px var(--display);
	}
	.val.inherit {
		color: var(--muted);
	}
	.inh {
		font-size: 12px;
		color: var(--muted);
	}
	.reset {
		font: 12px var(--sans);
		color: var(--accent-ink);
		background: none;
		border: 0;
		cursor: pointer;
		text-decoration: underline;
		padding: 0;
	}
	.timeouts {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: 8px;
	}
	.timeouts label {
		display: grid;
		gap: 3px;
		font: 11.5px var(--mono);
		color: var(--muted);
	}
	.timeouts input {
		padding: 7px 9px;
		font-size: 12px;
		width: 100%;
		min-width: 0;
	}
	.timeouts label.bad input {
		border-color: var(--red);
		background: var(--red-soft);
	}
	.side {
		position: sticky;
		top: 96px;
		display: grid;
		gap: 14px;
	}
	.validation {
		display: grid;
		gap: 8px;
		padding: 16px 18px;
		border-radius: 18px;
		font-size: 13.5px;
	}
	.validation.ok {
		background: var(--teal-soft);
		color: var(--teal);
	}
	.validation.err {
		background: var(--red-soft);
		color: var(--red);
	}
	.validation > span {
		color: var(--ink-2);
	}
	.issue {
		display: grid;
		gap: 2px;
		padding: 8px 10px;
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.55);
		color: var(--ink-2);
	}
	.issue code {
		background: none;
		padding: 0;
		font-weight: 600;
	}
	.issue.error code {
		color: var(--red);
	}
	.issue.warning code {
		color: var(--amber);
	}
	.savebar {
		position: fixed;
		left: 50%;
		bottom: 26px;
		translate: -50% 0;
		display: flex;
		align-items: center;
		gap: 12px;
		background: var(--ink);
		color: var(--bg);
		padding: 10px 10px 10px 22px;
		border-radius: 999px;
		box-shadow: 0 20px 50px -20px rgba(40, 20, 5, 0.6);
		z-index: 40;
		font-size: 14px;
	}
	.savebar span {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-right: 8px;
	}
	.savebar i {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
	}
	.savebar code {
		background: rgba(255, 240, 220, 0.1);
		color: #f7b58a;
	}
	.savebar .ghost {
		font: 600 14px var(--sans);
		background: none;
		border: 0;
		color: var(--bg);
		opacity: 0.75;
		padding: 10px 14px;
		cursor: pointer;
	}
	.save {
		font: 700 14px var(--sans);
		background: var(--accent);
		color: #fff;
		border: 0;
		border-radius: 999px;
		padding: 11px 20px;
		cursor: pointer;
	}
	.save.blocked {
		background: var(--red);
	}
	.save:active {
		transform: scale(0.96);
	}
	.shake {
		animation: shake 0.45s;
	}
	@keyframes shake {
		20%,
		60% {
			transform: translateX(-5px);
		}
		40%,
		80% {
			transform: translateX(5px);
		}
	}
</style>
