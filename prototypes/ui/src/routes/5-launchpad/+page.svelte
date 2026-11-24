<script lang="ts">
	import { fly } from 'svelte/transition';
	import { backOut } from 'svelte/easing';
	import { PIPELINE_STATES, dailyCost, describe, relTime, usd } from '#lib';
	import type { Run } from '#lib';
	import { getLaunchpad } from '#lib/prototypes/5-launchpad/state.svelte.ts';
	import StatusPill from '#lib/prototypes/5-launchpad/StatusPill.svelte';

	const lp = getLaunchpad();
	const live = $derived(lp.runs.find((r) => r.runId === 'r-7k2m'));
	const showLive = $derived(!!live && (live === lp.live.run || live.status === 'running' || live.status === 'waiting'));
	const others = $derived(lp.activeRuns.filter((r) => r.runId !== 'r-7k2m' || !showLive));
	const total14 = dailyCost.reduce((a, b) => a + b, 0);
	const maxDay = Math.max(...dailyCost);

	const HUES = ['accent', 'teal', 'plum', 'amber'];
	const hueOf = (i: number) => HUES[i % HUES.length];

	const stage = (state: string) => PIPELINE_STATES.findIndex((s) => state.startsWith(s));

	const attentionWhy = (r: Run) =>
		r.status === 'escalated' ? `escalated: ${r.escalationReason}` : r.status === 'failed' ? (r.error ?? 'failed') : `interrupted at ${r.state}`;

	const lastRun = (key: string) => lp.runsFor(key)[0];
	const projectName = (key: string) => lp.projectOf(key)?.name ?? key;

	const waitingWhy = (r: Run) => {
		const e = r.events.findLast((e) => e._tag === 'LockWaiting');
		return e && e._tag === 'LockWaiting' ? `${e.check} waiting for ${e.resource}` : r.state;
	};
</script>

<section class="hello">
	<div>
		<p class="date">Monday, 23 November</p>
		<h1>Good afternoon, Felix.</h1>
		<p class="sub">
			<b>{lp.activeRuns.length}</b> runs in flight, <b class="att">{lp.attentionRuns.length}</b> waiting on you, and
			<b class="rdy">{lp.plans.length}</b> plans ready to ship.
		</p>
	</div>
	<div class="spend" title="Agent spend per day, last 14 days">
		<div class="bars">
			{#each dailyCost as d, i (i)}
				<i style:height="{Math.max(4, (d / maxDay) * 56)}px" class={{ today: i === dailyCost.length - 1 }}></i>
			{/each}
		</div>
		<div class="spend-num">
			<strong>{usd(total14)}</strong>
			<span>last 14 days</span>
		</div>
	</div>
</section>

<section class="flight" aria-label="In flight">
	{#if live && showLive}
		<a class="live" href="/5-launchpad/ship?run=r-7k2m#runs">
			<span class="live-top">
				<span class={['beacon', live.status]}></span>
				<code>{live.runId}</code>
				<span class="proj">ship · {live.title}</span>
				<span class="cost">{usd(live.costUsd)}</span>
			</span>
			<span class="track">
				{#each PIPELINE_STATES as s, i (s)}
					<span class={['seg', { past: i < stage(live.state), now: i === stage(live.state), done: live.status === 'done' }]}>
						<span class="seg-label">{s}</span>
					</span>
				{/each}
			</span>
			<span class="ticker">
				{#key live.events.length}
					<span in:fly={{ y: 10, duration: 320, easing: backOut }}>
						<b>{live.state}{live.round ? ` · round ${live.round}` : ''}</b>
						{describe(live.events.at(-1)!)}
					</span>
				{/key}
			</span>
		</a>
	{/if}
	<div class="side-chips">
		{#each others as r (r.runId)}
			<a class="chip" href="/5-launchpad/{projectName(r.projectKey)}?run={r.runId}#runs">
				<StatusPill status={r.status} size="sm" />
				<code>{r.runId}</code>
				<span class="chip-text">{r.status === 'waiting' ? waitingWhy(r) : `${r.kind} · ${r.state}`}</span>
			</a>
		{/each}
		<div class="attention">
			<span class="att-head"><b>{lp.attentionRuns.length}</b> need you</span>
			{#each lp.attentionRuns as r (r.runId)}
				<div class={['att-row', r.status]} transition:fly={{ x: 10, duration: 200 }}>
					<a href="/5-launchpad/{projectName(r.projectKey)}?run={r.runId}#runs"><code>{r.runId}</code> {attentionWhy(r)}</a>
					{#if r.status !== 'escalated'}
						<button type="button" onclick={() => lp.resumeRun(r.runId)}>Resume</button>
					{:else if r.prUrl}
						<a class="mini" href={r.prUrl} target="_blank" rel="noreferrer">PR #{r.prNumber}</a>
					{/if}
				</div>
			{:else}
				<span class="calm">Nothing. Lovely.</span>
			{/each}
		</div>
	</div>
</section>

<h2 class="section-title">Projects</h2>
<section class="projects">
	{#each lp.projects as p, i (p.key)}
		{@const ready = lp.plansFor(p.key)}
		{@const prs = lp.prsFor(p.key)}
		{@const last = lastRun(p.key)}
		{@const cfg = lp.configs[p.key]}
		<article class={['card', hueOf(i)]} in:fly={{ y: 16, delay: i * 70, duration: 420, easing: backOut }}>
			<div class="card-top">
				<span class="blob">{p.name[0]}</span>
				<div class="names">
					<h3><a href="/5-launchpad/{p.name}">{p.name}</a></h3>
					<code class="path">{p.path}</code>
				</div>
				<span class="branch">
					<svg viewBox="0 0 24 24"><circle cx="7" cy="6" r="2.2" /><circle cx="7" cy="18" r="2.2" /><circle cx="17" cy="8" r="2.2" /><path d="M7 8.2v7.6M17 10.2c0 4-10 2.5-10 5.6" /></svg>
					{p.defaultBranch}
				</span>
			</div>

			<div class="checks">
				{#each cfg.checks as c (c.name)}
					<span class={['check', { db: c.lock === 'db' }]} title="{c.run} · lock {c.lock}">
						{c.name}{#if c.lock === 'db'}<em>db</em>{/if}
					</span>
				{/each}
				{#if !cfg.clef}<span class="check off">clef off</span>{/if}
			</div>

			<div class="stats">
				<div class="stat big">
					<strong>{ready.length}</strong>
					<span>ready to ship</span>
				</div>
				<div class="stat">
					<strong>{prs.length}</strong>
					<span>open PRs</span>
				</div>
				<div class="stat">
					<strong>{usd(lp.spendFor(p.key))}</strong>
					<span>this week</span>
				</div>
			</div>

			<div class="card-foot">
				{#if last}
					<span class="last">
						<StatusPill status={last.status} size="sm" />
						<span class="last-title">{last.title}</span>
						<span class="muted">{relTime(last.updatedAt)}</span>
					</span>
				{:else}
					<span class="muted">No runs yet</span>
				{/if}
				{#if ready.length}
					<button type="button" class="ship" onclick={() => (lp.launch = { plan: ready[0], project: p })}>
						Ship {ready[0].path.replace('.plans/', '')}
						<svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
					</button>
				{/if}
			</div>
		</article>
	{/each}

	<button type="button" class="card add" onclick={() => (lp.wizardOpen = true)}>
		<span class="plus">+</span>
		<strong>Add a project</strong>
		<span>Point at a checkout. ship detects its checks from package.json, a justfile, a Makefile or Cargo.toml, and runs each once.</span>
		<code>ship init</code>
	</button>
</section>

<h2 class="section-title">Ready to ship</h2>
<section class="tickets">
	{#each lp.plans as plan, i (plan.path)}
		{@const project = lp.projectOf(plan.project)}
		{@const inflight = lp.activeRuns.find((r) => r.planDir === plan.path && r.projectKey === plan.project)}
		{#if project}
			<div class="ticket" in:fly={{ y: 12, delay: 200 + i * 60, duration: 380, easing: backOut }}>
				<span class="t-proj">{project.name}</span>
				<strong>{plan.title}</strong>
				<code>{plan.path}</code>
				<span class="t-meta">⎇ {plan.branch} · edited {relTime(plan.updatedAt)}</span>
				{#if inflight}
					<a class="t-run" href="/5-launchpad/{project.name}?run={inflight.runId}#runs"><span class="beacon running"></span>{inflight.runId} in flight</a>
				{:else}
					<button type="button" class="t-btn" onclick={() => (lp.launch = { plan, project })}>Ship it</button>
				{/if}
			</div>
		{/if}
	{/each}
</section>

<style>
	.hello {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 40px;
		margin-bottom: 30px;
	}
	.date {
		font-weight: 600;
		color: var(--accent-ink);
		margin: 0 0 6px;
		letter-spacing: 0.02em;
	}
	h1 {
		font: 800 62px/1.02 var(--display);
		letter-spacing: -0.035em;
		margin: 0;
	}
	.sub {
		font-size: 20px;
		color: var(--ink-2);
		margin: 14px 0 0;
	}
	.sub b {
		color: var(--ink);
	}
	.sub .att {
		color: var(--plum);
	}
	.sub .rdy {
		color: var(--accent-ink);
	}
	.spend {
		display: flex;
		align-items: flex-end;
		gap: 16px;
		padding: 16px 20px;
		background: var(--card);
		border-radius: 22px;
		box-shadow: var(--shadow-sm);
	}
	.bars {
		display: flex;
		align-items: flex-end;
		gap: 4px;
		height: 56px;
	}
	.bars i {
		width: 8px;
		border-radius: 4px;
		background: var(--bg-2);
		transition: transform 0.2s;
	}
	.bars i:hover {
		background: var(--accent);
		transform: scaleY(1.06);
	}
	.bars i.today {
		background: var(--accent);
	}
	.spend-num {
		display: grid;
	}
	.spend-num strong {
		font: 800 26px var(--display);
	}
	.spend-num span {
		font-size: 13px;
		color: var(--muted);
	}
	.flight {
		display: grid;
		grid-template-columns: 1.35fr 1fr;
		gap: 16px;
		margin-bottom: 44px;
	}
	.live {
		display: grid;
		gap: 16px;
		padding: 22px 24px;
		background: var(--ink);
		color: var(--bg);
		border-radius: var(--radius);
		text-decoration: none;
		box-shadow: var(--shadow);
		transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
		overflow: hidden;
	}
	.live:hover {
		transform: translateY(-3px);
	}
	.live-top {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.live code {
		font: 700 15px var(--mono);
		color: #f7b58a;
	}
	.proj {
		flex: 1;
		font-weight: 600;
		opacity: 0.85;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cost {
		font: 700 18px var(--display);
	}
	.beacon {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--accent);
		flex: none;
		display: inline-block;
	}
	.beacon.running {
		animation: beacon 1.4s ease-in-out infinite;
	}
	.beacon.done {
		background: #6fd3b8;
	}
	@keyframes beacon {
		50% {
			box-shadow: 0 0 0 7px rgba(226, 87, 30, 0.2);
		}
	}
	.track {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 5px;
	}
	.seg {
		position: relative;
		height: 8px;
		border-radius: 999px;
		background: rgba(255, 240, 225, 0.12);
	}
	.seg.past,
	.seg.done {
		background: #f4e9dc;
	}
	.seg.now:not(.done) {
		background: var(--accent);
		animation: glow 1.6s ease-in-out infinite;
	}
	@keyframes glow {
		50% {
			opacity: 0.6;
		}
	}
	.seg-label {
		position: absolute;
		top: 13px;
		left: 0;
		font: 11px var(--mono);
		opacity: 0.45;
	}
	.seg.now .seg-label {
		opacity: 1;
		color: #f7b58a;
	}
	.ticker {
		margin-top: 16px;
		height: 22px;
		overflow: hidden;
		font: 13.5px var(--mono);
		opacity: 0.85;
		position: relative;
	}
	.ticker > span {
		position: absolute;
		inset: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ticker b {
		color: #f7b58a;
		font-weight: 600;
		margin-right: 8px;
	}
	.side-chips {
		display: grid;
		gap: 10px;
		align-content: start;
	}
	.chip {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 16px;
		background: var(--card);
		border-radius: 18px;
		text-decoration: none;
		color: var(--ink);
		box-shadow: var(--shadow-sm);
		transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.chip:hover {
		transform: translateX(3px);
	}
	.chip code {
		font: 600 13px var(--mono);
	}
	.chip-text {
		font-size: 13.5px;
		color: var(--ink-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.attention {
		display: grid;
		gap: 4px;
		padding: 12px 14px 12px 16px;
		background: var(--plum-soft);
		border-radius: 18px;
	}
	.att-head {
		font-weight: 700;
		font-size: 14px;
		color: var(--plum);
		margin-bottom: 2px;
	}
	.att-row {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13.5px;
	}
	.att-row > a:first-child {
		flex: 1;
		color: var(--ink);
		text-decoration: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.att-row > a:first-child:hover {
		text-decoration: underline;
	}
	.att-row code {
		font: 600 12.5px var(--mono);
		margin-right: 4px;
	}
	.att-row.failed code {
		color: var(--red);
	}
	.att-row.escalated code {
		color: var(--plum);
	}
	.att-row button,
	.mini {
		font: 600 12px var(--sans);
		padding: 4px 11px;
		border-radius: 999px;
		border: 0;
		background: var(--card);
		color: var(--ink);
		cursor: pointer;
		text-decoration: none;
		transition: transform 0.12s;
	}
	.att-row button:hover {
		background: var(--accent);
		color: #fff;
	}
	.att-row button:active {
		transform: scale(0.94);
	}
	.calm {
		font-size: 13.5px;
		color: var(--ink-2);
	}
	.section-title {
		font: 750 26px var(--display);
		letter-spacing: -0.01em;
		margin: 0 0 16px;
	}
	.projects {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 20px;
		margin-bottom: 48px;
	}
	.card {
		--hue: var(--accent);
		--hue-soft: var(--accent-soft);
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 20px;
		padding: 28px;
		background: var(--card);
		border-radius: var(--radius);
		box-shadow: var(--shadow-sm);
		transition:
			transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1),
			box-shadow 0.3s;
	}
	.card.teal {
		--hue: var(--teal);
		--hue-soft: var(--teal-soft);
	}
	.card.plum {
		--hue: var(--plum);
		--hue-soft: var(--plum-soft);
	}
	.card.amber {
		--hue: var(--amber);
		--hue-soft: var(--amber-soft);
	}
	.card:hover {
		transform: translateY(-4px) rotate(-0.25deg);
		box-shadow: var(--shadow);
	}
	.card-top {
		display: flex;
		align-items: center;
		gap: 16px;
	}
	.blob {
		width: 56px;
		height: 56px;
		border-radius: 20px;
		background: var(--hue-soft);
		color: var(--hue);
		display: grid;
		place-items: center;
		font: 800 28px var(--display);
		text-transform: uppercase;
		transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.card:hover .blob {
		transform: rotate(-8deg) scale(1.05);
		border-radius: 24px 14px 24px 14px;
	}
	.names {
		flex: 1;
		min-width: 0;
	}
	h3 {
		font: 800 30px/1.1 var(--display);
		letter-spacing: -0.02em;
		margin: 0;
	}
	h3 a {
		color: var(--ink);
		text-decoration: none;
	}
	h3 a::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
	}
	h3 a:focus-visible {
		outline: none;
	}
	.card:has(h3 a:focus-visible) {
		outline: 3px solid var(--hue);
		outline-offset: 3px;
	}
	.path {
		font: 13px var(--mono);
		color: var(--muted);
	}
	.branch {
		display: flex;
		align-items: center;
		gap: 6px;
		font: 600 13px var(--mono);
		padding: 6px 12px;
		border-radius: 999px;
		background: var(--bg);
		color: var(--ink-2);
	}
	.branch svg {
		width: 15px;
		height: 15px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
	}
	.checks {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: 600 12.5px var(--mono);
		padding: 5px 11px;
		border-radius: 999px;
		background: var(--bg);
		color: var(--ink-2);
	}
	.check em {
		font-style: normal;
		font-size: 10.5px;
		background: var(--plum-soft);
		color: var(--plum);
		padding: 0 6px;
		border-radius: 999px;
	}
	.check.off {
		background: none;
		border: 1px dashed var(--line-2);
		color: var(--muted);
	}
	.stats {
		display: grid;
		grid-template-columns: 1.2fr 1fr 1fr;
		gap: 10px;
	}
	.stat {
		display: grid;
		padding: 14px 16px;
		border-radius: 18px;
		background: var(--bg);
	}
	.stat strong {
		font: 800 28px/1.1 var(--display);
	}
	.stat span {
		font-size: 13px;
		color: var(--muted);
	}
	.stat.big {
		background: var(--hue-soft);
	}
	.stat.big strong {
		color: var(--hue);
	}
	.card-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: auto;
	}
	.last {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		font-size: 13.5px;
	}
	.last-title {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.muted {
		color: var(--muted);
		white-space: nowrap;
	}
	.ship {
		position: relative;
		z-index: 1;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font: 700 14px var(--sans);
		padding: 10px 14px 10px 18px;
		border-radius: 999px;
		border: 0;
		background: var(--hue);
		color: #fff;
		cursor: pointer;
		white-space: nowrap;
		transition: transform 0.15s;
	}
	.ship svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
		transition: transform 0.2s;
	}
	.ship:hover svg {
		transform: translateX(3px);
	}
	.ship:active {
		transform: scale(0.95);
	}
	.add {
		align-items: flex-start;
		justify-content: center;
		text-align: left;
		background: transparent;
		border: 2.5px dashed var(--line-2);
		box-shadow: none;
		cursor: pointer;
		font: inherit;
		color: var(--ink);
		gap: 10px;
	}
	.add:hover {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent-soft) 40%, transparent);
	}
	.plus {
		width: 56px;
		height: 56px;
		border-radius: 20px;
		background: var(--accent);
		color: #fff;
		display: grid;
		place-items: center;
		font: 600 34px/1 var(--display);
		transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.add:hover .plus {
		transform: rotate(90deg) scale(1.08);
	}
	.add strong {
		font: 800 26px var(--display);
		margin-top: 6px;
	}
	.add span {
		color: var(--ink-2);
		max-width: 420px;
	}
	.add code {
		font: 13px var(--mono);
		color: var(--accent-ink);
	}
	.tickets {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 16px;
	}
	.ticket {
		position: relative;
		display: grid;
		gap: 4px;
		padding: 22px 22px 20px;
		background: var(--card);
		border-radius: 22px;
		box-shadow: var(--shadow-sm);
		border-left: 6px solid var(--accent);
		transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.ticket:hover {
		transform: translateY(-3px);
	}
	.t-proj {
		font: 700 12px var(--sans);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--accent-ink);
	}
	.ticket strong {
		font: 750 20px/1.25 var(--display);
	}
	.ticket code {
		font: 12.5px var(--mono);
		color: var(--ink-2);
	}
	.t-meta {
		font-size: 13px;
		color: var(--muted);
		margin-bottom: 10px;
	}
	.t-btn {
		justify-self: start;
		font: 700 14px var(--sans);
		padding: 9px 18px;
		border-radius: 999px;
		border: 0;
		background: var(--ink);
		color: var(--bg);
		cursor: pointer;
		transition:
			transform 0.15s,
			background 0.2s;
	}
	.t-btn:hover {
		background: var(--accent);
	}
	.t-btn:active {
		transform: scale(0.95);
	}
	.t-run {
		justify-self: start;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font: 600 13px var(--mono);
		color: var(--accent-ink);
		text-decoration: none;
		padding: 8px 14px;
		background: var(--accent-soft);
		border-radius: 999px;
	}
</style>
