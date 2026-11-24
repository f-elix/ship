<script lang="ts">
	let { decision, probability, detail }: { decision: string; probability: number; detail: string } = $props();
</script>

<aside class="clef">
	<span class="who">Clef</span>
	<span class="decision">{decision}</span>
	<span class="p" title="Clef's probability">
		<span class="bar" aria-hidden="true"><span style:width="{probability * 100}%"></span></span>
		p {probability.toFixed(2)}
	</span>
	<span class="detail">{detail}</span>
</aside>

<style>
	.clef {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
		margin: 10px 0;
		padding: 2px 0 2px 12px;
		border-left: 2px solid var(--blue-soft);
		font-size: 13px;
		color: var(--muted);
	}

	.who {
		font: italic 500 14px var(--serif);
		color: var(--blue);
	}

	.decision {
		color: var(--ink-2);
		font-weight: 500;
	}

	.p {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: 12px var(--mono);
		font-variant-numeric: tabular-nums;
	}

	.bar {
		display: inline-block;
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: var(--rule);
		overflow: hidden;
	}

	.bar span {
		display: block;
		height: 100%;
		background: var(--blue);
		opacity: 0.7;
	}

	.detail {
		flex-basis: 100%;
		font-family: var(--mono);
		font-size: 12px;
	}
</style>
