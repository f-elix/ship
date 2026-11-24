<script lang="ts">
	import { highlight } from './config.ts';

	let { value, path }: { value: unknown; path: string } = $props();

	let copied = $state(false);
	const html = $derived(highlight(value));

	async function copy() {
		try {
			await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
		} catch {
			// Clipboard can be unavailable; the feedback still matters for the prototype.
		}
		copied = true;
		setTimeout(() => (copied = false), 1400);
	}
</script>

<div class="json">
	<header>
		<span class="dots"><i></i><i></i><i></i></span>
		<span class="path">{path}</span>
		<button type="button" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
	</header>
	<pre>{@html html}</pre>
</div>

<style>
	.json {
		background: var(--code-bg);
		color: var(--code-ink);
		border-radius: 18px;
		overflow: hidden;
		box-shadow: var(--shadow);
	}
	header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		border-bottom: 1px solid rgba(255, 240, 220, 0.08);
	}
	.dots {
		display: flex;
		gap: 6px;
	}
	.dots i {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: rgba(255, 235, 210, 0.18);
	}
	.dots i:first-child {
		background: var(--accent);
	}
	.path {
		font: 12.5px var(--mono);
		opacity: 0.7;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	button {
		font: 600 12px var(--sans);
		color: var(--code-ink);
		background: rgba(255, 235, 210, 0.1);
		border: 0;
		border-radius: 8px;
		padding: 5px 10px;
		cursor: pointer;
	}
	button:hover {
		background: rgba(255, 235, 210, 0.18);
	}
	pre {
		margin: 0;
		padding: 16px 18px 20px;
		font: 12.5px/1.65 var(--mono);
		overflow: auto;
		max-height: 560px;
	}
	pre :global {
		.k {
			color: #f7b58a;
		}
		.s {
			color: #b9e3c6;
		}
		.b {
			color: #f0a6c9;
		}
		.n {
			color: #ffd98a;
		}
	}
</style>
