<script lang="ts">
	import { fade } from 'svelte/transition';
	import { duration, locks, usd } from '#lib';
	import { checkAttempts, shortModel, type Phase } from './phases.ts';

	let { phase }: { phase: Phase } = $props();

	let attempts = $derived(checkAttempts(phase));
	let baseline = $derived(phase.kind === 'baseline');
</script>

{#if baseline}
	<p class="lede">Every check once, on the base commit, before any change. Fix commands are skipped.</p>
{/if}

{#each attempts as a (a.attempt)}
	<div class="attempt" in:fade={{ duration: 300 }}>
		{#if attempts.length > 1}
			<h4>Attempt {a.attempt + 1}</h4>
		{/if}
		<ul>
			{#each a.rows as row (row.name)}
				<li class={row.status} in:fade={{ duration: 300 }}>
					<span class="glyph" aria-label={row.status}>
						{#if row.status === 'passed'}
							<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M3 7.3 5.8 10 11 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
						{:else if row.status === 'failed'}
							<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="m4 4 6 6m0-6-6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
						{:else if row.status === 'waiting'}
							<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 2" /></svg>
						{:else}
							<span class="spin" aria-hidden="true"></span>
						{/if}
					</span>
					<code class="name">{row.name}</code>
					<span class="cmd">
						{#if row.fixCommand}<code class="fix" title="fix command ran first">{row.fixCommand} →</code>{/if}
						<code>{row.commandLine}</code>
					</span>
					<span class="dur">
						{#if row.durationMs !== null}{duration(row.durationMs)}{:else if row.status === 'waiting'}queued{:else}running{/if}
					</span>
					{#if row.waitedMs > 0}
						<p class="note">Waited {duration(row.waitedMs)} for the <strong>{row.lock}</strong> lock.</p>
					{/if}
					{#if row.status === 'waiting' && row.lock}
						{@const lock = locks.find((l) => l.name === row.lock)}
						<p class="note waiting">
							#{row.position ?? 1} in the queue for <strong>{row.lock}</strong>{#if lock}
								({lock.permits} permit{lock.permits === 1 ? '' : 's'}{#if lock.held[0]}, held by <code>{lock.held[0].check}</code>{/if}){/if}.
						</p>
					{/if}
					{#if row.status === 'failed' && row.outputTail}
						<div class="tail">
							<div class="tail-head">
								<span>exit {row.exitCode}</span>
								<span>{baseline ? 'already failing before the change' : 'last lines of output'}</span>
							</div>
							<pre>{row.outputTail}</pre>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
		{#if a.fixer}
			<p class="fixer">
				<span class="hook" aria-hidden="true">↳</span>
				{#if a.fixer.durationMs === null && phase.status === 'interrupted'}
					The check-fix agent was working on the failure when the run stopped.
				{:else if a.fixer.durationMs === null}
					The check-fix agent is working on the failure<span class="ellipsis">…</span>
				{:else}
					The check-fix agent ({shortModel(a.fixer.model)}) worked {duration(a.fixer.durationMs)}{#if a.fixer.cost}&ensp;·&ensp;{usd(a.fixer.cost)}{/if}, then the checks ran again.
				{/if}
			</p>
		{/if}
	</div>
{/each}

<style>
	.lede {
		margin: 0 0 10px;
		font: italic 15px/1.5 var(--serif);
		color: var(--muted);
	}

	.attempt + .attempt {
		margin-top: 14px;
	}

	h4 {
		margin: 0 0 4px;
		font: 600 11px var(--sans);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--muted);
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--rule);
	}

	li {
		display: grid;
		grid-template-columns: 18px 96px minmax(0, 1fr) auto;
		align-items: baseline;
		column-gap: 10px;
		padding: 7px 0;
		border-bottom: 1px solid var(--rule);
	}

	.glyph {
		display: inline-flex;
		align-self: center;
		color: var(--faint);
	}

	.passed .glyph {
		color: var(--green);
	}
	.failed .glyph {
		color: var(--red);
	}
	.waiting .glyph {
		color: var(--amber);
	}
	.running .glyph {
		color: var(--blue);
	}

	.spin {
		width: 11px;
		height: 11px;
		margin: 1.5px;
		border: 1.5px solid currentColor;
		border-right-color: transparent;
		border-radius: 50%;
		animation: spin 900ms linear infinite;
	}

	@keyframes spin {
		to {
			rotate: 360deg;
		}
	}

	.name {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--ink);
	}

	.failed .name {
		color: var(--red);
	}

	.cmd {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--muted);
	}

	.cmd code {
		font-size: 12px;
	}

	.cmd .fix {
		color: var(--faint);
	}

	.dur {
		font: 12px var(--mono);
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.note {
		grid-column: 2 / -1;
		margin: 2px 0 0;
		font-size: 13px;
		color: var(--muted);
	}

	.note.waiting {
		color: var(--amber);
	}

	.note strong {
		font-weight: 600;
	}

	.tail {
		grid-column: 2 / -1;
		margin: 8px 0 4px;
		border: 1px solid var(--rule);
		border-radius: 6px;
		background: #2a2722;
		overflow: hidden;
	}

	.tail-head {
		display: flex;
		justify-content: space-between;
		padding: 6px 12px;
		font: 11.5px var(--mono);
		color: #a69f91;
		border-bottom: 1px solid #3a362f;
	}

	.tail-head span:first-child {
		color: #e59a8c;
	}

	pre {
		margin: 0;
		padding: 10px 12px 12px;
		font: 12.5px/1.55 var(--mono);
		color: #ece6da;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.fixer {
		margin: 10px 0 0;
		padding-left: 4px;
		font: 15px/1.5 var(--serif);
		color: var(--ink-2);
	}

	.hook {
		color: var(--faint);
		margin-right: 4px;
	}

	.ellipsis {
		animation: breathe 1.6s ease-in-out infinite;
	}

	@keyframes breathe {
		50% {
			opacity: 0.3;
		}
	}
</style>
