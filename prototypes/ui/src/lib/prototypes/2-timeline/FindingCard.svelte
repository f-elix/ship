<script lang="ts">
	import type { DisprovedFinding, Finding } from '#lib';
	import Rich from './Rich.svelte';
	import { severityTone, verdictMethod } from './words.ts';

	type Props =
		| { finding: Finding; disproved?: undefined; compact?: boolean }
		| { finding?: undefined; disproved: DisprovedFinding; compact?: boolean };

	let { finding, disproved, compact = false }: Props = $props();

	let where = $derived.by(() => {
		const f = finding ?? disproved;
		return f ? `${f.file}${f.line ? `:${f.line}` : ''}` : '';
	});
	let verdict = $derived(finding ? verdictMethod(finding.verdict) : null);
</script>

{#if finding}
	<blockquote class={['card', severityTone[finding.severity], compact && 'compact']} id="finding-{finding.id}">
		<header>
			<span class="sev">{finding.severity}</span>
			<span class="id">{finding.id}</span>
			{#if finding.repeats}
				<a class="repeats" href="#finding-{finding.repeats}" title="The same problem was reported in an earlier round">
					repeats {finding.repeats}
				</a>
			{/if}
			<code class="where">{where}</code>
		</header>
		<p class="claim"><Rich text={finding.claim} /></p>
		{#if !compact}
			<p class="evidence"><span class="label">Evidence</span> <Rich text={finding.evidence} /></p>
			{#if verdict}
				<p class="verdict">
					<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
					<span>Kept by the verifier, <em>{verdict.method}</em>{verdict.rest ? ':' : '.'}</span>
					{#if verdict.rest}<span class="rest"><Rich text={verdict.rest} /></span>{/if}
				</p>
			{/if}
		{/if}
	</blockquote>
{:else if disproved}
	<blockquote class="card disproved">
		<header>
			<span class="sev">disproved</span>
			<code class="where">{where}</code>
		</header>
		<p class="claim"><s>{disproved.claim}</s></p>
		<p class="verdict no">
			<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
			<span class="rest"><Rich text={disproved.reason.replace(/^disproved:\s*/, '')} /></span>
		</p>
	</blockquote>
{/if}

<style>
	.card {
		--sev: var(--muted);
		--sev-soft: var(--paper-sunk);
		margin: 10px 0 12px;
		padding: 14px 18px 14px 20px;
		background: var(--paper-raised);
		border: 1px solid var(--rule);
		border-left: 3px solid var(--sev);
		border-radius: 2px 8px 8px 2px;
	}

	.card.red {
		--sev: var(--red);
		--sev-soft: var(--red-soft);
	}
	.card.amber {
		--sev: var(--amber);
		--sev-soft: var(--amber-soft);
	}
	.card.muted {
		--sev: var(--faint);
	}

	.card.compact {
		padding: 9px 14px 10px 16px;
		margin: 6px 0;
	}

	.card.disproved {
		--sev: var(--rule-strong);
		background: transparent;
		border-style: dashed;
		border-left-style: solid;
	}

	header {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin-bottom: 6px;
		font-size: 12px;
	}

	.sev {
		padding: 1px 7px;
		border-radius: 3px;
		background: var(--sev-soft);
		color: var(--sev);
		font-weight: 600;
		letter-spacing: 0.02em;
	}

	.disproved .sev {
		color: var(--muted);
	}

	.id {
		font: 500 12px var(--mono);
		color: var(--ink-2);
	}

	.repeats {
		font: 500 11.5px var(--mono);
		color: var(--amber);
		text-decoration: none;
		border-bottom: 1px dotted currentColor;
	}

	.repeats::before {
		content: '↺ ';
	}

	.where {
		margin-left: auto;
		color: var(--muted);
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	p {
		margin: 0;
	}

	.claim {
		font: 17px/1.5 var(--serif);
		color: var(--ink);
	}

	.compact .claim {
		font-size: 15.5px;
	}

	.disproved .claim {
		color: var(--muted);
	}

	s {
		text-decoration-color: var(--faint);
	}

	.evidence {
		margin-top: 8px;
		font-size: 13.5px;
		color: var(--ink-2);
	}

	.label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--faint);
		margin-right: 4px;
	}

	.verdict {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 6px;
		margin-top: 10px;
		padding-top: 9px;
		border-top: 1px solid var(--rule);
		font-size: 13px;
		color: var(--green);
	}

	.verdict svg {
		align-self: center;
	}

	.verdict.no {
		margin-top: 6px;
		padding-top: 0;
		border-top: 0;
		color: var(--muted);
	}

	.rest {
		color: var(--ink-2);
	}

	.no .rest {
		color: var(--muted);
	}
</style>
