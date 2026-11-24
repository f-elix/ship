<script lang="ts">
	import { onMount } from 'svelte';
	import { fly, scale, slide } from 'svelte/transition';
	import { backOut } from 'svelte/easing';
	import { flip } from 'svelte/animate';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { relTime } from '#lib';
	import { getLaunchpad } from '#lib/prototypes/5-launchpad/state.svelte.ts';
	import { MODELS, MODEL_STEPS, SCHEMA_BASE, STEP_HINTS } from '#lib/prototypes/5-launchpad/config.ts';
	import JsonPreview from '#lib/prototypes/5-launchpad/JsonPreview.svelte';
	import StatusPill from '#lib/prototypes/5-launchpad/StatusPill.svelte';

	const lp = getLaunchpad();

	const SCHEMA_MODEL_DEFAULTS: Record<string, string> = { implement: 'opus', fix: 'opus', review: 'sonnet', reviewTrivial: 'haiku', reviewRisky: 'opus', verify: 'sonnet', pr: 'sonnet' };

	// --- Daemon ---------------------------------------------------------------------------
	const uptime = $derived(relTime(lp.daemon.startedAt).replace(' ago', ''));
	let busy = $state<'restart' | 'stop' | null>(null);

	function daemonAction(kind: 'restart' | 'stop') {
		const active = lp.activeRuns;
		const verb = kind === 'restart' ? 'Restart' : 'Stop';
		const go = (force: boolean) => {
			busy = kind;
			setTimeout(() => {
				busy = null;
				if (kind === 'restart') lp.restartDaemon(force);
				else lp.stopDaemon(force);
			}, 900);
		};
		if (active.length === 0) return go(false);
		lp.toast(`${verb} refused`, {
			tone: 'warn',
			command: `ship daemon ${kind}`,
			body: `${active.length} runs are active. --force interrupts them.`
		});
		lp.confirm({
			title: `${verb} refused while runs are active`,
			body: `${active.map((r) => r.runId).join(', ')} ${active.length === 1 ? 'is' : 'are'} still going. --force interrupts ${active.length === 1 ? 'it' : 'them'}, and ship resume <id> continues ${active.length === 1 ? 'it' : 'them'} later from where ${active.length === 1 ? 'it' : 'they'} stopped.`,
			confirmLabel: 'Leave them running',
			tone: 'accent',
			onConfirm: () => {},
			alt: { label: `${verb} with --force`, command: `ship daemon ${kind} --force`, onClick: () => go(true) }
		});
	}

	function startDaemon() {
		busy = 'restart';
		setTimeout(() => {
			busy = null;
			lp.daemon.running = true;
			lp.daemon.pid = 51000 + Math.floor(Math.random() * 900);
			lp.daemon.startedAt = new Date().toISOString();
			lp.appliedLocks = { ...lp.global.locks };
			lp.toast('Daemon started', { tone: 'success', command: 'ship daemon status', body: `pid ${lp.daemon.pid}` });
		}, 700);
	}

	onMount(() => {
		if (page.url.searchParams.get('daemon') === 'restart') {
			replaceState('/5-launchpad/settings', {});
			daemonAction('restart');
		}
	});

	// --- Locks ----------------------------------------------------------------------------
	let newLock = $state('');
	const lockNameOk = $derived(/^[a-z][a-z0-9-]*$/.test(newLock) && !(newLock in lp.global.locks));
	const pendingLocks = $derived(JSON.stringify(lp.global.locks) !== JSON.stringify(lp.appliedLocks));
	const lockEntries = $derived(Object.entries(lp.global.locks));

	const usersOf = (lock: string) =>
		lp.projects.flatMap((p) => lp.configs[p.key].checks.filter((c) => (c.lock || 'cpu') === lock).map((c) => `${p.name} ${c.name}`));
	const live = (name: string) => lp.locks.find((l) => l.name === name);

	function addLock() {
		if (!lockNameOk) return;
		lp.global.locks[newLock] = 1;
		newLock = '';
	}
	function removeLock(name: string) {
		delete lp.global.locks[name];
	}

	// --- Credentials ----------------------------------------------------------------------
	let reveal = $state(false);
	let checking = $state(false);
	let checkResult = $state<{ ok: boolean; text: string } | null>(null);
	let replacing = $state(false);
	let formAccount = $state('');
	let formToken = $state('');

	const mask = (s: string, keep = 4) => (reveal ? s : '•'.repeat(Math.max(0, s.length - keep)) + s.slice(-keep));

	function check() {
		checking = true;
		checkResult = null;
		setTimeout(() => {
			checking = false;
			if (!lp.daemon.clefConfigured) {
				checkResult = { ok: false, text: `No credentials: ${'~/.ship/credentials.json'} is missing. Every Clef decision falls back to the rules.` };
				return;
			}
			const ms = 340 + Math.floor(Math.random() * 180);
			checkResult = { ok: true, text: `clef-flash answered in ${ms} ms. Reviewer routing test call: add security (p=0.81).` };
			lp.credentials.checkedAt = new Date().toISOString();
		}, 1300);
	}

	function saveCreds() {
		checking = true;
		checkResult = null;
		setTimeout(() => {
			checking = false;
			if (!/^[0-9a-f]{32}$/.test(formAccount.trim())) {
				checkResult = { ok: false, text: 'The account id should be 32 hex characters (Cloudflare dashboard → Workers AI → account id).' };
				return;
			}
			if (formToken.trim().length < 20) {
				checkResult = { ok: false, text: 'Clef refused the token: Authentication error (10000). It needs the Workers AI permission.' };
				return;
			}
			lp.credentials.accountId = formAccount.trim();
			lp.credentials.token = formToken.trim();
			lp.credentials.checkedAt = new Date().toISOString();
			lp.daemon.clefConfigured = true;
			replacing = false;
			checkResult = { ok: true, text: 'Checked with one Clef call and saved to ~/.ship/credentials.json (0600).' };
			lp.toast('Cloudflare credentials saved', { tone: 'success', command: 'ship auth cloudflare' });
		}, 1200);
	}

	function removeCreds() {
		lp.confirm({
			title: 'Remove Cloudflare credentials?',
			body: 'Deletes ~/.ship/credentials.json. Runs keep working: each Clef decision falls back to its deterministic rule, and ship logs a warning to daemon.log.',
			command: 'rm ~/.ship/credentials.json',
			confirmLabel: 'Remove',
			tone: 'danger',
			onConfirm: () => {
				lp.daemon.clefConfigured = false;
				checkResult = null;
				lp.toast('Credentials removed', { body: 'Clef is off everywhere until you add them again.' });
			}
		});
	}

	const clefOff = $derived(lp.projects.filter((p) => !lp.configs[p.key].clef).map((p) => p.name));

	// --- config.json ----------------------------------------------------------------------
	const configJson = $derived({
		$schema: `${SCHEMA_BASE}/config.schema.json`,
		locks: lp.global.locks,
		models: Object.fromEntries(Object.entries(lp.global.models).filter(([, v]) => v)),
		caps: lp.global.caps,
		timeouts: Object.fromEntries(Object.entries(lp.global.timeouts).filter(([, v]) => v))
	});
</script>

<div class="page">
	<div class="intro">
		<h1>Settings</h1>
		<p>Machine-wide: the daemon, lock permits, default models and Clef. Each project's own config lives on its page.</p>
	</div>

	<div class="cols">
		<div class="main">
			<!-- Daemon -->
			<section class="card daemon">
				<div class="d-head">
					<div class={['orb', { off: !lp.daemon.running, busy }]}>
						<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" /></svg>
					</div>
					<div class="d-title">
						<h2>Daemon {lp.daemon.running ? 'running' : 'stopped'}</h2>
						<p>
							{#if busy}{busy === 'restart' ? 'Restarting…' : 'Stopping…'}{:else if lp.daemon.running}Up {uptime} · ship {lp.daemon.version} · pid {lp.daemon.pid}{:else}The next command that needs it starts it.{/if}
						</p>
					</div>
					<div class="d-actions">
						{#if lp.daemon.running}
							<button type="button" class="btn" disabled={!!busy} onclick={() => daemonAction('restart')}>Restart</button>
							<button type="button" class="btn quiet" disabled={!!busy} onclick={() => daemonAction('stop')}>Stop</button>
						{:else}
							<button type="button" class="btn accent" disabled={!!busy} onclick={startDaemon}>Start daemon</button>
						{/if}
					</div>
				</div>
				<dl class="d-facts">
					<div><dt>socket</dt><dd>{lp.daemon.socket}</dd></div>
					<div><dt>log</dt><dd>{lp.daemon.log}</dd></div>
					<div><dt>home</dt><dd>~/.ship</dd></div>
				</dl>
				<div class="d-runs">
					<span class="lbl">Active runs</span>
					{#each lp.activeRuns as r (r.runId)}
						<span class="d-run" animate:flip={{ duration: 200 }}>
							<StatusPill status={r.status} size="sm" /><code>{r.runId}</code><span>{r.state}</span>
						</span>
					{:else}
						<span class="none">None. Restarting is safe.</span>
					{/each}
				</div>
			</section>

			<!-- Locks -->
			<section class="card">
				<header>
					<h2>Lock permits</h2>
					<p>How many checks may hold each resource at once, across every run and <code>ship init</code>.</p>
				</header>
				{#if pendingLocks}
					<div class="pending" transition:slide={{ duration: 220 }}>
						<span>Saved to <code>~/.ship/config.json</code>. The daemon reads permits when it starts.</span>
						<button type="button" class="btn accent small" onclick={() => daemonAction('restart')}>Restart to apply</button>
					</div>
				{/if}
				<div class="locks">
					{#each lockEntries as [name, permits] (name)}
						{@const l = live(name)}
						{@const users = usersOf(name)}
						<div class="lock" animate:flip={{ duration: 220 }} in:scale={{ start: 0.9, duration: 260, easing: backOut }}>
							<div class="l-top">
								<span class={['l-name', name]}>{name}</span>
								<div class="stepper">
									<button type="button" aria-label="Fewer {name} permits" disabled={permits <= 1} onclick={() => (lp.global.locks[name] = permits - 1)}>−</button>
									{#key permits}<span class="val" in:fly={{ y: -8, duration: 200 }}>{permits}</span>{/key}
									<button type="button" aria-label="More {name} permits" onclick={() => (lp.global.locks[name] = permits + 1)}>+</button>
								</div>
							</div>
							<div class="slots" aria-label="{l?.held.length ?? 0} of {permits} held">
								{#each Array.from({ length: permits }, (_, i) => i) as i (i)}
									{@const h = l?.held[i]}
									<span class={['slot', { held: h }]} title={h ? `${h.runId} · ${h.check}` : 'free'}>
										{#if h}<code>{h.runId === 'ext:init' ? 'init' : h.runId}</code>{/if}
									</span>
								{/each}
							</div>
							{#if l?.queue.length}
								<div class="queue">queue: {#each l.queue as q (q.runId)}<code>{q.runId} {q.check}</code>{/each}</div>
							{/if}
							<div class="l-foot">
								<span class="users">{users.length ? `${users.length} check${users.length === 1 ? '' : 's'}: ${users.join(', ')}` : 'No check uses it'}</span>
								{#if name !== 'cpu'}
									<button type="button" class="rm" disabled={users.length > 0} title={users.length ? 'Checks still lock it; ship would refuse their config' : undefined} onclick={() => removeLock(name)}>Remove</button>
								{/if}
							</div>
						</div>
					{/each}
					<form
						class="lock add"
						onsubmit={(e) => {
							e.preventDefault();
							addLock();
						}}
					>
						<span class="l-name">new resource</span>
						<input bind:value={newLock} placeholder="gpu" aria-label="New lock resource name" />
						<button type="submit" class="btn small" disabled={!lockNameOk}>Add</button>
						<span class="users">{newLock && !lockNameOk ? (newLock in lp.global.locks ? 'Already there' : 'lowercase letters, digits and -') : 'e.g. a shared emulator or staging db'}</span>
					</form>
				</div>
			</section>

			<!-- Models -->
			<section class="card">
				<header>
					<h2>Default models</h2>
					<p>Each project may override them. A reviewer whose brief names a model keeps it.</p>
				</header>
				<div class="models">
					{#each MODEL_STEPS as s (s)}
						<div class="model">
							<div>
								<code class="m-step">{s}</code>
								<span class="m-hint">{STEP_HINTS[s]}</span>
							</div>
							<div class="seg" role="radiogroup" aria-label="{s} default model">
								{#each MODELS as m (m)}
									<button type="button" role="radio" aria-checked={lp.global.models[s] === m} class={[m, { on: lp.global.models[s] === m }]} onclick={() => (lp.global.models[s] = m)}>
										{m}{#if SCHEMA_MODEL_DEFAULTS[s] === m}<em>default</em>{/if}
									</button>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</section>

			<!-- Clef -->
			<section class="card" id="clef">
				<header>
					<h2>Cloudflare credentials for Clef</h2>
					<p>Clef (<code>clef-flash</code>) makes the small judgement calls. It is never required.</p>
				</header>
				{#if lp.daemon.clefConfigured && !replacing}
					<div class="creds">
						<div class="cred"><span>account id</span><code>{mask(lp.credentials.accountId)}</code></div>
						<div class="cred"><span>API token</span><code>{mask(lp.credentials.token)}</code></div>
						<button type="button" class="eye" aria-pressed={reveal} onclick={() => (reveal = !reveal)}>{reveal ? 'Hide' : 'Reveal'}</button>
					</div>
					<p class="small muted">~/.ship/credentials.json · mode 0600 · last checked {relTime(lp.credentials.checkedAt)}</p>
					<div class="c-actions">
						<button type="button" class="btn accent" disabled={checking} onclick={check}>
							{#if checking}<span class="spin"></span> Checking…{:else}Check credentials{/if}
						</button>
						<button
							type="button"
							class="btn quiet"
							onclick={() => {
								replacing = true;
								checkResult = null;
								formAccount = '';
								formToken = '';
							}}>Replace…</button
						>
						<button type="button" class="btn quiet danger" onclick={removeCreds}>Remove</button>
					</div>
				{:else}
					<form
						class="cred-form"
						onsubmit={(e) => {
							e.preventDefault();
							saveCreds();
						}}
					>
						{#if !lp.daemon.clefConfigured}
							<p class="nocreds">No credentials yet. Every Clef decision falls back to its rule until you add them.</p>
						{/if}
						<label><span>Account id</span><input bind:value={formAccount} placeholder="32 hex characters" autocomplete="off" /></label>
						<label><span>API token <em>with the Workers AI permission</em></span><input type="password" bind:value={formToken} placeholder="paste token" autocomplete="off" /></label>
						<div class="c-actions">
							<button type="submit" class="btn accent" disabled={checking}>
								{#if checking}<span class="spin"></span> Checking with Clef…{:else}Check and save{/if}
							</button>
							{#if lp.daemon.clefConfigured}
								<button type="button" class="btn quiet" onclick={() => (replacing = false)}>Keep current</button>
							{/if}
							<code class="small muted">ship auth cloudflare</code>
						</div>
					</form>
				{/if}
				{#if checkResult}
					<div class={['result', checkResult.ok ? 'ok' : 'bad']} in:fly={{ y: 6, duration: 240, easing: backOut }}>
						<strong>{checkResult.ok ? '✓' : '×'}</strong>
						<span>{checkResult.text}</span>
					</div>
				{/if}
				{#if clefOff.length}
					<p class="small muted">Clef is off in project config for {clefOff.join(', ')}.</p>
				{/if}
			</section>
		</div>

		<aside class="side">
			<JsonPreview value={configJson} path="~/.ship/config.json" />
			<p class="small muted side-note">Saved as you edit. Lock permit changes need <code>ship daemon restart</code>; model changes apply to the next run.</p>
		</aside>
	</div>
</div>

<style>
	.intro h1 {
		font: 800 52px/1 var(--display);
		letter-spacing: -0.03em;
		margin: 0 0 8px;
	}
	.intro p {
		margin: 0 0 30px;
		font-size: 17px;
		color: var(--ink-2);
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 400px;
		gap: 28px;
		align-items: start;
	}
	.main {
		display: grid;
		gap: 20px;
	}
	.card {
		background: var(--card);
		border-radius: var(--radius);
		padding: 28px;
		box-shadow: var(--shadow-sm);
		scroll-margin-top: 100px;
	}
	header {
		margin-bottom: 18px;
	}
	h2 {
		font: 750 22px var(--display);
		margin: 0;
	}
	header p {
		margin: 4px 0 0;
		color: var(--ink-2);
		font-size: 14.5px;
	}
	code {
		font-family: var(--mono);
		font-size: 0.88em;
	}
	header code,
	.pending code,
	.side-note code {
		background: var(--bg-2);
		padding: 1px 5px;
		border-radius: 5px;
	}
	.small {
		font-size: 13px;
	}
	.muted {
		color: var(--muted);
	}
	.btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font: 700 14px var(--sans);
		padding: 10px 18px;
		border-radius: 999px;
		border: 0;
		background: var(--ink);
		color: var(--bg);
		cursor: pointer;
		transition:
			transform 0.12s,
			background 0.2s;
	}
	.btn:active:not(:disabled) {
		transform: scale(0.95);
	}
	.btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.btn.accent {
		background: var(--accent);
		color: #fff;
	}
	.btn.quiet {
		background: var(--bg-2);
		color: var(--ink);
	}
	.btn.quiet.danger {
		color: var(--red);
	}
	.btn.small {
		padding: 7px 14px;
		font-size: 13px;
	}
	.d-head {
		display: flex;
		align-items: center;
		gap: 18px;
	}
	.orb {
		width: 64px;
		height: 64px;
		border-radius: 22px;
		background: var(--teal-soft);
		color: var(--teal);
		display: grid;
		place-items: center;
	}
	.orb svg {
		width: 30px;
		height: 30px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		animation: turn 12s linear infinite;
	}
	.orb.busy svg {
		animation-duration: 0.8s;
	}
	.orb.off {
		background: var(--red-soft);
		color: var(--red);
	}
	.orb.off svg {
		animation: none;
	}
	@keyframes turn {
		to {
			transform: rotate(360deg);
		}
	}
	.d-title {
		flex: 1;
	}
	.d-title h2 {
		font-size: 26px;
	}
	.d-title p {
		margin: 2px 0 0;
		color: var(--ink-2);
		font-size: 14px;
	}
	.d-actions {
		display: flex;
		gap: 8px;
	}
	.d-facts {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
		margin: 22px 0 0;
	}
	.d-facts div {
		background: var(--bg);
		border-radius: 16px;
		padding: 12px 14px;
	}
	dt {
		font-size: 12px;
		color: var(--muted);
	}
	dd {
		margin: 0;
		font: 13px var(--mono);
	}
	.d-runs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 16px;
	}
	.lbl {
		font-size: 13px;
		font-weight: 700;
		color: var(--muted);
		margin-right: 4px;
	}
	.d-run {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 4px 12px 4px 4px;
		background: var(--bg);
		border-radius: 999px;
		font-size: 13px;
	}
	.d-run span:last-child {
		color: var(--muted);
		font-family: var(--mono);
		font-size: 12px;
	}
	.none {
		font-size: 13.5px;
		color: var(--teal);
	}
	.pending {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 12px 12px 18px;
		background: var(--amber-soft);
		border-radius: 16px;
		margin-bottom: 14px;
		font-size: 14px;
	}
	.locks {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 12px;
	}
	.lock {
		display: grid;
		gap: 12px;
		align-content: start;
		padding: 18px;
		background: var(--bg);
		border-radius: 22px;
	}
	.l-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.l-name {
		font: 700 18px var(--mono);
	}
	.l-name.db {
		color: var(--plum);
	}
	.l-name.cpu {
		color: var(--accent-ink);
	}
	.stepper {
		display: flex;
		align-items: center;
		background: var(--card);
		border-radius: 999px;
		padding: 3px;
	}
	.stepper button {
		width: 30px;
		height: 30px;
		border-radius: 50%;
		border: 0;
		background: var(--bg-2);
		font-size: 17px;
		cursor: pointer;
		color: var(--ink);
	}
	.stepper button:active:not(:disabled) {
		transform: scale(0.88);
	}
	.stepper button:disabled {
		opacity: 0.35;
	}
	.val {
		width: 34px;
		text-align: center;
		font: 800 18px var(--display);
	}
	.slots {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.slot {
		min-width: 40px;
		height: 30px;
		border-radius: 10px;
		border: 2px dashed var(--line-2);
		display: grid;
		place-items: center;
		padding: 0 6px;
		transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.slot.held {
		border: 0;
		background: var(--accent);
		color: #fff;
	}
	.slot code {
		font-size: 11px;
		font-weight: 700;
	}
	.queue {
		font-size: 12.5px;
		color: var(--amber);
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: wrap;
	}
	.queue code {
		background: var(--amber-soft);
		padding: 1px 7px;
		border-radius: 999px;
	}
	.l-foot {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		align-items: flex-end;
	}
	.users {
		font-size: 12px;
		color: var(--muted);
		line-height: 1.4;
	}
	.rm {
		font: 600 12px var(--sans);
		background: none;
		border: 0;
		color: var(--red);
		cursor: pointer;
		padding: 0;
	}
	.rm:disabled {
		color: var(--muted);
		cursor: not-allowed;
		opacity: 0.6;
	}
	.lock.add {
		border: 2px dashed var(--line-2);
		background: transparent;
	}
	.lock.add .l-name {
		font-size: 14px;
		color: var(--muted);
	}
	.lock.add input {
		font: 600 15px var(--mono);
		padding: 9px 12px;
		border-radius: 12px;
		border: 1.5px solid var(--line);
		background: var(--card);
		color: var(--ink);
	}
	.lock.add input:focus {
		outline: 0;
		border-color: var(--accent);
	}
	.lock.add .btn {
		justify-self: start;
	}
	.models {
		display: grid;
		gap: 2px;
	}
	.model {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 0;
		border-bottom: 1px dashed var(--line);
	}
	.model:last-child {
		border: 0;
	}
	.m-step {
		font-weight: 700;
		font-size: 14px;
		margin-right: 12px;
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
		display: inline-flex;
		align-items: baseline;
		gap: 5px;
		font: 700 13px var(--sans);
		border: 0;
		background: none;
		padding: 7px 14px;
		border-radius: 999px;
		cursor: pointer;
		color: var(--ink-2);
	}
	.seg em {
		font-style: normal;
		font-weight: 500;
		font-size: 10.5px;
		opacity: 0.6;
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
	.creds {
		display: grid;
		grid-template-columns: 1fr 1fr auto;
		gap: 10px;
		align-items: end;
	}
	.cred {
		display: grid;
		gap: 4px;
		padding: 12px 14px;
		background: var(--bg);
		border-radius: 16px;
		min-width: 0;
	}
	.cred span {
		font-size: 12px;
		color: var(--muted);
	}
	.cred code {
		font-size: 14px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		letter-spacing: 0.04em;
	}
	.eye {
		font: 600 13px var(--sans);
		padding: 10px 14px;
		border-radius: 14px;
		border: 0;
		background: var(--bg-2);
		cursor: pointer;
		color: var(--ink);
		height: 100%;
	}
	.c-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 14px;
	}
	.spin {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2.5px solid rgba(255, 255, 255, 0.4);
		border-top-color: #fff;
		animation: turn 0.7s linear infinite;
	}
	.cred-form {
		display: grid;
		gap: 12px;
	}
	.cred-form label {
		display: grid;
		gap: 5px;
		font-weight: 600;
		font-size: 14px;
	}
	.cred-form em {
		font-style: normal;
		font-weight: 400;
		color: var(--muted);
	}
	.cred-form input {
		font: 14px var(--mono);
		padding: 11px 14px;
		border-radius: 14px;
		border: 1.5px solid var(--line);
		background: var(--bg);
		color: var(--ink);
	}
	.cred-form input:focus {
		outline: 0;
		border-color: var(--accent);
		background: var(--card);
	}
	.nocreds {
		margin: 0;
		padding: 12px 16px;
		border-radius: 14px;
		background: var(--amber-soft);
		font-size: 14px;
	}
	.result {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		margin-top: 14px;
		padding: 12px 16px;
		border-radius: 16px;
		font-size: 14px;
	}
	.result.ok {
		background: var(--teal-soft);
		color: var(--teal);
	}
	.result.bad {
		background: var(--red-soft);
		color: var(--red);
	}
	.result span {
		color: var(--ink);
	}
	.side {
		position: sticky;
		top: 96px;
	}
	.side-note {
		margin: 12px 4px 0;
		line-height: 1.5;
	}
</style>
