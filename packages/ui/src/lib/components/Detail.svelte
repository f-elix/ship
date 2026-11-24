<script lang="ts">
	import { ACTIONS, shortcutAction } from '#lib/actions.ts';
	import { relTime } from '#lib/format.ts';
	import { plural, shortSha } from '@ship/core/event-lines';
	import type { ActionKind, DeliverableSummary } from '#lib/server/deliverables.ts';
	import type { DeliverableDetail } from '#lib/server/detail.ts';
	import FindingCard from './FindingCard.svelte';
	import History from './History.svelte';
	import Rich from './Rich.svelte';

	let {
		d,
		detail,
		loadError,
		refusal,
		now,
		busy,
		onact
	}: {
		/** The deliverable as the live list has it, always current. */
		d: DeliverableSummary;
		/** The rest of it, once loaded. */
		detail: DeliverableDetail | undefined;
		/** Why the rest could not be loaded; it is retried. */
		loadError: string | undefined;
		/** Why the last action was refused. */
		refusal: string | null;
		now: number;
		/** An action is in flight; the buttons wait for it. */
		busy: boolean;
		onact: (action: ActionKind) => void;
	} = $props();

	const [primary, ...secondary] = $derived(d.actions);
	const findings = $derived(
		detail === undefined
			? []
			: [...detail.findings.mustFix, ...detail.findings.tradeoffs, ...detail.findings.nits]
	);
	/** preview: verified but not yet triaged; readonly: ship is still working; post: not on GitHub yet. */
	const mode = $derived(
		detail?.findings.settled === false
			? 'preview'
			: d.stage === 'working'
				? 'readonly'
				: d.actions.includes('post')
					? 'post'
					: 'open'
	);
	const heading = $derived(
		{
			preview: 'Early findings',
			readonly: 'Left for you so far',
			post: 'The review',
			open: 'Left for you'
		}[mode]
	);
	const note = $derived(
		{
			preview: 'Still being reviewed: verified, but not sorted yet.',
			readonly: 'Verified. You can decide once ship is done.',
			post: 'Not on GitHub yet. Post the review to put it on the PR.',
			open: ''
		}[mode]
	);
	const handled = $derived(
		detail === undefined
			? ''
			: [
					detail.resolved.length && `${detail.resolved.length} fixed`,
					detail.disproved && `${detail.disproved} disproved`,
					detail.reviewers.length && plural(detail.reviewers.length, 'reviewer'),
					detail.rounds && plural(detail.rounds, 'round')
				]
					.filter(Boolean)
					.join(' · ')
	);
	let openTail = $state<string | null>(null);
	let showError = $state(false);
</script>

<article class="detail">
	<header>
		<p class="crumb">
			{d.projectName}
			{#if d.branch}<span class="dot">·</span><code>{d.branch}</code>{/if}
			<span class="dot">·</span>{relTime(d.updatedAt, now)}
		</p>
		<h1>{d.title}</h1>
	</header>

	<!-- Where the output stands, and what to do about it -->
	<section class={['now', `tone-${d.tone}`]}>
		<p class="headline"><Rich text={d.headline} /></p>

		{#if d.prUrl}
			<p class="facts">
				<a href={d.prUrl} target="_blank" rel="noreferrer"
					>{d.prUrl.replace('https://', '')}</a
				>
			</p>
		{/if}

		{#if detail?.error}
			<button class="link" onclick={() => (showError = !showError)} aria-expanded={showError}
				>{showError ? 'Hide' : 'Show'} error</button
			>
			{#if showError}<pre class="tail">{detail.error}</pre>{/if}
		{/if}

		{#if primary}
			<div class="actions">
				<button
					class={['btn', ACTIONS[primary].danger && 'danger']}
					disabled={busy}
					title={shortcutAction(d.actions) === primary
						? `${ACTIONS[primary].tooltip}  (⌘↵)`
						: ACTIONS[primary].tooltip}
					onclick={() => onact(primary)}>{ACTIONS[primary].label}</button
				>
				{#each secondary as action (action)}
					<button
						class={['text-btn', ACTIONS[action].danger && 'danger']}
						disabled={busy}
						title={ACTIONS[action].tooltip}
						onclick={() => onact(action)}>{ACTIONS[action].label}</button
					>
				{/each}
			</div>
		{/if}
		{#if refusal}<p class="refusal" role="alert">{refusal}</p>{/if}
	</section>

	{#if loadError}<p class="loading" role="alert">{loadError} Retrying…</p>{/if}
	{#if detail === undefined}
		{#if !loadError}<p class="loading">Loading…</p>{/if}
	{:else}
		<!-- What's left for a human -->
		{#if findings.length}
			<section>
				<h2>{heading} <span>{findings.length}</span></h2>
				{#if note}<p class="note">{note}</p>{/if}
				<ul class="rows">
					{#each findings as f (f.id)}
						<FindingCard {f} />
					{/each}
				</ul>
			</section>
		{/if}

		{#if detail.preexistingChecks.length}
			<section>
				<p class="note">
					{plural(detail.preexistingChecks.length, 'check')} already failed before this change,
					so it isn’t held to {detail.preexistingChecks.length === 1 ? 'it' : 'them'}:
					{#each detail.preexistingChecks as c, i (c.name)}{i ? ', ' : ''}<button
							class="link mono"
							onclick={() => (openTail = openTail === c.name ? null : c.name)}
							aria-expanded={openTail === c.name}>{c.name}</button
						>{/each}
				</p>
				{#each detail.preexistingChecks as c (c.name)}
					{#if openTail === c.name && c.outputTail}<pre
							class="tail">{c.outputTail}</pre>{/if}
				{/each}
			</section>
		{/if}

		<!-- Supporting detail: one line each, open on demand -->
		<div class="more">
			{#if detail.files?.length || detail.commits.length}
				<details>
					<summary>
						<span>The change</span>
						<span class="sum">
							{#if detail.files}{plural(detail.files.length, 'file')}{/if}
							{#if detail.files && detail.commits.length}·{/if}
							{#if detail.commits.length}{plural(
									detail.commits.length,
									'commit'
								)}{/if}
						</span>
					</summary>
					<div class="inner">
						{#if detail.files?.length}
							<ul class="files">
								{#each detail.files as f (f.path)}
									<li>
										<code
											>{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</code
										><span class={`fs-${f.status}`}>{f.status}</span>
									</li>
								{/each}
							</ul>
						{/if}
						{#if detail.commits.length}
							<ul class="files">
								{#each detail.commits as c (c.sha)}
									<li>
										<span>{c.message.split('\n', 1)[0]}</span><code
											>{shortSha(c.sha)}</code
										>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</details>
			{/if}

			{#if handled}
				<details>
					<summary><span>Handled by ship</span><span class="sum">{handled}</span></summary
					>
					<div class="inner">
						<ul class="files">
							{#each detail.resolved as f (f.id)}
								<li>
									<span><Rich text={f.claim} /></span><code
										>{f.file}{f.line ? `:${f.line}` : ''}</code
									>
								</li>
							{/each}
						</ul>
						{#if detail.reviewers.length}<p class="sum">
								Reviewers: {detail.reviewers.join(', ')}
							</p>{/if}
					</div>
				</details>
			{/if}

			<History runs={detail.runs} />
		</div>
	{/if}
</article>

<style>
	.detail {
		max-width: 768px;
		margin: 0 auto;
		padding: 56px 48px 120px;
		display: grid;
		gap: 16px;
	}
	@media (max-width: 720px) {
		.detail {
			padding: 24px 16px 96px;
		}
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
	.loading {
		margin: 0;
		font-size: 13px;
		color: var(--dim);
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
	.tone-tradeoff {
		--t: var(--tr);
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
	.btn.danger {
		color: var(--text);
		background: var(--raised);
		border: 1px solid var(--line-strong);
	}
	.btn.danger:hover {
		color: var(--mf);
	}
	.btn:disabled,
	.text-btn:disabled {
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
	.refusal {
		margin: 0;
		font-size: 13px;
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
	.tail {
		margin: 6px 0 0;
		padding: 14px 16px;
		font: 12px/1.65 var(--mono);
		color: var(--muted);
		background: var(--code);
		border-radius: 8px;
		white-space: pre-wrap;
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
	.fs-added {
		color: var(--ok) !important;
	}
	.fs-deleted {
		color: var(--mf) !important;
	}
</style>
