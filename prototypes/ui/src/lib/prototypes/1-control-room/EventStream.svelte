<script lang="ts">
	import { untrack } from 'svelte';
	import { clock, describe, type Run } from '#lib';
	import { GROUPS, groupOf, isActive, toneOf, type Group } from './model.ts';

	let { run, follow = $bindable() }: { run: Run; follow: boolean } = $props();

	// The stream is re-created per run (keyed in the parent), so this is the count at selection time.
	const seenAtMount = untrack(() => run.events.length);

	let enabled = $state<Record<Group, boolean>>({
		state: true,
		checks: true,
		locks: true,
		review: true,
		cost: true,
		git: true
	});

	const counts = $derived.by(() => {
		const c = { state: 0, checks: 0, locks: 0, review: 0, cost: 0, git: 0 } as Record<Group, number>;
		for (const e of run.events) c[groupOf(e._tag)]++;
		return c;
	});
	const visible = $derived(run.events.filter((e) => enabled[groupOf(e._tag)]));

	let scroller = $state<HTMLDivElement>();
	let unseen = $state(0);
	let lastLength = untrack(() => run.events.length);

	$effect(() => {
		const n = visible.length;
		const added = run.events.length - lastLength;
		lastLength = run.events.length;
		if (!scroller) return;
		if (follow) {
			unseen = 0;
			scroller.scrollTo({ top: scroller.scrollHeight, behavior: n && added ? 'smooth' : 'instant' });
		} else if (added > 0) {
			untrack(() => (unseen += added));
		}
	});

	const solo = (g: Group) => {
		const only = GROUPS.every((k) => enabled[k] === (k === g));
		for (const k of GROUPS) enabled[k] = only ? true : k === g;
	};
</script>

<section class="stream">
	<div class="bar">
		<span class="label">events</span>
		<span class="count">{run.events.length}</span>
		<div class="chips" role="group" aria-label="Filter event groups">
			{#each GROUPS as g (g)}
				<button
					class={['chip', `g-${g}`, enabled[g] && 'on']}
					aria-pressed={enabled[g]}
					title="click to toggle, double-click to solo"
					onclick={() => (enabled[g] = !enabled[g])}
					ondblclick={() => solo(g)}
				>
					<i></i>{g}<span>{counts[g]}</span>
				</button>
			{/each}
		</div>
		<button
			class={['follow', follow && 'on']}
			aria-pressed={follow}
			onclick={() => (follow = !follow)}
			title="toggle follow (f)"
		>
			{#if follow}
				<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" /></svg>
				following
			{:else}
				<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5v7M8 2.5v7" /></svg>
				paused
			{/if}
			<kbd>f</kbd>
		</button>
	</div>

	<div
		class="log"
		bind:this={scroller}
		onwheel={(e) => {
			if (e.deltaY < 0 && follow) follow = false;
		}}
		role="log"
		aria-live="polite"
	>
		<table>
			<tbody>
				{#each visible as e (e.seq)}
					{@const g = groupOf(e._tag)}
					{@const tone = toneOf(e)}
					<tr class={[`g-${g}`, tone && `t-${tone}`, e.seq > seenAtMount && 'fresh']}>
						<td class="seq">{e.seq}</td>
						<td class="at">{clock(e.at)}</td>
						<td class="tag"><span>{e._tag}</span></td>
						<td class="msg">
							{describe(e)}
							{#if e._tag === 'ClefDecision'}
								<span class="p" style:--p={e.probability}>p={e.probability.toFixed(2)}</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if isActive(run.status)}
			<div class="cursor"><span></span> tailing <code>ship logs {run.runId} --follow</code></div>
		{:else}
			<div class="cursor end">— end of log · {run.status} —</div>
		{/if}
	</div>

	{#if !follow && unseen > 0}
		<button
			class="unseen"
			onclick={() => {
				follow = true;
			}}
		>
			{unseen} new event{unseen === 1 ? '' : 's'} ↓
		</button>
	{/if}
</section>

<style>
	.stream {
		position: relative;
		display: grid;
		grid-template-rows: auto 1fr;
		min-height: 0;
		border-top: 1px solid var(--line);
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 14px;
		background: var(--panel);
		border-bottom: 1px solid var(--line);
	}
	.label {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-weight: 600;
	}
	.count {
		font-family: var(--mono);
		font-size: 10px;
		color: var(--dim);
	}
	.chips {
		display: flex;
		gap: 4px;
		flex: 1;
		margin-left: 6px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 7px;
		border-radius: 3px;
		border: 1px solid var(--line);
		background: none;
		color: var(--faint);
		font-family: var(--mono);
		font-size: 10.5px;
		cursor: pointer;
	}
	.chip i {
		width: 6px;
		height: 6px;
		border-radius: 1px;
		background: var(--gc);
		opacity: 0.35;
	}
	.chip span {
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}
	.chip.on {
		color: var(--text);
		border-color: var(--line-strong);
		background: var(--bg);
	}
	.chip.on i {
		opacity: 1;
	}
	.g-state {
		--gc: var(--c-state);
	}
	.g-checks {
		--gc: var(--c-checks);
	}
	.g-locks {
		--gc: var(--c-locks);
	}
	.g-review {
		--gc: var(--c-review);
	}
	.g-cost {
		--gc: var(--c-cost);
	}
	.g-git {
		--gc: var(--c-git);
	}
	.follow {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 2px 6px 2px 8px;
		border: 1px solid var(--line-strong);
		border-radius: 3px;
		background: none;
		color: var(--s-waiting);
		font-family: var(--mono);
		font-size: 10.5px;
		cursor: pointer;
	}
	.follow.on {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
	}
	.follow svg {
		width: 10px;
		height: 10px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
	}
	.log {
		overflow-y: auto;
		min-height: 0;
		padding: 6px 0 10px;
		background: var(--bg);
		font-family: var(--mono);
		font-size: 11.5px;
		line-height: 19px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	tr:hover {
		background: var(--hover);
	}
	td {
		padding: 0 8px;
		vertical-align: top;
		white-space: nowrap;
	}
	.seq {
		width: 1%;
		padding-left: 14px;
		text-align: right;
		color: var(--faint);
		font-size: 10px;
	}
	.at {
		width: 1%;
		color: var(--dim);
		font-variant-numeric: tabular-nums;
	}
	.tag {
		width: 1%;
		color: var(--gc);
	}
	.tag span {
		display: inline-block;
		min-width: 132px;
	}
	.msg {
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text);
		width: 100%;
	}
	tr.g-locks .msg,
	tr.g-cost .msg {
		color: var(--dim);
	}
	tr.g-state .msg {
		color: var(--bright);
	}
	tr.t-ok .msg {
		color: var(--s-done);
	}
	tr.t-bad .msg {
		color: var(--s-failed);
	}
	tr.t-bad {
		background: color-mix(in srgb, var(--s-failed) 7%, transparent);
	}
	tr.t-warn .msg {
		color: var(--s-waiting);
	}
	tr.t-clef .msg {
		color: var(--c-clef);
	}
	.p {
		position: relative;
		margin-left: 6px;
		padding: 0 5px;
		font-size: 10px;
		color: var(--c-clef);
		border: 1px solid color-mix(in srgb, var(--c-clef) 40%, transparent);
		border-radius: 2px;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--c-clef) 22%, transparent) calc(var(--p) * 100%),
			transparent 0
		);
	}
	tr.fresh {
		animation: arrive 1.4s ease-out;
	}
	tr.fresh td {
		animation: slide 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@keyframes arrive {
		from {
			background: color-mix(in srgb, var(--accent) 22%, transparent);
		}
	}
	@keyframes slide {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	.cursor {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 14px 0 46px;
		color: var(--faint);
		font-size: 10.5px;
	}
	.cursor span {
		width: 7px;
		height: 13px;
		background: var(--accent);
		animation: caret 1s steps(1) infinite;
	}
	.cursor code {
		color: var(--dim);
	}
	.cursor.end {
		padding-left: 46px;
	}
	@keyframes caret {
		50% {
			opacity: 0;
		}
	}
	.unseen {
		position: absolute;
		bottom: 14px;
		left: 50%;
		transform: translateX(-50%);
		padding: 4px 12px;
		border-radius: 99px;
		border: 1px solid var(--accent);
		background: var(--panel);
		color: var(--accent);
		font-family: var(--mono);
		font-size: 11px;
		cursor: pointer;
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.5);
	}
	kbd {
		font-family: var(--mono);
		font-size: 9.5px;
		padding: 0 4px;
		border: 1px solid var(--line-strong);
		border-radius: 2px;
		color: var(--dim);
	}
</style>
