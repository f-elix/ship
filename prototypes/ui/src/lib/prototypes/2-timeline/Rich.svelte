<script lang="ts">
	/** Renders `backticked` spans of a finding's text as inline code. */
	let { text }: { text: string } = $props();

	let parts = $derived(text.split('`'));
</script>

{#each parts as part, i (i)}{#if i % 2}<code>{part}</code>{:else}{part}{/if}{/each}
