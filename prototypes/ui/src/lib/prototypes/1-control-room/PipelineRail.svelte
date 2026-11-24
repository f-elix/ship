<script lang="ts">
	import { duration, type Run, type RunEvent } from '#lib';
	import { isActive, stagesFor, topState } from './model.ts';

	let { run, cap }: { run: Run; cap: number } = $props();

	const stages = $derived(stagesFor(run.kind));

	/** The stage an event moves the run into, if any. */
	const stageOf = (e: RunEvent): string | null => {
		switch (e._tag) {
			case 'StateChanged':
				return topState(e.to);
			case 'StepStarted':
				return e.step;
			case 'BranchPushed':
				return run.kind === 'ship' ? null : 'push';
			case 'CommitCreated':
				return run.kind === 'checks' ? 'commit' : null;
			case 'PrReviewPosted':
				return 'post';
			case 'PrOpened':
				return 'pr';
			default:
				return null;
		}
	};

	const trail = $derived.by(() => {
		const visits: Record<string, number> = {};
		let last: string | null = null;
		for (const e of run.events) {
			const s = stageOf(e);
			if (!s || !stages.includes(s)) continue;
			if (s !== last) visits[s] = (visits[s] ?? 0) + 1;
			last = s;
		}
		return { visits, last };
	});

	const active = $derived(isActive(run.status));
	const current = $derived(
		active && stages.includes(topState(run.state)) ? topState(run.state) : trail.last
	);
	const currentIndex = $derived(current ? stages.indexOf(current) : -1);
	const finished = $derived(run.status === 'done');
	const waiting = $derived(run.state.endsWith('.waiting'));
	const waitingOn = $derived.by(() => {
		const w = run.events.findLast((e) => e._tag === 'LockWaiting');
		return w?._tag === 'LockWaiting' ? `${w.resource}${w.position ? ` #${w.position}` : ''}` : null;
	});

	const reviewRounds = $derived(run.events.filter((e) => e._tag === 'ReviewStarted').length);
	const loop = $derived(
		run.kind === 'ship' && (trail.visits.fix ?? 0) > 0
			? { from: stages.indexOf('checks'), to: stages.indexOf('fix') }
			: null
	);

	const sub = (stage: string): string => {
		const ev = run.events;
		switch (stage) {
			case 'baseline': {
				const res = ev.filter((e) => e._tag === 'CheckFinished' && e.baseline);
				const ok = res.filter((e) => e._tag === 'CheckFinished' && e.exitCode === 0).length;
				return res.length ? `${ok}/${res.length} pass` : '';
			}
			case 'implement':
			case 'fix':
			case 'recheck':
			case 'check-fix': {
				const ended = ev.findLast((e) => e._tag === 'StepEnded' && e.step === stage);
				if (ended?._tag === 'StepEnded')
					return ended.outcome === 'ok' ? duration(ended.durationMs) : ended.outcome;
				return trail.visits[stage] ? 'working' : '';
			}
			case 'checks': {
				const n = trail.visits.checks ?? 0;
				return n ? `${n} pass${n === 1 ? '' : 'es'}` : '';
			}
			case 'review':
				return reviewRounds ? `round ${reviewRounds}/${cap}` : '';
			case 'triage': {
				const t = ev.findLast((e) => e._tag === 'FindingsTriaged');
				return t?._tag === 'FindingsTriaged'
					? `${t.mustFix.length}·${t.tradeoffs.length}·${t.nits.length}`
					: '';
			}
			case 'pr':
				return run.prNumber ? `#${run.prNumber}` : '';
			case 'push': {
				const p = ev.findLast((e) => e._tag === 'BranchPushed');
				return p?._tag === 'BranchPushed' ? p.sha.slice(0, 7) : '';
			}
			default:
				return '';
		}
	};

	const stateOf = (i: number) => {
		if (finished) return trail.visits[stages[i]] ? 'past' : 'skip';
		if (i === currentIndex) return active ? 'now' : `halt ${run.status}`;
		if (trail.visits[stages[i]]) return 'past';
		return i < currentIndex ? 'skip' : 'todo';
	};
</script>

<div class="rail" style:--n={stages.length}>
	{#if loop}
		<div
			class="loop"
			style:left="calc({(loop.from + 0.5) / stages.length} * 100%)"
			style:right="calc({1 - (loop.to + 0.5) / stages.length} * 100%)"
		>
			<span>review loop · round {Math.max(reviewRounds, run.round)}/{cap}</span>
		</div>
	{/if}

	<div class="track">
		<div
			class="fill"
			style:width="{(Math.max(finished ? stages.length - 1 : currentIndex, 0) /
				Math.max(stages.length - 1, 1)) *
				100}%"
		></div>
	</div>

	<ol>
		{#each stages as stage, i (stage)}
			{@const st = stateOf(i)}
			<li class={st}>
				<span class="node">
					{#if st === 'past'}
						<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6 9.5 3.6" /></svg>
					{:else}
						{i + 1}
					{/if}
				</span>
				<span class="name">{stage}</span>
				<span class="sub">
					{sub(stage)}{#if trail.visits[stage] > 1 && stage !== 'review' && stage !== 'checks'}
						· ×{trail.visits[stage]}{/if}
				</span>
				{#if stage === 'checks' && waiting && i === currentIndex}
					<span class="substate">waiting{waitingOn ? ` · ${waitingOn}` : ''}</span>
				{/if}
				{#if run.status === 'escalated' && stage === 'triage'}
					<span class="substate esc">escalate · {run.escalationReason}</span>
				{/if}
			</li>
		{/each}
	</ol>
</div>

<style>
	.rail {
		position: relative;
		padding: 34px 0 6px;
		--node: 22px;
	}
	.loop {
		position: absolute;
		top: 8px;
		height: 22px;
		border: 1px dashed color-mix(in srgb, var(--accent) 55%, transparent);
		border-bottom: 0;
		border-radius: 10px 10px 0 0;
	}
	.loop::after {
		content: '';
		position: absolute;
		left: -4px;
		bottom: -2px;
		border: 4px solid transparent;
		border-top: 5px solid var(--accent);
		border-bottom: 0;
	}
	.loop span {
		position: absolute;
		top: -8px;
		left: 50%;
		transform: translateX(-50%);
		padding: 0 8px;
		background: var(--bg);
		font-family: var(--mono);
		font-size: 10px;
		color: var(--accent);
		white-space: nowrap;
	}
	.track {
		position: absolute;
		top: calc(34px + var(--node) / 2);
		left: calc(50% / var(--n));
		right: calc(50% / var(--n));
		height: 1px;
		background: var(--line-strong);
	}
	.fill {
		height: 100%;
		background: var(--accent);
		box-shadow: 0 0 8px var(--accent);
		transition: width 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	ol {
		position: relative;
		display: grid;
		grid-template-columns: repeat(var(--n), 1fr);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		min-width: 0;
	}
	.node {
		display: grid;
		place-items: center;
		width: var(--node);
		height: var(--node);
		border-radius: 50%;
		border: 1px solid var(--line-strong);
		background: var(--bg);
		font-family: var(--mono);
		font-size: 10px;
		color: var(--faint);
	}
	.node svg {
		width: 11px;
		height: 11px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
	}
	.name {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--faint);
	}
	.sub {
		font-family: var(--mono);
		font-size: 10px;
		color: var(--faint);
		min-height: 13px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.past .node {
		border-color: color-mix(in srgb, var(--accent) 50%, transparent);
		color: var(--accent);
	}
	.past .name {
		color: var(--text);
	}
	.past .sub {
		color: var(--dim);
	}
	.skip {
		opacity: 0.4;
	}
	.now .node {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--bg);
		font-weight: 700;
		box-shadow:
			0 0 0 4px color-mix(in srgb, var(--accent) 18%, transparent),
			0 0 18px color-mix(in srgb, var(--accent) 50%, transparent);
		animation: glow 2s ease-in-out infinite;
	}
	.now .name {
		color: var(--bright);
		font-weight: 600;
	}
	.now .sub {
		color: var(--accent);
	}
	.halt .node {
		background: var(--bg);
		border-width: 2px;
		font-weight: 700;
	}
	.halt.escalated .node {
		border-color: var(--s-escalated);
		color: var(--s-escalated);
	}
	.halt.failed .node {
		border-color: var(--s-failed);
		color: var(--s-failed);
	}
	.halt.interrupted .node {
		border-color: var(--s-interrupted);
		color: var(--s-interrupted);
		border-style: dashed;
	}
	.halt.cancelled .node {
		border-color: var(--s-cancelled);
		color: var(--s-cancelled);
	}
	.halt .name {
		color: var(--bright);
	}
	.substate {
		margin-top: 2px;
		padding: 1px 6px;
		border-radius: 2px;
		font-family: var(--mono);
		font-size: 10px;
		color: var(--s-waiting);
		background: color-mix(in srgb, var(--s-waiting) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--s-waiting) 35%, transparent);
		white-space: nowrap;
	}
	.substate.esc {
		color: var(--s-escalated);
		background: color-mix(in srgb, var(--s-escalated) 12%, transparent);
		border-color: color-mix(in srgb, var(--s-escalated) 35%, transparent);
	}
	@keyframes glow {
		50% {
			box-shadow:
				0 0 0 6px color-mix(in srgb, var(--accent) 8%, transparent),
				0 0 24px color-mix(in srgb, var(--accent) 35%, transparent);
		}
	}
</style>
