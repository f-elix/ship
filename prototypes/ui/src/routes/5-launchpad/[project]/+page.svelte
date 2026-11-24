<script lang="ts">
	import { fly, slide } from 'svelte/transition';
	import { backOut } from 'svelte/easing';
	import { page } from '$app/state';
	import { clock, commandFor, describe, relTime, usd } from '#lib';
	import type { OpenPr, Run } from '#lib';
	import { getLaunchpad } from '#lib/prototypes/5-launchpad/state.svelte.ts';
	import StatusPill from '#lib/prototypes/5-launchpad/StatusPill.svelte';
	import Markdown from '#lib/prototypes/5-launchpad/Markdown.svelte';
	import Toggle from '#lib/prototypes/5-launchpad/Toggle.svelte';
	import ProjectSettings from '#lib/prototypes/5-launchpad/ProjectSettings.svelte';

	const lp = getLaunchpad();
	const project = $derived(lp.project(page.params.project ?? ''));
	const tab = $derived(page.url.searchParams.get('tab') === 'settings' ? 'settings' : 'overview');
	const focusRun = $derived(page.url.searchParams.get('run'));

	const plans = $derived(project ? lp.plansFor(project.key) : []);
	const prs = $derived(project ? lp.prsFor(project.key) : []);
	const runs = $derived(project ? lp.runsFor(project.key) : []);

	// --- Plans ---
	let expanded = $state<Record<string, boolean>>({});
	let planTab = $state<Record<string, 'spec' | 'plan'>>({});

	// --- PRs ---
	type PrAction = 'review' | 'fix' | 'recheck' | 'post';
	let prAction = $state<Record<number, PrAction | undefined>>({});
	let flags = $state<Record<number, { post: boolean; local: boolean; noChecks: boolean }>>({});
	const NO_FLAGS = { post: false, local: false, noChecks: false };
	const flagsOf = (n: number) => flags[n] ?? NO_FLAGS;
	function selectAction(n: number, a: PrAction | undefined) {
		flags[n] ??= { ...NO_FLAGS };
		prAction[n] = a;
	}

	function storedReview(pr: OpenPr): { id: string | null; why: string } {
		if (!pr.lastShipReview) return { id: null, why: `No stored review yet; ship review ${pr.number} stores one.` };
		const r = lp.runs.find((x) => x.runId === pr.lastShipReview);
		if (!r) return { id: null, why: 'The review is not on this machine.' };
		if (r.kind !== 'review') return { id: null, why: `${r.runId} was a ship run; its findings are already in the PR.` };
		if (r.status !== 'done') return { id: null, why: `Review ${r.runId} is still ${r.status}.` };
		return { id: r.reviewId, why: '' };
	}

	function prCommand(pr: OpenPr, action: PrAction) {
		const f = flagsOf(pr.number);
		switch (action) {
			case 'review':
				return `ship review ${pr.number}${f.post ? ' --post' : ''}`;
			case 'fix':
				return `ship fix ${pr.number}${f.local ? ' --local' : ''}${f.noChecks ? ' --no-checks' : ''}`;
			case 'recheck':
				return `ship recheck ${pr.number}${f.local ? ' --local' : ''}`;
			case 'post':
				return `ship post ${storedReview(pr).id ?? '<review-id>'}`;
		}
	}

	function runPr(pr: OpenPr, action: PrAction) {
		if (!project) return;
		const cmd = prCommand(pr, action);
		const runId = lp.startRun({ kind: action, project, title: pr.title, branch: pr.headRef, prNumber: pr.number });
		prAction[pr.number] = undefined;
		lp.toast(`${action[0].toUpperCase()}${action.slice(1)} started on #${pr.number}`, { tone: 'success', command: cmd, body: `${runId} · ${project.path}` });
		if (action === 'review') {
			pr.lastShipReview = runId;
			const post = flagsOf(pr.number).post;
			setTimeout(() => {
				const r = lp.runs.find((x) => x.runId === runId);
				if (!r || r.status !== 'running') return;
				r.status = 'done';
				r.state = 'done';
				r.reviewId = `rv-${runId.slice(2)}`;
				r.costUsd = 2.18;
				lp.toast(`Review of #${pr.number} is done`, {
					body: post ? '3 findings posted: 2 inline, 1 in the body (COMMENT).' : `3 verified findings stored as ${r.reviewId}. Post them when you're ready.`,
					command: post ? undefined : `ship post ${r.reviewId}`,
					tone: 'success'
				});
			}, 6000);
		}
		if (action === 'post') pr.lastShipReview = null;
	}

	// --- Runs ---
	let openRun = $state<string | null>(null);
	const isOpen = (r: Run) => openRun === r.runId || (openRun === null && focusRun === r.runId);

	const severityCounts = (r: Run) => ({
		mustFix: r.findings.filter((f) => f.severity === 'must-fix').length,
		tradeoff: r.findings.filter((f) => f.severity === 'tradeoff').length,
		nit: r.findings.filter((f) => f.severity === 'nit').length
	});

	function cancel(r: Run) {
		lp.confirm({
			title: `Cancel ${r.runId}?`,
			body: `${r.title} stops at ${r.state} and ends as cancelled. Commits it made stay on ${r.branch}.`,
			command: `ship cancel ${r.runId}`,
			confirmLabel: 'Cancel run',
			tone: 'danger',
			onConfirm: () => lp.cancelRun(r.runId)
		});
	}

	const scrollIntoView = (node: HTMLElement) => {
		requestAnimationFrame(() => node.scrollIntoView({ block: 'center', behavior: 'smooth' }));
	};
</script>

{#if !project}
	<div class="missing">
		<h1>No project called “{page.params.project}”.</h1>
		<p>Add it with <code>ship init</code>, or pick one from the bar above.</p>
		<button type="button" class="btn accent" onclick={() => (lp.wizardOpen = true)}>Add a project</button>
	</div>
{:else}
	<header class="head">
		<div class="title">
			<span class="blob">{project.name[0]}</span>
			<div>
				<h1>{project.name}</h1>
				<div class="meta">
					<code>{project.key}</code>
					<span>·</span>
					<code>{project.path}</code>
					<span class="branch">⎇ {project.defaultBranch}</span>
				</div>
			</div>
		</div>
		<div class="head-stats">
			<div><strong>{usd(lp.spendFor(project.key))}</strong><span>this week</span></div>
			<div><strong>{runs.length}</strong><span>runs</span></div>
		</div>
	</header>

	<nav class="tabs">
		<a href="?" class={{ on: tab === 'overview' }} data-sveltekit-noscroll>Overview</a>
		<a href="?tab=settings" class={{ on: tab === 'settings' }} data-sveltekit-noscroll>Settings</a>
		<span class="conv">
			conventions:
			{#each project.conventions as c (c)}<span>{c}</span>{/each}
		</span>
	</nav>

	{#if tab === 'settings'}
		{#key project.key}
			<div in:fly={{ y: 10, duration: 300 }}><ProjectSettings {project} /></div>
		{/key}
	{:else}
		<div in:fly={{ y: 10, duration: 300 }}>
			<section id="ready">
				<div class="sec-head">
					<h2>Ready to ship</h2>
					<span class="count">{plans.length}</span>
					<span class="hint">Plan dirs with <code>spec.md</code> and <code>implementation-plan.md</code></span>
				</div>
				{#if plans.length}
					<div class="plans">
						{#each plans as plan (plan.path)}
							{@const which = planTab[plan.path] ?? 'spec'}
							{@const inflight = lp.activeRuns.find((r) => r.planDir === plan.path && r.projectKey === project.key)}
							<article class="plan">
								<div class="plan-top">
									<div>
										<h3>{plan.title}</h3>
										<div class="plan-meta"><code>{plan.path}</code> · ⎇ {plan.branch} · edited {relTime(plan.updatedAt)}</div>
									</div>
									{#if inflight}
										<a class="btn soft" href="?run={inflight.runId}#runs">{inflight.runId} in flight</a>
									{:else}
										<button type="button" class="btn accent big" onclick={() => (lp.launch = { plan, project })}>
											Ship it
											<svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
										</button>
									{/if}
								</div>
								<div class="doc-tabs">
									<button type="button" class={{ on: which === 'spec' }} onclick={() => (planTab[plan.path] = 'spec')}>spec.md</button>
									<button type="button" class={{ on: which === 'plan' }} onclick={() => (planTab[plan.path] = 'plan')}>implementation-plan.md</button>
								</div>
								<div class={['doc', { open: expanded[plan.path] }]}>
									<Markdown source={which === 'spec' ? plan.spec : plan.plan} />
								</div>
								<button type="button" class="more" onclick={() => (expanded[plan.path] = !expanded[plan.path])}>
									{expanded[plan.path] ? 'Show less' : 'Read all'}
								</button>
							</article>
						{/each}
					</div>
				{:else}
					<div class="empty">
						<strong>Nothing planned.</strong>
						<span>Plan a change with your agent's <code>plan-out</code> skill; its plan dir shows up here.</span>
					</div>
				{/if}
			</section>

			<section id="prs">
				<div class="sec-head">
					<h2>Pull requests</h2>
					<span class="count">{prs.length}</span>
					<span class="hint">Check the PR out first: ship works in the checkout you run it from.</span>
				</div>
				<div class="prs">
					{#each prs as pr (pr.number)}
						{@const action = prAction[pr.number]}
						{@const stored = storedReview(pr)}
						<article class={['pr', { active: action }]}>
							<div class="pr-row">
								<span class="pr-num">#{pr.number}</span>
								<div class="pr-main">
									<strong>{pr.title}</strong>
									<span class="pr-meta">
										{pr.author} · <code>{pr.headRef}</code> · updated {relTime(pr.updatedAt)}
										{#if pr.unresolvedThreads}<span class="threads">{pr.unresolvedThreads} open threads</span>{/if}
										{#if pr.lastShipReview}<span class="last-rev">last ship run {pr.lastShipReview}</span>{/if}
									</span>
								</div>
								<div class="seg" role="group" aria-label="Actions for #{pr.number}">
									{#each ['review', 'fix', 'recheck', 'post'] as const as a (a)}
										<button
											type="button"
											class={{ on: action === a }}
											aria-pressed={action === a}
											disabled={(a === 'fix' || a === 'recheck') && pr.unresolvedThreads === 0 && !stored.id}
											title={a === 'post' && !stored.id ? stored.why : (a === 'fix' || a === 'recheck') && pr.unresolvedThreads === 0 ? 'No open threads or stored review' : undefined}
											onclick={() => selectAction(pr.number, action === a ? undefined : a)}>{a[0].toUpperCase() + a.slice(1)}</button
										>
									{/each}
								</div>
							</div>
							{#if action}
								<div class="pr-panel" transition:slide={{ duration: 240 }}>
									<div class="pr-opts">
										{#if action === 'review'}
											<Toggle bind:checked={flags[pr.number].post} label="Post to GitHub (--post)" hint="Inline where the line is in the diff. Requests changes only for must-fix; never approves." />
										{:else if action === 'fix'}
											<Toggle bind:checked={flags[pr.number].local} label="Keep commits local (--local)" hint="Don't push to {pr.headRef}." />
											<Toggle bind:checked={flags[pr.number].noChecks} label="Skip checks (--no-checks)" hint="Commit the fix without running checks." />
										{:else if action === 'recheck'}
											<Toggle bind:checked={flags[pr.number].local} label="Don't resolve threads (--local)" hint="Report which findings are fixed without touching GitHub." />
										{:else if !stored.id}
											<p class="why">{stored.why}</p>
										{:else}
											<p class="why">Posts stored review <code>{stored.id}</code> on #{pr.number}. Needs <code>HEAD</code> at the reviewed head.</p>
										{/if}
									</div>
									<div class="pr-cmd">
										<div class="cmdline"><span>$</span> gh pr checkout {pr.number}</div>
										<div class="cmdline main">
											<span>$</span>
											{#key prCommand(pr, action)}<b class="flash">{prCommand(pr, action)}</b>{/key}
										</div>
									</div>
									<button type="button" class="btn accent" disabled={action === 'post' && !stored.id} onclick={() => runPr(pr, action)}>
										Run {action}
									</button>
								</div>
							{/if}
						</article>
					{:else}
						<div class="empty"><strong>No open pull requests.</strong></div>
					{/each}
				</div>
			</section>

			<section id="runs">
				<div class="sec-head">
					<h2>Recent runs</h2>
					<span class="count">{runs.length}</span>
				</div>
				<div class="runs">
					{#each runs as r (r.runId)}
						{@const sev = severityCounts(r)}
						{@const open = isOpen(r)}
						<article class={['run', { open, focus: focusRun === r.runId }]} {@attach (node) => { if (focusRun === r.runId) scrollIntoView(node); }}>
							<button type="button" class="run-row" aria-expanded={open} onclick={() => (openRun = open ? '' : r.runId)}>
								<StatusPill status={r.status} size="sm" />
								<code class="rid">{r.runId}</code>
								<span class="kind">{r.kind}</span>
								<span class="rtitle">{r.title}</span>
								<code class="rstate">{r.state}{r.round > 1 ? ` · r${r.round}` : ''}</code>
								<span class="rtime">{relTime(r.updatedAt)}</span>
								<span class="rcost">{usd(r.costUsd)}</span>
							</button>
							{#if open}
								<div class="run-detail" transition:slide={{ duration: 240 }}>
									<div class="rd-left">
										<dl>
											<dt>command</dt><dd><code>{commandFor(r)}</code></dd>
											{#if r.branch}<dt>branch</dt><dd><code>{r.branch}</code></dd>{/if}
											{#if r.escalationReason}<dt>escalated</dt><dd class="plum">{r.escalationReason}</dd>{/if}
											{#if r.error}<dt>error</dt><dd class="red">{r.error}</dd>{/if}
											{#if r.findings.length}
												<dt>findings</dt>
												<dd class="sev">
													<span class="mf">{sev.mustFix} must-fix</span><span class="tr">{sev.tradeoff} tradeoff</span><span class="nt">{sev.nit} nit</span>
												</dd>
											{/if}
											{#if r.prUrl}<dt>PR</dt><dd><a href={r.prUrl} target="_blank" rel="noreferrer">{r.prUrl.replace('https://', '')}</a></dd>{/if}
											{#if r.diffStat.files}<dt>diff</dt><dd>{r.diffStat.files} files <span class="add">+{r.diffStat.additions}</span> <span class="del">−{r.diffStat.deletions}</span></dd>{/if}
										</dl>
										<div class="rd-actions">
											{#if r.status === 'interrupted' || r.status === 'failed'}
												<button type="button" class="btn accent" onclick={() => lp.resumeRun(r.runId)}>Resume</button>
											{/if}
											{#if r.status === 'running' || r.status === 'waiting'}
												<button type="button" class="btn danger" onclick={() => cancel(r)}>Cancel</button>
											{/if}
											<code class="logs">ship logs {r.runId}{r.status === 'running' || r.status === 'waiting' ? ' --follow' : ''}</code>
										</div>
									</div>
									<ol class="events">
										{#each r.events.slice(-7) as e (e.seq)}
											<li in:fly={{ y: 6, duration: 200 }}><time>{clock(e.at)}</time><span class={e._tag}>{describe(e)}</span></li>
										{/each}
									</ol>
								</div>
							{/if}
						</article>
					{/each}
				</div>
			</section>
		</div>
	{/if}
{/if}

<style>
	code {
		font-family: var(--mono);
		font-size: 0.9em;
	}
	.missing {
		text-align: center;
		padding: 100px 0;
	}
	.missing h1 {
		font: 800 40px var(--display);
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 26px;
	}
	.title {
		display: flex;
		align-items: center;
		gap: 22px;
	}
	.blob {
		width: 78px;
		height: 78px;
		border-radius: 28px;
		background: var(--accent);
		color: #fff;
		display: grid;
		place-items: center;
		font: 800 40px var(--display);
		text-transform: uppercase;
		box-shadow: 0 14px 30px -14px var(--accent);
		transform: rotate(-4deg);
	}
	h1 {
		font: 800 52px/1 var(--display);
		letter-spacing: -0.03em;
		margin: 0 0 8px;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--muted);
		font-size: 13.5px;
	}
	.branch {
		font: 600 12.5px var(--mono);
		background: var(--card);
		padding: 3px 10px;
		border-radius: 999px;
		color: var(--ink-2);
		margin-left: 6px;
	}
	.head-stats {
		display: flex;
		gap: 10px;
	}
	.head-stats div {
		display: grid;
		padding: 14px 20px;
		background: var(--card);
		border-radius: 20px;
		box-shadow: var(--shadow-sm);
		min-width: 120px;
	}
	.head-stats strong {
		font: 800 26px var(--display);
	}
	.head-stats span {
		font-size: 13px;
		color: var(--muted);
	}
	.tabs {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px;
		background: var(--bg-2);
		border-radius: 999px;
		width: fit-content;
		margin-bottom: 34px;
	}
	.tabs a {
		font-weight: 700;
		font-size: 15px;
		color: var(--ink-2);
		text-decoration: none;
		padding: 9px 22px;
		border-radius: 999px;
		transition: background 0.2s;
	}
	.tabs a.on {
		background: var(--card);
		color: var(--ink);
		box-shadow: 0 2px 6px -2px rgba(60, 30, 10, 0.2);
	}
	.conv {
		display: flex;
		gap: 4px;
		align-items: center;
		font-size: 12.5px;
		color: var(--muted);
		padding: 0 14px 0 18px;
	}
	.conv span {
		font: 11.5px var(--mono);
		padding: 2px 7px;
		border-radius: 999px;
		background: var(--bg);
		color: var(--ink-2);
	}
	section {
		margin-bottom: 48px;
		scroll-margin-top: 100px;
	}
	.sec-head {
		display: flex;
		align-items: baseline;
		gap: 12px;
		margin-bottom: 16px;
	}
	h2 {
		font: 750 28px var(--display);
		letter-spacing: -0.01em;
		margin: 0;
	}
	.count {
		font: 700 14px var(--sans);
		background: var(--accent-soft);
		color: var(--accent-ink);
		padding: 2px 10px;
		border-radius: 999px;
	}
	.hint {
		font-size: 14px;
		color: var(--muted);
	}
	.hint code,
	.empty code,
	.why code {
		background: var(--bg-2);
		padding: 1px 5px;
		border-radius: 5px;
	}
	.plans {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(520px, 1fr));
		gap: 18px;
	}
	.plan {
		background: var(--card);
		border-radius: var(--radius);
		padding: 26px 28px 18px;
		box-shadow: var(--shadow-sm);
		transition: box-shadow 0.25s;
	}
	.plan:hover {
		box-shadow: var(--shadow);
	}
	.plan-top {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
	}
	h3 {
		font: 750 24px/1.2 var(--display);
		margin: 0 0 6px;
	}
	.plan-meta {
		font-size: 13px;
		color: var(--muted);
	}
	.doc-tabs {
		display: flex;
		gap: 4px;
		margin: 18px 0 10px;
	}
	.doc-tabs button {
		font: 600 12.5px var(--mono);
		padding: 5px 11px;
		border-radius: 999px;
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.doc-tabs button.on {
		background: var(--bg-2);
		color: var(--ink);
	}
	.doc {
		position: relative;
		max-height: 150px;
		overflow: hidden;
		padding: 16px 18px;
		background: var(--bg);
		border-radius: 18px;
		transition: max-height 0.4s ease;
	}
	.doc:not(.open)::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 50px;
		background: linear-gradient(transparent, var(--bg));
	}
	.doc.open {
		max-height: 800px;
	}
	.more {
		margin-top: 8px;
		background: none;
		border: 0;
		font: 600 13px var(--sans);
		color: var(--accent-ink);
		cursor: pointer;
		padding: 4px 0;
	}
	.btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font: 700 14px var(--sans);
		padding: 10px 18px;
		border-radius: 999px;
		border: 0;
		cursor: pointer;
		text-decoration: none;
		white-space: nowrap;
		transition:
			transform 0.15s,
			box-shadow 0.2s;
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
	.btn.accent:hover:not(:disabled) {
		box-shadow: 0 10px 22px -10px var(--accent);
		transform: translateY(-1px);
	}
	.btn.big {
		font-size: 16px;
		padding: 13px 20px 13px 24px;
	}
	.btn svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
		transition: transform 0.2s;
	}
	.btn:hover svg {
		transform: translateX(3px);
	}
	.btn.soft {
		background: var(--accent-soft);
		color: var(--accent-ink);
		font-family: var(--mono);
		font-size: 13px;
	}
	.btn.danger {
		background: var(--red-soft);
		color: var(--red);
	}
	.empty {
		display: grid;
		gap: 4px;
		padding: 28px;
		border: 2px dashed var(--line-2);
		border-radius: var(--radius);
		color: var(--ink-2);
	}
	.prs,
	.runs {
		display: grid;
		gap: 10px;
	}
	.pr {
		background: var(--card);
		border-radius: 22px;
		box-shadow: var(--shadow-sm);
		transition: box-shadow 0.2s;
	}
	.pr.active {
		box-shadow: 0 0 0 2px var(--accent), var(--shadow);
	}
	.pr-row {
		display: flex;
		align-items: center;
		gap: 18px;
		padding: 18px 22px;
	}
	.pr-num {
		font: 800 22px var(--display);
		color: var(--accent-ink);
		min-width: 60px;
	}
	.pr-main {
		flex: 1;
		display: grid;
		gap: 3px;
		min-width: 0;
	}
	.pr-main strong {
		font-size: 16.5px;
	}
	.pr-meta {
		font-size: 13px;
		color: var(--muted);
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.threads {
		background: var(--amber-soft);
		color: var(--amber);
		font-weight: 700;
		padding: 1px 8px;
		border-radius: 999px;
	}
	.last-rev {
		background: var(--bg);
		padding: 1px 8px;
		border-radius: 999px;
		font-family: var(--mono);
		font-size: 12px;
	}
	.seg {
		display: flex;
		gap: 3px;
		padding: 4px;
		background: var(--bg);
		border-radius: 999px;
	}
	.seg button {
		font: 700 13.5px var(--sans);
		padding: 8px 15px;
		border-radius: 999px;
		border: 0;
		background: none;
		color: var(--ink-2);
		cursor: pointer;
		transition:
			background 0.15s,
			transform 0.12s;
	}
	.seg button:hover:not(:disabled) {
		background: var(--card);
	}
	.seg button:active:not(:disabled) {
		transform: scale(0.94);
	}
	.seg button.on {
		background: var(--ink);
		color: var(--bg);
	}
	.seg button:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.pr-panel {
		display: grid;
		grid-template-columns: 1fr 1.1fr auto;
		gap: 24px;
		align-items: center;
		padding: 18px 22px 22px;
		border-top: 1px dashed var(--line);
	}
	.pr-opts {
		display: grid;
		gap: 12px;
	}
	.why {
		margin: 0;
		font-size: 14px;
		color: var(--ink-2);
	}
	.pr-cmd {
		background: var(--code-bg);
		color: var(--code-ink);
		border-radius: 14px;
		padding: 12px 16px;
		font: 13px/1.7 var(--mono);
	}
	.cmdline {
		opacity: 0.55;
	}
	.cmdline.main {
		opacity: 1;
	}
	.cmdline span {
		color: var(--accent);
		margin-right: 6px;
	}
	.cmdline b {
		font-weight: 500;
	}
	.flash {
		animation: flash 0.6s ease-out;
		border-radius: 4px;
	}
	@keyframes flash {
		from {
			background: rgba(247, 181, 138, 0.35);
		}
	}
	.run {
		background: var(--card);
		border-radius: 20px;
		box-shadow: var(--shadow-sm);
		overflow: hidden;
		transition: box-shadow 0.2s;
	}
	.run.focus {
		box-shadow: 0 0 0 2px var(--accent), var(--shadow);
		animation: pop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	@keyframes pop {
		40% {
			transform: scale(1.012);
		}
	}
	.run-row {
		width: 100%;
		display: grid;
		grid-template-columns: 116px 70px 82px 1fr 170px 70px 66px;
		align-items: center;
		gap: 12px;
		padding: 14px 20px;
		border: 0;
		background: none;
		font: inherit;
		color: var(--ink);
		text-align: left;
		cursor: pointer;
	}
	.run-row:hover {
		background: color-mix(in srgb, var(--bg) 60%, transparent);
	}
	.rid {
		font-weight: 700;
	}
	.kind {
		font: 600 12px var(--mono);
		color: var(--ink-2);
		background: var(--bg);
		padding: 2px 8px;
		border-radius: 999px;
		justify-self: start;
	}
	.rtitle {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.rstate {
		color: var(--muted);
		font-size: 12.5px;
	}
	.rtime {
		font-size: 13px;
		color: var(--muted);
	}
	.rcost {
		font: 700 15px var(--display);
		text-align: right;
	}
	.run-detail {
		display: grid;
		grid-template-columns: 1fr 1.1fr;
		gap: 28px;
		padding: 6px 20px 20px;
	}
	dl {
		display: grid;
		grid-template-columns: 90px 1fr;
		gap: 8px 12px;
		margin: 0;
		font-size: 13.5px;
	}
	dt {
		color: var(--muted);
		font-size: 12.5px;
	}
	dd {
		margin: 0;
	}
	dd a {
		color: var(--accent-ink);
	}
	.plum {
		color: var(--plum);
		font-weight: 600;
	}
	.red {
		color: var(--red);
		font-weight: 600;
	}
	.sev {
		display: flex;
		gap: 6px;
	}
	.sev span {
		font-size: 12px;
		font-weight: 700;
		padding: 1px 8px;
		border-radius: 999px;
	}
	.mf {
		background: var(--red-soft);
		color: var(--red);
	}
	.tr {
		background: var(--amber-soft);
		color: var(--amber);
	}
	.nt {
		background: var(--bg-2);
		color: var(--ink-2);
	}
	.add {
		color: var(--teal);
		font-weight: 600;
	}
	.del {
		color: var(--red);
		font-weight: 600;
	}
	.rd-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 16px;
	}
	.logs {
		font-size: 12.5px;
		color: var(--muted);
	}
	.events {
		list-style: none;
		margin: 0;
		padding: 14px 16px;
		background: var(--code-bg);
		color: var(--code-ink);
		border-radius: 16px;
		font: 12.5px/1.75 var(--mono);
	}
	.events li {
		display: flex;
		gap: 12px;
		white-space: nowrap;
		overflow: hidden;
	}
	.events li span {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	time {
		opacity: 0.45;
	}
	.events .Escalated,
	.events .RunInterrupted {
		color: #f0a6c9;
	}
	.events .PrOpened,
	.events .RunFinished {
		color: #b9e3c6;
	}
	.events .ClefDecision {
		color: #ffd98a;
	}
</style>
