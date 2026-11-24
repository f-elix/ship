<script lang="ts">
	import { relTime, shortSha, type Run } from '#lib';
	import { planFor, projectName, type Deliverable } from './data.ts';
	import FindingCard from './FindingCard.svelte';
	import History from './History.svelte';
	import Rich from './Rich.svelte';
	import type { Inbox } from './state.svelte.ts';

	let { inbox, d, live }: { inbox: Inbox; d: Deliverable; live: Run } = $props();

	const primary = $derived(inbox.primaryFor(d));
	const findings = $derived([...d.open.mustFix, ...d.open.tradeoffs, ...d.open.nits]);
	/** preview: unverified findings of a review in progress; readonly: verified, but ship is still working. */
	const mode = $derived(
		findings.some((f) => f.verdict.startsWith('Not verified'))
			? 'preview'
			: d.stage === 'working'
				? 'readonly'
				: d.primary?.command.startsWith('ship post')
					? 'post'
					: 'fix'
	);
	const preexisting = $derived(d.checks.filter((c) => c.preexisting && !c.ok));
	const ownChecks = $derived(d.checks.filter((c) => !c.preexisting));
	const failingOwn = $derived(ownChecks.filter((c) => !c.ok).length);
	const plan = $derived(planFor(d.id));
	const totals = $derived(d.files.reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 }));
	let openTail = $state<string | null>(null);
	let showError = $state(false);

	const heading = $derived(
		mode === 'preview' ? 'Early findings' : mode === 'post' ? 'The review' : mode === 'readonly' ? 'Left for you so far' : 'Left for you'
	);
	const note = $derived(
		{
			preview: 'Still being reviewed. The verifier hasn’t checked these yet.',
			readonly: 'Verified. You can decide once the PR is up.',
			post: 'Not on GitHub yet. Drop what you don’t want to say; the rest posts as one review.',
			fix: ''
		}[mode]
	);

	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
	const handled = $derived(
		[
			d.resolved.length && `${d.resolved.length} fixed`,
			d.disproved && `${d.disproved} disproved`,
			d.reviewers.length && plural(d.reviewers.length, 'reviewer'),
			d.rounds && plural(d.rounds, 'round')
		]
			.filter(Boolean)
			.join(' · ')
	);
</script>

<article class="detail">
	<header>
		<p class="crumb">
			{projectName(d.projectKey)}
			{#if d.branch}<span class="dot">·</span><code>{d.branch}</code>{/if}
			<span class="dot">·</span>{relTime(d.updatedAt)}
		</p>
		<h1>{d.title}</h1>
	</header>

	<!-- Where the output stands, and the one thing to do about it -->
	<section class={['now', `tone-${d.tone}`]}>
		<p class="headline"><Rich text={d.headline} /></p>

		{#if d.pr}
			<p class="facts">
				<a href={d.pr.url} target="_blank" rel="noreferrer">PR #{d.pr.number}</a>
				<span>{d.pr.state}</span>
				<span class:bad={d.pr.ci === 'failing'}>CI {d.pr.ci}</span>
				{#if ownChecks.length}<span class:bad={failingOwn > 0}>checks {ownChecks.length - failingOwn}/{ownChecks.length}</span>{/if}
				{#if d.pr.threads.open}<span>{plural(d.pr.threads.open, 'open thread')}</span>{/if}
				{#if d.pr.approval !== 'none'}<span>{d.pr.approval.replace('-', ' ')}</span>{/if}
			</p>
		{/if}

		{#if d.progress}
			<div class="progress">
				<span class="track"><i style:width="{(d.progress.step / d.progress.of) * 100}%"></i></span>
				<span class="step"><i class="pulse"></i>{d.progress.now}</span>
				<span class="eta">{d.progress.eta}</span>
			</div>
		{/if}

		{#if d.failure}
			<p class="produced">{d.failure.produced} {d.failure.retry}</p>
			<button class="link" onclick={() => (showError = !showError)}>{showError ? 'Hide' : 'Show'} error</button>
			{#if showError}<pre class="tail">{d.failure.error}</pre>{/if}
		{/if}

		{#if primary || d.secondary.length}
			<div class="actions">
				{#if primary}
					<button
						class="btn"
						disabled={primary.command === '—'}
						title={primary.command !== '—' ? `$ ${primary.command}  (⌘↵)` : undefined}
						onclick={() => inbox.act(d, primary)}>{primary.label}</button
					>
				{/if}
				{#each d.secondary as a (a.label)}
					<button class={['text-btn', a.tone === 'danger' && 'danger']} title={a.command !== '—' ? `$ ${a.command}` : undefined} onclick={() => inbox.act(d, a)}
						>{a.label}</button
					>
				{/each}
			</div>
		{/if}
	</section>

	<!-- What's left for a human -->
	{#if findings.length}
		<section>
			<h2>{heading} <span>{findings.length}</span></h2>
			{#if note}<p class="note">{note}</p>{/if}
			<ul class="rows">
				{#each findings as f (f.id)}
					<FindingCard {inbox} {d} {f} {mode} />
				{/each}
			</ul>
		</section>
	{/if}

	{#if d.threads.length}
		<section>
			<h2>Open threads on the PR <span>{d.threads.length}</span></h2>
			<p class="note">ship will take the must-fix and nit threads when the review finishes.</p>
			<ul class="rows">
				{#each d.threads as t (t.id)}
					<li class="thread">
						<p>{t.body}</p>
						<p class="tmeta">
							@{t.author} · {t.file}:{t.line} ·
							<span class={`r-${t.readAs.severity}`}>{t.readAs.severity === 'none' ? 'not a finding' : t.readAs.severity}</span>
						</p>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if preexisting.length}
		<section>
			<p class="note">
				{plural(preexisting.length, 'check')} already failed before this change, so it isn’t held to {preexisting.length === 1 ? 'it' : 'them'}:
				{#each preexisting as c, i (c.name)}{i ? ', ' : ''}<button class="link mono" onclick={() => (openTail = openTail === c.name ? null : c.name)}>{c.name}</button>{/each}
			</p>
			{#each preexisting as c (c.name)}
				{#if openTail === c.name && c.outputTail}<pre class="tail">{c.outputTail}</pre>{/if}
			{/each}
		</section>
	{/if}

	{#if plan}
		<section>
			<h2>The plan</h2>
			<pre class="plan">{plan.spec}

{plan.plan}</pre>
		</section>
	{/if}

	<!-- Supporting detail: one line each, open on demand -->
	<div class="more">
		{#if d.files.length || d.commits.length}
			<details>
				<summary>
					<span>The change</span>
					<span class="sum">
						{plural(d.files.length, 'file')} · <span class="add">+{totals.add}</span> <span class="del">−{totals.del}</span>
						{#if d.commits.length}· {plural(d.commits.length, 'commit')}{/if}
					</span>
				</summary>
				<div class="inner">
					{#if d.intent}<p class="intent"><Rich text={d.intent} /></p>{/if}
					<ul class="files">
						{#each d.files as f (f.path)}
							<li><code>{f.path}</code><span><span class="add">+{f.add}</span> <span class="del">−{f.del}</span></span></li>
						{/each}
					</ul>
					<ul class="files">
						{#each d.commits as c (c.sha)}
							<li><span>{c.message}</span><code>{shortSha(c.sha)}</code></li>
						{/each}
					</ul>
				</div>
			</details>
		{/if}

		{#if handled}
			<details>
				<summary><span>Handled by ship</span><span class="sum">{handled}</span></summary>
				<div class="inner">
					<ul class="files">
						{#each d.resolved as f (f.id)}
							<li><span><Rich text={f.claim} /></span><code>{f.file}{f.line ? `:${f.line}` : ''}</code></li>
						{/each}
					</ul>
					{#if d.reviewers.length}<p class="sum">Reviewers: {d.reviewers.join(', ')}</p>{/if}
				</div>
			</details>
		{/if}

		<History runIds={d.runIds} {live} />
	</div>
</article>

<style>
	.detail {
		max-width: 768px;
		margin: 0 auto;
		padding: 56px 48px 120px;
		display: grid;
		gap: 16px;
	}
	.crumb {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin: 0 0 10px;
		font-size: 13px;
		color: var(--dim);
	}
	.crumb code {
		font: 12.5px var(--mono);
	}
	h1 {
		margin: 0;
		font-size: 28px;
		line-height: 1.25;
		font-weight: 600;
		letter-spacing: -0.02em;
	}
	header {
		margin-bottom: 20px;
	}

	/* where it stands */
	.now {
		--t: var(--line-strong);
		position: relative;
		gap: 14px;
	}
	.now::before {
		content: '';
		position: absolute;
		left: -1px;
		top: 18px;
		bottom: 18px;
		width: 3px;
		border-radius: 0 3px 3px 0;
		background: var(--t);
	}
	.tone-must-fix {
		--t: var(--mf);
	}
	.tone-error {
		--t: var(--err);
	}
	.tone-ok {
		--t: var(--ok);
	}
	.tone-live {
		--t: var(--accent);
	}
	.headline {
		margin: 0;
		font-size: 17px;
		line-height: 1.55;
		color: var(--text);
	}
	.headline :global(code) {
		font: 14.5px var(--mono);
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
	.facts a {
		color: var(--text);
		text-decoration: none;
	}
	.facts a:hover {
		text-decoration: underline;
	}
	.bad {
		color: var(--mf);
	}
	.progress {
		display: flex;
		align-items: center;
		gap: 14px;
		font-size: 13px;
	}
	.track {
		width: 120px;
		height: 3px;
		border-radius: 2px;
		background: var(--line);
		overflow: hidden;
	}
	.track i {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width 0.4s;
	}
	.step {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--text);
	}
	.pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		animation: pulse 1.6s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.3;
		}
	}
	.eta {
		color: var(--dim);
	}
	.produced {
		margin: 0;
		font-size: 14px;
		line-height: 1.55;
		color: var(--muted);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 18px;
		margin-top: 6px;
	}
	.btn {
		padding: 8px 16px;
		font: 550 13.5px var(--sans);
		color: #0b0d10;
		background: var(--text);
		border: 0;
		border-radius: 8px;
		cursor: pointer;
	}
	.btn:hover {
		background: #fff;
	}
	.btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.text-btn {
		padding: 0;
		font: 500 13.5px var(--sans);
		color: var(--muted);
		background: none;
		border: 0;
		cursor: pointer;
	}
	.text-btn:hover {
		color: var(--text);
	}
	.text-btn.danger:hover {
		color: var(--mf);
	}
	.link {
		justify-self: start;
		padding: 0;
		font: 13px var(--sans);
		color: var(--accent);
		background: none;
		border: 0;
		cursor: pointer;
	}
	.link.mono {
		font: 12.5px var(--mono);
	}

	/* sections */
	section,
	.more {
		display: grid;
		gap: 6px;
		padding: 20px 24px;
		background: var(--card);
		border: 1px solid var(--card-line);
		border-radius: 12px;
	}
	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	h2 span {
		margin-left: 6px;
		font-weight: 400;
		color: var(--dim);
	}
	.note {
		margin: 0;
		font-size: 13px;
		line-height: 1.6;
		color: var(--dim);
	}
	.rows {
		list-style: none;
		margin: 10px 0 -14px;
		padding: 0;
	}
	.thread {
		padding: 14px 0;
		border-top: 1px solid var(--line-soft);
	}
	.thread p {
		margin: 0;
		font-size: 14.5px;
		line-height: 1.5;
	}
	.thread .tmeta {
		margin-top: 5px;
		font: 12px var(--mono);
		color: var(--dim);
	}
	.r-must-fix {
		color: var(--mf);
	}
	.tail,
	.plan {
		margin: 6px 0 0;
		padding: 14px 16px;
		font: 12px/1.65 var(--mono);
		color: var(--muted);
		background: var(--code);
		border-radius: 8px;
		white-space: pre-wrap;
	}
	.plan {
		font-size: 13px;
	}

	/* supporting detail */
	.more {
		gap: 0;
		padding-block: 4px;
	}
	.more :global(details + details) {
		border-top: 1px solid var(--line-soft);
	}
	.more :global(summary) {
		display: flex;
		align-items: baseline;
		gap: 14px;
		padding: 14px 0;
		font-size: 13.5px;
		color: var(--muted);
		list-style: none;
		cursor: pointer;
	}
	.more :global(summary::-webkit-details-marker) {
		display: none;
	}
	.more :global(summary:hover) {
		color: var(--text);
	}
	.more :global(summary::after) {
		content: '›';
		margin-left: auto;
		color: var(--dim);
		transition: transform 0.15s;
	}
	.more :global(details[open] > summary::after) {
		transform: rotate(90deg);
	}
	.more :global(.sum) {
		margin: 0;
		font-size: 12.5px;
		color: var(--dim);
	}
	.inner {
		display: grid;
		gap: 14px;
		padding: 0 0 18px;
	}
	.intent {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.6;
		color: var(--muted);
	}
	.files {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
		font-size: 13px;
		color: var(--muted);
	}
	.files li {
		display: flex;
		justify-content: space-between;
		gap: 16px;
	}
	.files code {
		font: 12px var(--mono);
		color: var(--muted);
	}
	.files li > span:last-child,
	.files li > code:last-child {
		flex: none;
		font: 12px var(--mono);
		color: var(--dim);
	}
	.add {
		color: var(--ok);
	}
	.del {
		color: var(--mf);
	}
</style>
