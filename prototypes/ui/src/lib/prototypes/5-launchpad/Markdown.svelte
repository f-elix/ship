<script lang="ts">
	let { source }: { source: string } = $props();

	type Block = { kind: 'h1' | 'h2' | 'p'; text: string; id: number } | { kind: 'ul' | 'ol'; items: string[]; id: number };

	/** Just enough Markdown for spec.md and implementation-plan.md previews. */
	const blocks = $derived.by(() => {
		const out: Block[] = [];
		let id = 0;
		for (const chunk of source.split(/\n{2,}/)) {
			const lines = chunk.split('\n');
			if (lines.every((l) => /^[-*] /.test(l))) out.push({ kind: 'ul', items: lines.map((l) => l.slice(2)), id: id++ });
			else if (lines.every((l) => /^\d+\. /.test(l)))
				out.push({ kind: 'ol', items: lines.map((l) => l.replace(/^\d+\. /, '')), id: id++ });
			else if (chunk.startsWith('## ')) out.push({ kind: 'h2', text: chunk.slice(3), id: id++ });
			else if (chunk.startsWith('# ')) out.push({ kind: 'h1', text: chunk.slice(2), id: id++ });
			else out.push({ kind: 'p', text: chunk, id: id++ });
		}
		return out;
	});

	const parts = (text: string) => text.split(/(`[^`]+`)/).map((t, i) => ({ code: t.startsWith('`') && t.endsWith('`') && t.length > 1, text: t.replace(/^`|`$/g, ''), i }));
</script>

{#snippet inline(text: string)}
	{#each parts(text) as part (part.i)}
		{#if part.code}<code>{part.text}</code>{:else}{part.text}{/if}
	{/each}
{/snippet}

<div class="md">
	{#each blocks as b (b.id)}
		{#if b.kind === 'h1'}
			<h4>{@render inline(b.text)}</h4>
		{:else if b.kind === 'h2'}
			<h5>{@render inline(b.text)}</h5>
		{:else if b.kind === 'p'}
			<p>{@render inline(b.text)}</p>
		{:else if b.kind === 'ul'}
			<ul>
				{#each b.items as item, i (i)}<li>{@render inline(item)}</li>{/each}
			</ul>
		{:else if b.kind === 'ol'}
			<ol>
				{#each b.items as item, i (i)}<li>{@render inline(item)}</li>{/each}
			</ol>
		{/if}
	{/each}
</div>

<style>
	.md {
		font-size: 14.5px;
		line-height: 1.6;
		color: var(--ink-2);
	}
	h4 {
		font: 700 17px/1.3 var(--display);
		color: var(--ink);
		margin: 0 0 8px;
	}
	h5 {
		font: 700 12px var(--sans);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		margin: 14px 0 4px;
	}
	p {
		margin: 0 0 8px;
	}
	ul,
	ol {
		margin: 0 0 8px;
		padding-left: 20px;
	}
	li {
		margin: 2px 0;
	}
	li::marker {
		color: var(--accent);
	}
	code {
		font: 0.88em var(--mono);
		background: var(--bg-2);
		padding: 1px 5px;
		border-radius: 5px;
		color: var(--ink);
	}
</style>
