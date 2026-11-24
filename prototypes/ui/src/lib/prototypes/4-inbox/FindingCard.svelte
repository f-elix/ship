<script lang="ts" module>
	import type { Decision } from './inbox.svelte.ts';
	import type { Severity } from '#lib';

	export const choicesFor = (s: Severity): { d: Decision; label: string; key: string }[] =>
		s === 'must-fix'
			? [
					{ d: 'leave', label: 'Leave for fix', key: 'l' },
					{ d: 'tradeoff', label: 'Accept as tradeoff', key: 'a' },
					{ d: 'nit', label: 'Downgrade to nit', key: 'n' },
					{ d: 'dismiss', label: 'Dismiss', key: 'd' }
				]
			: s === 'tradeoff'
				? [
						{ d: 'leave', label: 'Keep as tradeoff', key: 'l' },
						{ d: 'fix', label: 'Fix anyway', key: 'x' },
						{ d: 'dismiss', label: 'Dismiss', key: 'd' }
					]
				: [
						{ d: 'leave', label: 'Leave for fix', key: 'l' },
						{ d: 'tradeoff', label: 'Accept as tradeoff', key: 'a' },
						{ d: 'dismiss', label: 'Dismiss', key: 'd' }
					];
</script>

<script lang="ts">
	import CodeExcerpt from './CodeExcerpt.svelte';
	import { excerpts, type InboxFinding } from './data.ts';
	import { effectiveSeverity, getInbox } from './inbox.svelte.ts';

	let {
		finding,
		runId,
		active = false,
		readonly = false,
		onfocus
	}: { finding: InboxFinding; runId: string; active?: boolean; readonly?: boolean; onfocus?: () => void } = $props();

	const inbox = getInbox();

	const decision = $derived(inbox.decision(runId, finding));
	const eff = $derived(effectiveSeverity(finding, decision));
	const verdictKind = $derived(
		finding.verdict.startsWith('traced') ? 'traced' : finding.verdict.startsWith('structural') ? 'structural' : 'code reading'
	);
	const verdictRest = $derived(finding.verdict.replace(/^(traced|structural|code reading)[:.]?\s*/, ''));
	const excerpt = $derived(excerpts[`${runId}:${finding.id}`]);

	let el = $state<HTMLElement>();
	$effect(() => {
		if (active) el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
	bind:this={el}
	class={['card', `sev-${finding.severity}`, active && 'active', eff === 'dismissed' && 'dismissed']}
	onclick={onfocus}
	aria-label="{finding.id} {finding.severity}"
>
	<header>
		<span class="sev">
			<i></i>
			{#if eff !== finding.severity}
				<s>{finding.severity}</s> → <b class="to-{eff}">{eff}</b>
			{:else}
				{finding.severity}
			{/if}
		</span>
		<code class="fid">{finding.id}</code>
		<span class="reviewer">{finding.reviewer}</span>
		{#if finding.repeats}
			<span class="stall" title="Reported again after a fix round — ship escalates a stalled finding">
				<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
					><path d="M3 8a5 5 0 0 1 8.6-3.5M13 8a5 5 0 0 1-8.6 3.5M11 2v3h-3M5 14v-3h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg
				>
				repeats {finding.repeats}
			</span>
		{/if}
		{#if finding.lowered}
			<span class="lowered" title="Clef rated it a formatter, linter or taste remark">↓ lowered by Clef · p={finding.lowered.p.toFixed(2)}</span>
		{/if}
		<span class={['verdict', `v-${verdictKind.replace(' ', '-')}`]} title={finding.verdict}>{verdictKind}</span>
	</header>

	<p class="claim">{finding.claim}</p>

	<CodeExcerpt file={finding.file} line={finding.line} {excerpt} tone={finding.severity} />

	<dl>
		<dt>Evidence</dt>
		<dd>{finding.evidence}</dd>
		<dt>Verifier</dt>
		<dd>{verdictRest || '—'}</dd>
	</dl>

	{#if !readonly}
		<div class="choices" role="radiogroup" aria-label="Your call on {finding.id}">
			{#each choicesFor(finding.severity) as c (c.d)}
				<button
					type="button"
					role="radio"
					aria-checked={decision === c.d}
					class={[decision === c.d && 'on', `c-${c.d}`]}
					onclick={(e) => {
						e.stopPropagation();
						inbox.decide(runId, finding, c.d);
						onfocus?.();
					}}
				>
					{c.label}{#if active}<kbd>{c.key}</kbd>{/if}
				</button>
			{/each}
		</div>
	{/if}
</article>

<style>
	.card {
		position: relative;
		display: grid;
		gap: 12px;
		padding: 16px 18px 14px 20px;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 10px;
		scroll-margin: 24px;
		transition:
			box-shadow 0.15s,
			border-color 0.15s,
			opacity 0.15s;
		--sev: var(--mf);
		--sev-wash: var(--mf-wash);
	}
	.card::before {
		content: '';
		position: absolute;
		left: -1px;
		top: 14px;
		bottom: 14px;
		width: 3px;
		border-radius: 0 3px 3px 0;
		background: var(--sev);
	}
	.sev-tradeoff {
		--sev: var(--tr);
		--sev-wash: var(--tr-wash);
	}
	.sev-nit {
		--sev: var(--nit);
		--sev-wash: var(--nit-wash);
	}
	.card.active {
		border-color: color-mix(in oklab, var(--sev) 45%, var(--line));
		box-shadow:
			0 0 0 3px var(--sev-wash),
			0 6px 20px -12px rgb(0 0 0 / 0.25);
	}
	.card.dismissed {
		opacity: 0.55;
	}
	.card.dismissed .claim {
		text-decoration: line-through;
		text-decoration-color: var(--faint);
	}
	header {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12px;
		color: var(--muted);
		flex-wrap: wrap;
	}
	.sev {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		color: var(--sev);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-size: 11px;
	}
	.sev i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--sev);
	}
	.sev s {
		color: var(--faint);
	}
	.to-tradeoff {
		color: var(--tr);
	}
	.to-nit {
		color: var(--nit);
	}
	.to-must-fix {
		color: var(--mf);
	}
	.to-dismissed {
		color: var(--muted);
	}
	.fid {
		font: 11.5px var(--mono);
		color: var(--ink);
	}
	.reviewer::before {
		content: '·';
		margin-right: 10px;
		color: var(--faint);
	}
	.stall {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--mf-wash);
		color: var(--mf);
		font-weight: 600;
	}
	.lowered {
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--clef-wash);
		color: var(--clef);
		font-weight: 500;
	}
	.verdict {
		margin-left: auto;
		padding: 2px 8px;
		border-radius: 4px;
		font: 600 10.5px/1.5 var(--mono);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		border: 1px solid currentColor;
	}
	.v-traced {
		color: #23744a;
		background: #eaf5ee;
	}
	.v-structural {
		color: #3c5a85;
		background: #edf2f8;
	}
	.v-code-reading {
		color: #7a6a3b;
		background: #f6f2e6;
	}
	.claim {
		margin: 0;
		font-size: 15px;
		line-height: 1.5;
		color: var(--ink);
		text-wrap: pretty;
	}
	dl {
		display: grid;
		grid-template-columns: 72px 1fr;
		gap: 4px 12px;
		margin: 0;
		font-size: 12.5px;
		line-height: 1.5;
	}
	dt {
		color: var(--faint);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding-top: 2px;
	}
	dd {
		margin: 0;
		color: var(--ink-2);
	}
	.choices {
		display: flex;
		gap: 0;
		border: 1px solid var(--line);
		border-radius: 7px;
		width: fit-content;
		overflow: hidden;
		background: var(--bg);
	}
	.choices button {
		all: unset;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 11px;
		font-size: 12px;
		color: var(--muted);
		border-right: 1px solid var(--line);
	}
	.choices button:last-child {
		border-right: 0;
	}
	.choices button:hover {
		color: var(--ink);
		background: var(--panel);
	}
	.choices button:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
	}
	.choices button.on {
		background: var(--ink);
		color: var(--panel);
	}
	.choices button.on.c-tradeoff {
		background: var(--tr);
	}
	.choices button.on.c-nit {
		background: var(--nit);
	}
	.choices button.on.c-fix {
		background: var(--mf);
	}
	.choices button.on.c-dismiss {
		background: var(--muted);
	}
	kbd {
		font: 10px var(--mono);
		padding: 0 4px;
		border-radius: 3px;
		border: 1px solid currentColor;
		opacity: 0.6;
	}
</style>
