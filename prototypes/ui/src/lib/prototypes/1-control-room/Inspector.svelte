<script lang="ts">
	import { duration, locks, relTime, shortSha, usd, type Run, type Severity } from '#lib';
	import { buildMatrix, costByStep, lockActivity, type Cell } from './model.ts';

	let { run, onselect }: { run: Run; onselect: (id: string) => void } = $props();

	const matrix = $derived(buildMatrix(run));
	const costs = $derived(costByStep(run));
	const maxCost = $derived(Math.max(...costs.map((c) => c.cost), 0.01));
	const lockUse = $derived(lockActivity(run));

	let picked = $state<{ check: string; col: string; cell: Cell } | null>(null);
	let openFinding = $state<string | null>(null);

	const SEVERITIES: Severity[] = ['must-fix', 'tradeoff', 'nit'];
	const bySeverity = $derived(
		Object.fromEntries(SEVERITIES.map((s) => [s, run.findings.filter((f) => f.severity === s)])) as Record<
			Severity,
			Run['findings']
		>
	);
	const totalFindings = $derived(run.findings.length + run.disproved.length);
</script>

<aside>
	<!-- Checks -->
	<section>
		<h3>checks <span>{matrix.columns.length} pass{matrix.columns.length === 1 ? '' : 'es'}</span></h3>
		{#if matrix.rows.length}
			<table class="matrix">
				<thead>
					<tr>
						<th></th>
						{#each matrix.columns as c (c.key)}
							<th title={c.title} class={c.key.startsWith('b') ? 'base' : ''}>{c.label}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each matrix.rows as r (r.name)}
						<tr>
							<th>{r.name}</th>
							{#each matrix.columns as c (c.key)}
								{@const cell = r.cells[c.key]}
								<td>
									{#if cell}
										<button
											class={['cell', cell.state, c.key.startsWith('b') && 'base', picked?.check === r.name && picked.col === c.key && 'picked']}
											disabled={cell.state !== 'fail'}
											title={`${r.name} · ${c.title} · ${cell.state}${cell.durationMs ? ` · ${duration(cell.durationMs)}` : ''}${cell.fixed ? ' · fix command ran first' : ''}`}
											onclick={() =>
												(picked =
													picked?.check === r.name && picked.col === c.key
														? null
														: { check: r.name, col: c.key, cell })}
										>
											{#if cell.state === 'pass'}✓{:else if cell.state === 'fail'}✗{:else if cell.state === 'running'}<i class="spin"></i>{:else if cell.state === 'waiting'}⧗{:else}–{/if}
											{#if cell.fixed}<sup>f</sup>{/if}
										</button>
									{:else}
										<span class="cell none">·</span>
									{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
			{#if picked}
				<div class="tail">
					<div class="tail-h">
						<span>{picked.check} · exit {picked.cell.exitCode} · {picked.col}</span>
						<button onclick={() => (picked = null)} aria-label="Close output">×</button>
					</div>
					{#if picked.cell.commandLine}<div class="cmd">$ {picked.cell.commandLine}</div>{/if}
					<pre>{picked.cell.outputTail}</pre>
					{#if picked.col.startsWith('b')}
						<p class="note">Failed at baseline: not held against the change, listed in the PR body.</p>
					{/if}
				</div>
			{:else if matrix.rows.some((r) => Object.values(r.cells).some((c) => c.state === 'fail'))}
				<p class="hint">click a ✗ to see its output tail</p>
			{/if}
		{:else}
			<p class="empty">No checks ran in this run.</p>
		{/if}
	</section>

	<!-- Locks -->
	<section>
		<h3>locks <span>daemon-wide</span></h3>
		{#each locks as l (l.name)}
			<div class="lock">
				<div class="lock-h">
					<code>{l.name}</code>
					<span class="permits">
						{#each Array(l.permits) as _, i (i)}
							<i class={i < l.held.length ? 'held' : ''}></i>
						{/each}
					</span>
					<span class="dim">{l.held.length}/{l.permits}</span>
				</div>
				{#each l.held as h (h.runId + h.check)}
					<div class={['holder', h.runId === run.runId && 'mine']}>
						<span class="hold-tag">held</span>
						{#if h.runId.startsWith('r-')}
							<button class="rid" onclick={() => onselect(h.runId)}>{h.runId}</button>
						{:else}<span class="rid ext">{h.runId}</span>{/if}
						<span class="what">{h.check}</span>
						<span class="dim">{relTime(h.since)}</span>
					</div>
				{/each}
				{#each l.queue as q, i (q.runId + q.check)}
					<div class={['holder', 'queued', q.runId === run.runId && 'mine']}>
						<span class="hold-tag">#{i + 1}</span>
						<button class="rid" onclick={() => onselect(q.runId)}>{q.runId}</button>
						<span class="what">{q.check}</span>
						<span class="dim">{relTime(q.since)}</span>
					</div>
				{/each}
			</div>
		{/each}
		<p class="hint">
			this run: {lockUse.acquired} acquisitions{lockUse.waitedMs
				? `, waited ${duration(lockUse.waitedMs)}`
				: ', no waits'}
		</p>
	</section>

	<!-- Findings -->
	<section>
		<h3>findings <span>{totalFindings} reported · {run.disproved.length} disproved</span></h3>
		<div class="sev">
			{#each SEVERITIES as s (s)}
				<div class={['sev-cell', s]}>
					<b>{bySeverity[s].length}</b>
					<span>{s}</span>
				</div>
			{/each}
		</div>
		{#if totalFindings}
			<div class="sevbar">
				{#each SEVERITIES as s (s)}
					<i class={s} style:flex={bySeverity[s].length}></i>
				{/each}
				<i class="disproved" style:flex={run.disproved.length}></i>
			</div>
		{/if}
		<ul class="findings">
			{#each run.findings as f (f.id)}
				<li>
					<button class="f-row" onclick={() => (openFinding = openFinding === f.id ? null : f.id)}>
						<span class={['sevdot', f.severity]}></span>
						<code class="fid">{f.id}</code>
						<span class="floc">{f.file.split('/').at(-1)}{f.line ? `:${f.line}` : ''}</span>
						<span class="frev">{f.reviewer}</span>
					</button>
					{#if openFinding === f.id}
						<div class="f-body">
							<p>{f.claim}</p>
							<p class="ev">{f.evidence}</p>
							<p class="verdict"><span>verifier</span> {f.verdict}</p>
							{#if f.repeats}<p class="rep">repeats {f.repeats}</p>{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>

	<!-- Cost -->
	<section>
		<h3>cost <span>{usd(run.costUsd)}</span></h3>
		{#each costs as c (c.step)}
			<div class="cost">
				<span class="step">{c.step}</span>
				<span class="track"><i style:width="{(c.cost / maxCost) * 100}%"></i></span>
				<span class="amt">{usd(c.cost)}</span>
				<span class="models">{[...c.models].join(', ')}</span>
			</div>
		{:else}
			<p class="empty">No agent cost yet.</p>
		{/each}
	</section>

	<!-- Commits -->
	<section>
		<h3>
			commits
			<span>
				{run.diffStat.files} files <em class="add">+{run.diffStat.additions}</em>
				<em class="del">−{run.diffStat.deletions}</em>
			</span>
		</h3>
		{#each run.commits as c (c.sha)}
			<div class="commit"><code>{shortSha(c.sha)}</code><span>{c.message}</span></div>
		{:else}
			<p class="empty">No commits.</p>
		{/each}
	</section>
</aside>

<style>
	aside {
		overflow-y: auto;
		min-height: 0;
		background: var(--panel);
		border-left: 1px solid var(--line);
		font-size: 12px;
	}
	section {
		padding: 12px 14px 14px;
		border-bottom: 1px solid var(--line);
	}
	h3 {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin: 0 0 10px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text);
	}
	h3 span {
		font-family: var(--mono);
		font-weight: 400;
		font-size: 10px;
		letter-spacing: 0;
		text-transform: none;
		color: var(--dim);
	}
	.dim {
		color: var(--dim);
	}
	.empty,
	.hint {
		margin: 6px 0 0;
		color: var(--faint);
		font-size: 11px;
		font-family: var(--mono);
	}
	/* matrix */
	.matrix {
		border-collapse: separate;
		border-spacing: 3px;
		margin: -3px;
		font-family: var(--mono);
		font-size: 11px;
	}
	.matrix thead th {
		font-weight: 400;
		font-size: 10px;
		color: var(--dim);
		text-align: center;
		padding-bottom: 2px;
	}
	.matrix thead th.base {
		color: var(--faint);
	}
	.matrix tbody th {
		text-align: left;
		font-weight: 400;
		color: var(--text);
		padding-right: 8px;
		white-space: nowrap;
	}
	.matrix td {
		padding: 0;
	}
	.cell {
		position: relative;
		display: grid;
		place-items: center;
		width: 30px;
		height: 22px;
		border-radius: 2px;
		border: 1px solid transparent;
		font: inherit;
		font-size: 11px;
		background: var(--bg);
		color: var(--faint);
		padding: 0;
	}
	.cell.pass {
		color: var(--s-done);
		background: color-mix(in srgb, var(--s-done) 12%, var(--bg));
	}
	.cell.fail {
		color: #fff;
		background: color-mix(in srgb, var(--s-failed) 70%, var(--bg));
		cursor: pointer;
	}
	.cell.fail:hover,
	.cell.picked {
		outline: 1px solid var(--s-failed);
		outline-offset: 1px;
	}
	.cell.base.fail {
		background: repeating-linear-gradient(
			-45deg,
			color-mix(in srgb, var(--s-failed) 40%, var(--bg)) 0 3px,
			color-mix(in srgb, var(--s-failed) 22%, var(--bg)) 3px 6px
		);
	}
	.cell.running {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
	}
	.cell.waiting {
		color: var(--s-waiting);
		border: 1px dashed var(--s-waiting);
		animation: pulse 1.4s ease-in-out infinite;
	}
	.cell.none {
		background: none;
	}
	.cell sup {
		position: absolute;
		top: 1px;
		right: 2px;
		font-size: 7px;
		line-height: 1;
		opacity: 0.7;
	}
	.spin {
		width: 9px;
		height: 9px;
		border: 1.5px solid currentColor;
		border-right-color: transparent;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
	@keyframes pulse {
		50% {
			opacity: 0.45;
		}
	}
	.tail {
		margin-top: 10px;
		border: 1px solid color-mix(in srgb, var(--s-failed) 40%, var(--line));
		border-radius: 3px;
		background: var(--bg);
		overflow: hidden;
	}
	.tail-h {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 4px 8px;
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--s-failed);
		background: color-mix(in srgb, var(--s-failed) 10%, transparent);
	}
	.tail-h button {
		border: 0;
		background: none;
		color: var(--dim);
		cursor: pointer;
		font-size: 14px;
		line-height: 1;
	}
	.cmd {
		padding: 6px 8px 0;
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--dim);
	}
	pre {
		margin: 0;
		padding: 6px 8px 8px;
		font-family: var(--mono);
		font-size: 10.5px;
		line-height: 1.5;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 180px;
		overflow: auto;
	}
	.note {
		margin: 0;
		padding: 6px 8px;
		border-top: 1px solid var(--line);
		font-size: 10.5px;
		color: var(--dim);
	}
	/* locks */
	.lock + .lock {
		margin-top: 10px;
	}
	.lock-h {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 4px;
		font-family: var(--mono);
		font-size: 11px;
	}
	.lock-h code {
		color: var(--c-locks);
		min-width: 28px;
	}
	.permits {
		display: flex;
		gap: 2px;
		flex: 1;
	}
	.permits i {
		flex: 1;
		max-width: 34px;
		height: 6px;
		border-radius: 1px;
		background: var(--line-strong);
	}
	.permits i.held {
		background: var(--c-locks);
		box-shadow: 0 0 6px color-mix(in srgb, var(--c-locks) 60%, transparent);
	}
	.holder {
		display: grid;
		grid-template-columns: 34px 52px 1fr auto;
		gap: 6px;
		align-items: baseline;
		padding: 2px 4px;
		font-family: var(--mono);
		font-size: 10.5px;
		border-radius: 2px;
	}
	.holder.mine {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
	.hold-tag {
		color: var(--c-locks);
	}
	.queued .hold-tag {
		color: var(--s-waiting);
	}
	.rid {
		border: 0;
		padding: 0;
		background: none;
		font: inherit;
		color: var(--text);
		text-align: left;
		cursor: pointer;
		text-decoration: underline dotted var(--faint);
		text-underline-offset: 2px;
	}
	.rid.ext {
		color: var(--dim);
		text-decoration: none;
		cursor: default;
	}
	.what {
		color: var(--dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* findings */
	.sev {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 4px;
	}
	.sev-cell {
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: 3px;
		background: var(--bg);
	}
	.sev-cell b {
		display: block;
		font-family: var(--mono);
		font-size: 18px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		color: var(--sc);
		line-height: 1.1;
	}
	.sev-cell span {
		font-family: var(--mono);
		font-size: 10px;
		color: var(--dim);
	}
	.must-fix {
		--sc: var(--sev-must);
	}
	.tradeoff {
		--sc: var(--sev-trade);
	}
	.nit {
		--sc: var(--sev-nit);
	}
	.sevbar {
		display: flex;
		gap: 2px;
		height: 3px;
		margin-top: 6px;
	}
	.sevbar i {
		background: var(--sc);
		border-radius: 1px;
	}
	.sevbar i.disproved {
		background: var(--line-strong);
	}
	.findings {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
	}
	.f-row {
		display: grid;
		grid-template-columns: 8px 34px 1fr auto;
		gap: 6px;
		align-items: center;
		width: 100%;
		padding: 3px 4px;
		border: 0;
		background: none;
		color: var(--text);
		font-family: var(--mono);
		font-size: 10.5px;
		text-align: left;
		cursor: pointer;
		border-radius: 2px;
	}
	.f-row:hover {
		background: var(--hover);
	}
	.sevdot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--sc);
	}
	.fid {
		color: var(--dim);
	}
	.floc {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.frev {
		color: var(--faint);
	}
	.f-body {
		margin: 2px 0 6px 18px;
		padding: 6px 8px;
		border-left: 2px solid var(--line-strong);
		font-size: 11.5px;
		line-height: 1.45;
	}
	.f-body p {
		margin: 0 0 4px;
	}
	.ev {
		color: var(--dim);
		font-family: var(--mono);
		font-size: 10.5px;
	}
	.verdict {
		color: var(--text);
		font-size: 11px;
	}
	.verdict span,
	.rep {
		font-family: var(--mono);
		font-size: 10px;
		color: var(--c-review);
	}
	/* cost */
	.cost {
		display: grid;
		grid-template-columns: 68px 1fr 46px;
		grid-template-areas: 'step track amt' '. models models';
		gap: 0 8px;
		align-items: center;
		margin-bottom: 5px;
		font-family: var(--mono);
		font-size: 10.5px;
	}
	.step {
		grid-area: step;
		color: var(--text);
	}
	.track {
		grid-area: track;
		height: 6px;
		background: var(--bg);
		border-radius: 1px;
		overflow: hidden;
	}
	.track i {
		display: block;
		height: 100%;
		background: var(--c-cost);
		transition: width 0.5s ease;
	}
	.amt {
		grid-area: amt;
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--bright);
	}
	.models {
		grid-area: models;
		color: var(--faint);
		font-size: 9.5px;
	}
	/* commits */
	.commit {
		display: flex;
		gap: 8px;
		padding: 2px 0;
		font-size: 11.5px;
	}
	.commit code {
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--c-git);
	}
	.commit span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	em {
		font-style: normal;
	}
	.add {
		color: var(--s-done);
	}
	.del {
		color: var(--s-failed);
	}
</style>
