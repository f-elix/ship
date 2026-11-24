<script lang="ts">
	/** Text with `inline code` spans. */
	let { text }: { text: string } = $props();

	const parts = $derived(text.split('`').map((t, i) => ({ t, code: i % 2 === 1 })));
</script>

{#each parts as p, i (i)}{#if p.code}<code>{p.t}</code>{:else}{p.t}{/if}{/each}

<style>
	code {
		font: 0.88em var(--mono);
		padding: 1px 5px;
		border-radius: 4px;
		background: var(--raised);
		color: var(--text);
	}
</style>
