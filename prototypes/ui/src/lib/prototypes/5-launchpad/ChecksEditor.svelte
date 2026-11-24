<script lang="ts">
	import { fly, slide } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import type { CheckConfig } from '#lib';

	let {
		checks = $bindable(),
		locks,
		issuePaths = new Set<string>()
	}: { checks: CheckConfig[]; locks: string[]; issuePaths?: Set<string> } = $props();

	// Stable keys for the rows, since names can be edited or duplicated.
	let keys = $state(checks.map((_, i) => i));
	let next = $state(1000);

	function add() {
		checks.push({ name: '', run: '', lock: 'cpu' });
		keys.push(next++);
	}
	function remove(i: number) {
		checks.splice(i, 1);
		keys.splice(i, 1);
	}
	const rows = $derived(checks.map((c, i) => ({ c, i, key: keys[i] ?? -i - 1 })));
	const bad = (i: number, field: string) => issuePaths.has(`checks[${i}].${field}`);
</script>

<div class="table">
	<div class="head">
		<span>name</span><span>run</span><span>fix <em>optional</em></span><span>lock</span><span></span>
	</div>
	{#each rows as row (row.key)}
		<div class="row" animate:flip={{ duration: 220 }} in:fly={{ y: -8, duration: 260 }} out:slide={{ duration: 180 }}>
			<input class={['name', { bad: bad(row.i, 'name') }]} bind:value={checks[row.i].name} placeholder="test" aria-label="Check name" />
			<input class={['mono', { bad: bad(row.i, 'run') }]} bind:value={checks[row.i].run} placeholder="pnpm run test" aria-label="Run command" />
			<input
				class="mono"
				value={checks[row.i].fix ?? ''}
				oninput={(e) => {
					const v = e.currentTarget.value;
					if (v) checks[row.i].fix = v;
					else delete checks[row.i].fix;
				}}
				placeholder="—"
				aria-label="Fix command"
			/>
			<select class={['lock', checks[row.i].lock, { bad: bad(row.i, 'lock') }]} bind:value={checks[row.i].lock} aria-label="Lock resource">
				{#each locks as l (l)}<option value={l}>{l}</option>{/each}
				{#if !locks.includes(checks[row.i].lock)}<option value={checks[row.i].lock}>{checks[row.i].lock}</option>{/if}
			</select>
			<button type="button" class="rm" aria-label="Remove {checks[row.i].name || 'check'}" onclick={() => remove(row.i)}>
				<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17" /></svg>
			</button>
		</div>
	{/each}
	<button type="button" class="add" onclick={add}>
		<span>+</span> Add a check
	</button>
</div>

<style>
	.table {
		display: grid;
		gap: 6px;
	}
	.head,
	.row {
		display: grid;
		grid-template-columns: 130px 1.3fr 1fr 86px 34px;
		gap: 8px;
		align-items: center;
	}
	.head {
		font: 700 11px var(--sans);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		padding: 0 4px 2px;
	}
	.head em {
		font-style: normal;
		text-transform: none;
		letter-spacing: 0;
		font-weight: 500;
		opacity: 0.8;
	}
	input,
	select {
		font: 14px var(--sans);
		color: var(--ink);
		background: var(--bg);
		border: 1.5px solid transparent;
		border-radius: 12px;
		padding: 9px 11px;
		width: 100%;
		min-width: 0;
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	input:focus,
	select:focus {
		outline: 0;
		border-color: var(--accent);
		background: var(--card);
	}
	.name {
		font-weight: 650;
	}
	.mono {
		font: 13px var(--mono);
	}
	.bad {
		border-color: var(--red);
		background: var(--red-soft);
	}
	select.lock {
		font: 600 13px var(--mono);
		cursor: pointer;
	}
	select.db {
		color: var(--plum);
		background: var(--plum-soft);
	}
	.rm {
		width: 34px;
		height: 34px;
		border-radius: 10px;
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
		display: grid;
		place-items: center;
	}
	.rm:hover {
		background: var(--red-soft);
		color: var(--red);
	}
	.rm svg {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
	}
	.add {
		justify-self: start;
		margin-top: 4px;
		font: 600 14px var(--sans);
		color: var(--accent-ink);
		background: none;
		border: 1.5px dashed color-mix(in srgb, var(--accent) 45%, transparent);
		border-radius: 12px;
		padding: 8px 14px;
		cursor: pointer;
		transition: background 0.15s;
	}
	.add:hover {
		background: var(--accent-soft);
	}
	.add span {
		font-size: 16px;
		margin-right: 2px;
	}
</style>
