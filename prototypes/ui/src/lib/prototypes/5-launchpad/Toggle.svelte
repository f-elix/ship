<script lang="ts">
	let {
		checked = $bindable(false),
		label,
		hint,
		disabled = false
	}: { checked?: boolean; label?: string; hint?: string; disabled?: boolean } = $props();
</script>

<label class={['toggle', { disabled }]}>
	<input type="checkbox" bind:checked {disabled} />
	<span class="track"><span class="thumb"></span></span>
	{#if label}
		<span class="text">
			<span class="label">{label}</span>
			{#if hint}<span class="hint">{hint}</span>{/if}
		</span>
	{/if}
</label>

<style>
	.toggle {
		display: inline-flex;
		align-items: flex-start;
		gap: 12px;
		cursor: pointer;
		user-select: none;
	}
	.disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.track {
		flex: none;
		width: 40px;
		height: 24px;
		border-radius: 999px;
		background: var(--line-2);
		position: relative;
		transition: background 0.2s;
		margin-top: 1px;
	}
	.thumb {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 1px 3px rgba(60, 30, 10, 0.25);
		transition: transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	input:checked + .track {
		background: var(--accent);
	}
	input:checked + .track .thumb {
		transform: translateX(16px);
	}
	input:focus-visible + .track {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.toggle:active .thumb {
		width: 22px;
	}
	.text {
		display: grid;
		gap: 1px;
	}
	.label {
		font-weight: 600;
		font-size: 14.5px;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
		line-height: 1.4;
	}
</style>
