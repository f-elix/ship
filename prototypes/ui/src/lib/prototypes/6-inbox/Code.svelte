<script lang="ts">
	import type { Excerpt } from './data.ts';
	import { tokenize } from './highlight.ts';

	let { excerpt, line }: { excerpt: Excerpt; line?: number } = $props();

	const rows = $derived(excerpt.lines.map((text, i) => ({ n: excerpt.start + i, tokens: tokenize(text) })));
</script>

<pre class="code"><code
		>{#each rows as row (row.n)}<span class={['row', row.n === line && 'hit']}
				><span class="n">{row.n}</span><span class="src"
					>{#each row.tokens as t, i (i)}<span class={t.kind}>{t.text}</span>{/each}{' '}</span
				></span
			>{/each}</code
	></pre>

<style>
	.code {
		margin: 0;
		padding: 8px 0;
		background: var(--code);
		border-radius: 6px;
		font: 12px/1.65 var(--mono);
		overflow-x: auto;
	}
	.row {
		display: flex;
		padding-right: 16px;
	}
	.row.hit {
		background: color-mix(in srgb, var(--sev) 14%, transparent);
		box-shadow: inset 2px 0 var(--sev);
	}
	.n {
		width: 44px;
		flex: none;
		padding-right: 14px;
		text-align: right;
		color: var(--dim);
		user-select: none;
	}
	.hit .n {
		color: var(--sev);
	}
	.src {
		white-space: pre;
		color: #c9d1d9;
	}
	.kw {
		color: #c792ea;
	}
	.str {
		color: #a5d6a7;
	}
	.com {
		color: #5f6873;
		font-style: italic;
	}
	.num {
		color: #f7c47a;
	}
	.fn {
		color: #82aaff;
	}
</style>
