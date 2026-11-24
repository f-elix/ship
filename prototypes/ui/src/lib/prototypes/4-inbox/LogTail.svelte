<script lang="ts">
	import { clock, describe } from '#lib';
	import type { RunEvent } from '#lib';

	let { events, count = 10, live = false }: { events: RunEvent[]; count?: number; live?: boolean } = $props();

	const tail = $derived(events.slice(-count));

	const toneOf = (e: RunEvent) => {
		switch (e._tag) {
			case 'StepEnded':
				return e.outcome === 'ok' ? 'ok' : 'bad';
			case 'CheckFinished':
				return e.exitCode === 0 ? 'ok' : 'bad';
			case 'RunInterrupted':
			case 'Escalated':
			case 'RunCancelled':
				return 'bad';
			case 'ClefDecision':
				return 'clef';
			case 'StateChanged':
				return 'state';
			default:
				return '';
		}
	};
</script>

<ol class="log" aria-label="Last {count} log lines">
	{#each tail as e (e.seq)}
		<li class={toneOf(e)}>
			<time>{clock(e.at)}</time>
			<span class="seq">#{e.seq}</span>
			<span class="msg">{describe(e)}</span>
		</li>
	{/each}
	{#if live}
		<li class="cursor"><time></time><span class="seq"></span><span class="msg"><i></i> streaming</span></li>
	{/if}
</ol>

<style>
	.log {
		list-style: none;
		margin: 0;
		padding: 10px 0;
		background: var(--code-bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		font: 12px/1.75 var(--mono);
	}
	li {
		display: grid;
		grid-template-columns: 72px 40px 1fr;
		padding: 0 14px;
		color: var(--ink-2);
	}
	time,
	.seq {
		color: var(--faint);
	}
	.msg {
		white-space: pre-wrap;
		word-break: break-word;
	}
	.ok .msg {
		color: #23744a;
	}
	.bad {
		background: var(--mf-wash);
	}
	.bad .msg {
		color: var(--mf);
		font-weight: 600;
	}
	.clef .msg {
		color: var(--clef);
	}
	.state .msg {
		color: var(--ink);
		font-weight: 500;
	}
	.cursor .msg {
		color: var(--faint);
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.cursor i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--live);
		animation: pulse 1.2s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.25;
		}
	}
</style>
