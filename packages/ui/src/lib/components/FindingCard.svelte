<script lang="ts">
	import type { VerifiedFinding } from '@ship/core/finding';
	import Rich from './Rich.svelte';

	/** One open finding as a row: claim and location up front; evidence on demand. */
	let { f }: { f: VerifiedFinding } = $props();

	let open = $state(false);
</script>

<li class={['finding', `sev-${f.severity}`, open && 'open']}>
	<button class="head" onclick={() => (open = !open)} aria-expanded={open}>
		<span class="claim"><Rich text={f.claim} /></span>
		<span class="meta">
			<span class="sev">{f.severity}</span>
			<span>{f.file}{f.line ? `:${f.line}` : ''}</span>
			{#if f.repeats}<span class="flag">came back after ship’s fix</span>{/if}
		</span>
	</button>

	{#if open}
		<div class="body">
			<p class="evidence"><Rich text={f.evidence} /></p>
			<p class="by">
				{f.reviewer.replace('github:', '@')}{#if f.alsoReportedBy.length}
					· also {f.alsoReportedBy.join(', ')}{/if} · round {f.round}
			</p>
		</div>
	{/if}
</li>

<style>
	.finding {
		--sev: var(--dim);
		display: grid;
		padding: 14px 0;
		border-top: 1px solid var(--line-soft);
	}
	.sev-must-fix {
		--sev: var(--mf);
	}
	.sev-tradeoff {
		--sev: var(--tr);
	}
	.head {
		display: grid;
		gap: 5px;
		padding: 0;
		text-align: left;
		color: inherit;
		background: none;
		border: 0;
		cursor: pointer;
	}
	.claim {
		font-size: 14.5px;
		line-height: 1.5;
		color: var(--text);
	}
	.claim :global(code) {
		font: 12.5px var(--mono);
	}
	.head:hover .claim {
		color: #fff;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		font: 12px var(--mono);
		color: var(--dim);
	}
	.sev {
		font-family: var(--sans);
		font-weight: 550;
		color: var(--sev);
	}
	.flag {
		font-family: var(--sans);
		color: var(--sev);
	}
	.body {
		display: grid;
		gap: 12px;
		padding-top: 12px;
	}
	.evidence {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--muted);
		white-space: pre-wrap;
	}
	.by {
		margin: 0;
		font-size: 12px;
		color: var(--dim);
	}
</style>
