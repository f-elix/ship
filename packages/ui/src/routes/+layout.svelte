<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<title>ship · inbox</title>
</svelte:head>

{@render children()}

<style>
	:global(*, *::before, *::after) {
		box-sizing: border-box;
	}
	/* !important: the components' own, scoped animations would win over this reset. */
	@media (prefers-reduced-motion: reduce) {
		:global(*, *::before, *::after) {
			animation: none !important;
			transition: none !important;
		}
	}
	:global(body) {
		margin: 0;
		background: #0c0e11;
	}
</style>
