<script lang="ts">
	import type { Finding } from '#lib';
	import Code from './Code.svelte';
	import Rich from './Rich.svelte';
	import { excerpts, type Deliverable } from './data.ts';
	import type { Decision, Inbox } from './state.svelte.ts';

	/** One open finding as a row: claim and location up front; evidence and code on demand. */
	let { inbox, d, f, mode }: { inbox: Inbox; d: Deliverable; f: Finding; mode: 'fix' | 'post' | 'preview' | 'readonly' } = $props();

	const excerpt = $derived(excerpts[`${d.id}:${f.id}`]);
	const decision = $derived(inbox.decision(d, f));
	let open = $state(false);

	const options = $derived.by((): { value: Decision; label: string }[] => {
		if (mode === 'post') return [{ value: 'fix', label: 'Post' }, { value: 'dismiss', label: 'Drop' }];
		if (f.severity === 'must-fix')
			return [{ value: 'fix', label: 'Fix' }, { value: 'accept', label: 'Accept' }, { value: 'dismiss', label: 'Dismiss' }];
		if (f.severity === 'tradeoff') return [{ value: 'accept', label: 'Accept' }, { value: 'fix', label: 'Fix' }];
		return [{ value: 'fix', label: 'Fix' }, { value: 'dismiss', label: 'Skip' }];
	});

	const proof = $derived(f.verdict.match(/^(traced|structural|code reading)/)?.[1]);
</script>

<li class={['finding', `sev-${f.severity}`, decision === 'dismiss' && 'dismissed', open && 'open']}>
	<button class="head" onclick={() => (open = !open)} aria-expanded={open}>
		<span class="claim"><Rich text={f.claim} /></span>
		<span class="meta">
			<span class="sev">{f.severity}</span>
			<span>{f.file}{f.line ? `:${f.line}` : ''}</span>
			{#if f.repeats}<span class="flag">came back after ship’s fix</span>{/if}
		</span>
	</button>

	{#if mode === 'fix' || mode === 'post'}
		<select
			class="decide"
			value={decision}
			onchange={(e) => inbox.decide(d, f, e.currentTarget.value as Decision)}
			aria-label="Decision"
		>
			{#each options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
	{/if}

	{#if open}
		<div class="body">
			<p class="evidence"><Rich text={f.evidence} /></p>
			{#if excerpt}<Code {excerpt} line={f.line} />{/if}
			<p class="by">{f.reviewer.replace('github:', '@')}{#if proof} · verified by {proof}{/if}</p>
		</div>
	{/if}
</li>

<style>
	.finding {
		--sev: var(--dim);
		display: grid;
		grid-template-columns: 1fr auto;
		column-gap: 20px;
		padding: 14px 0;
		border-top: 1px solid var(--line-soft);
		transition: opacity 0.15s;
	}
	.sev-must-fix {
		--sev: var(--mf);
	}
	.sev-tradeoff {
		--sev: var(--tr);
	}
	.dismissed {
		opacity: 0.4;
	}
	.dismissed .claim {
		text-decoration: line-through;
		text-decoration-color: var(--dim);
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
	.decide {
		align-self: start;
		padding: 4px 26px 4px 10px;
		font: 500 12.5px var(--sans);
		color: var(--text);
		background: var(--panel)
			url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%235d6670' stroke-width='1.5'/%3E%3C/svg%3E")
			no-repeat right 9px center;
		border: 1px solid var(--line);
		border-radius: 7px;
		appearance: none;
		cursor: pointer;
	}
	.decide:hover {
		border-color: var(--line-strong);
	}
	.body {
		grid-column: 1 / -1;
		display: grid;
		gap: 12px;
		padding-top: 12px;
	}
	.evidence {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--muted);
	}
	.by {
		margin: 0;
		font-size: 12px;
		color: var(--dim);
	}
</style>
