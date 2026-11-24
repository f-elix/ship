<script lang="ts">
	import { openPrs, runById } from '#lib';
	import CodeExcerpt from './CodeExcerpt.svelte';
	import { excerpts, prThreads } from './data.ts';
	import type { Entry } from './inbox.svelte.ts';

	let { entry }: { entry: Entry } = $props();

	const pr = $derived(openPrs.find((p) => p.number === entry.prNumber));
	const threads = $derived(prThreads[entry.prNumber ?? 0] ?? []);
	const reviewing = $derived(pr?.lastShipReview ? runById(pr.lastShipReview) : undefined);
</script>

<section class="threads">
	<p class="lede">
		<b>{pr?.author}</b> pushed to <code>{pr?.headRef}</code>; {threads.length} review threads are still open. <code>ship fix {entry.prNumber}</code>
		reads each one as a finding — threads ship posted keep their stored severity, other threads get a Clef rating.
	</p>

	{#if reviewing && (reviewing.status === 'running' || reviewing.status === 'waiting')}
		<div class="note">
			<span class="live"></span>
			<code>ship review {entry.prNumber}</code> is running as <b>{reviewing.runId}</b> ({reviewing.state}, round {reviewing.round}) — its
			findings will add threads once posted.
		</div>
	{/if}

	{#each threads as t (t.id)}
		{@const sev = t.as.severity}
		<article class={['thread', `s-${sev}`]}>
			<header>
				<span class="avatar" aria-hidden="true">{t.author === 'ship' ? '⛵' : t.author[0].toUpperCase()}</span>
				<b>{t.author}</b>
				<code>{t.file}:{t.line}</code>
				<span class="as">
					{#if t.as.kind === 'ship-finding'}
						<span class="chip ship">ship-finding {t.as.ref}</span>
						<span class="chip sev">{t.as.severity}</span>
					{:else}
						<span class="chip clef">Clef p={t.as.p.toFixed(2)}</span>
						<span class="chip sev">{t.as.label}</span>
					{/if}
				</span>
			</header>
			<p class="body">{t.body}</p>
			<CodeExcerpt file={t.file} line={t.line} excerpt={excerpts[`threads:${t.id}`]} tone={sev === 'none' ? 'nit' : sev} />
			{#if sev === 'none'}
				<p class="skip">Left out of the fix — reply on GitHub.</p>
			{/if}
		</article>
	{/each}
</section>

<style>
	.threads {
		display: grid;
		gap: 16px;
	}
	.lede {
		margin: 0;
		font-size: 14.5px;
		line-height: 1.6;
		color: var(--ink-2);
		max-width: 72ch;
	}
	code {
		font: 12px var(--mono);
		color: var(--ink);
	}
	.note {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12.5px;
		color: var(--muted);
		padding: 10px 14px;
		border-radius: 8px;
		background: var(--accent-wash);
	}
	.live {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--live);
		flex: none;
	}
	.thread {
		display: grid;
		gap: 10px;
		padding: 14px 16px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel);
		--sev: var(--mf);
	}
	.s-nit,
	.s-none {
		--sev: var(--nit);
	}
	.s-tradeoff {
		--sev: var(--tr);
	}
	.s-none {
		opacity: 0.7;
	}
	header {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
	}
	header code {
		color: var(--muted);
	}
	.avatar {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: 11px;
		font-weight: 600;
		background: var(--bg);
		border: 1px solid var(--line);
		color: var(--muted);
	}
	.as {
		margin-left: auto;
		display: flex;
		gap: 6px;
	}
	.chip {
		font: 500 11px var(--mono);
		padding: 2px 8px;
		border-radius: 999px;
	}
	.ship {
		background: var(--accent-wash);
		color: var(--accent);
	}
	.clef {
		background: var(--clef-wash);
		color: var(--clef);
	}
	.sev {
		color: var(--sev);
		background: color-mix(in oklab, var(--sev) 12%, transparent);
		font-weight: 600;
	}
	.body {
		margin: 0;
		font-size: 14px;
		line-height: 1.5;
		color: var(--ink);
	}
	.skip {
		margin: 0;
		font-size: 12px;
		color: var(--faint);
		font-style: italic;
	}
</style>
