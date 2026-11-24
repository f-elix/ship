<script lang="ts">
	import type { Excerpt } from './data.ts';
	import { tokenize } from './highlight.ts';

	let { file, line, excerpt, tone = 'must-fix' }: { file: string; line?: number; excerpt?: Excerpt; tone?: string } = $props();

	const rows = $derived.by(() => {
		const ex = excerpt;
		return ex ? ex.lines.map((text, i) => ({ n: ex.start + i, tokens: tokenize(text) })) : [];
	});
</script>

<figure class={['code', `tone-${tone}`]}>
	<figcaption>
		<span class="path">{file}{#if line}<b>:{line}</b>{/if}</span>
		{#if !line && excerpt?.focus}<span class="hint">no line cited · matched evidence</span>{/if}
	</figcaption>
	{#if rows.length}
		<pre><code
				>{#each rows as row (row.n)}<span
						class={['row', row.n === line && 'hit', !line && row.n === excerpt?.focus && 'near']}
						><span class="n">{row.n}</span><span class="src"
							>{#each row.tokens as t, i (i)}<span class={t.kind}>{t.text}</span>{/each}{' '}</span
						></span
					>{/each}</code
			></pre>
	{:else}
		<p class="empty">Excerpt not available for this file.</p>
	{/if}
</figure>

<style>
	.code {
		margin: 0;
		border: 1px solid var(--line);
		border-radius: 8px;
		overflow: hidden;
		background: var(--code-bg);
		--hit: var(--mf);
		--hit-bg: var(--mf-wash);
	}
	.tone-tradeoff {
		--hit: var(--tr);
		--hit-bg: var(--tr-wash);
	}
	.tone-nit {
		--hit: var(--nit);
		--hit-bg: var(--nit-wash);
	}
	figcaption {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 6px 12px;
		font: 11.5px/1.4 var(--mono);
		color: var(--muted);
		border-bottom: 1px solid var(--line);
		background: var(--panel);
	}
	figcaption b {
		color: var(--ink);
		font-weight: 600;
	}
	.hint {
		font-family: var(--sans);
		font-style: italic;
	}
	pre {
		margin: 0;
		padding: 6px 0;
		font: 12px/1.65 var(--mono);
		tab-size: 2;
		overflow-x: auto;
	}
	.row {
		display: flex;
		border-left: 3px solid transparent;
	}
	.row.hit {
		background: var(--hit-bg);
		border-left-color: var(--hit);
	}
	.row.near {
		background: repeating-linear-gradient(-45deg, transparent 0 6px, var(--hit-bg) 6px 12px);
		border-left: 3px dashed var(--hit);
	}
	.n {
		width: 44px;
		flex: none;
		padding-right: 12px;
		text-align: right;
		color: var(--faint);
		user-select: none;
	}
	.hit .n {
		color: var(--hit);
		font-weight: 600;
	}
	.src {
		white-space: pre;
		padding-right: 16px;
		color: var(--ink);
	}
	.kw {
		color: #8a3ab9;
	}
	.str {
		color: #2f7d4f;
	}
	.com {
		color: var(--faint);
		font-style: italic;
	}
	.num {
		color: #b0571a;
	}
	.fn {
		color: #2a5db0;
	}
	.empty {
		margin: 0;
		padding: 14px;
		color: var(--muted);
		font-size: 12px;
	}
</style>
