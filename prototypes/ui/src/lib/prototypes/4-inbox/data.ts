// Inbox-only mock data, derived from the shared mocks plus a few made-up records the inbox needs
// (a stored review waiting to be posted, PR threads, code excerpts).
import { NOW, openPrs, projects, runById } from '#lib';
import type { Finding, OpenPr, Run, RunEvent, Severity } from '#lib';

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

export type ItemKind =
	| 'escalated'
	| 'failed'
	| 'interrupted'
	| 'baseline'
	| 'threads'
	| 'tradeoff'
	| 'review';

export type Tone = Severity | 'error' | 'neutral';

export interface InboxItem {
	id: string;
	kind: ItemKind;
	projectKey: string;
	title: string;
	reason: string;
	at: string;
	runId: string | null;
	prNumber: number | null;
	tone: Tone;
	unread: boolean;
}

/** A finding as the inbox shows it: Clef may have lowered it from must-fix. */
export type InboxFinding = Finding & { lowered?: { p: number } };

export const kindLabel: Record<ItemKind, string> = {
	escalated: 'Escalated',
	failed: 'Failed',
	interrupted: 'Interrupted',
	baseline: 'Baseline',
	threads: 'PR threads',
	tradeoff: 'Tradeoff',
	review: 'Review ready'
};

export const projectName = (key: string) => projects.find((p) => p.key === key)?.name ?? key;

// --- A stored review of ship PR #28, not yet posted -----------------------------------------

type EventBody = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, 'seq' | 'at'> : never) : never;

const reviewEvents: RunEvent[] = (() => {
	let t = NOW.getTime() - 31 * 60_000;
	const out: RunEvent[] = [];
	const add = (s: number, body: EventBody) => {
		t += s * 1000;
		out.push({ ...body, seq: out.length + 1, at: new Date(t).toISOString() } as RunEvent);
	};
	add(0, { _tag: 'ReviewRunCreated', prUrl: 'https://github.com/f-elix/ship/pull/28', prNumber: 28, baseSha: 'b2e7864a1f03c9d2', headSha: '5c01e9f7d2a8b346' });
	add(1, { _tag: 'StateChanged', from: 'idle', to: 'review' });
	add(0, { _tag: 'ClefDecision', decision: 'reviewer routing', probability: 0.64, detail: 'added performance (p=0.64), contracts by trigger; risk routine → sonnet' });
	add(0, { _tag: 'ClefDecision', decision: 'convention topic', probability: 0.58, detail: 'added effect (p=0.58)' });
	add(2, { _tag: 'ReviewStarted', round: 1, fromSha: 'b2e7864a1f03c9d2', toSha: '5c01e9f7d2a8b346', reviewers: ['standards', 'spec', 'contracts', 'performance', 'design'] });
	add(44, { _tag: 'FindingsReported', round: 1, reviewer: 'standards', count: 1 });
	add(19, { _tag: 'FindingsReported', round: 1, reviewer: 'contracts', count: 1 });
	add(27, { _tag: 'FindingsReported', round: 1, reviewer: 'performance', count: 1 });
	add(30, { _tag: 'FindingsReported', round: 1, reviewer: 'design', count: 2 });
	add(6, { _tag: 'FindingsReported', round: 1, reviewer: 'spec', count: 0 });
	add(0, { _tag: 'AgentCost', step: 'review', model: 'claude-sonnet-5-5', costUsd: 0.97 });
	add(48, { _tag: 'FindingsVerified', round: 1, verified: ['f1-1', 'f1-2', 'f1-3', 'f1-4'], disproved: 1 });
	add(0, { _tag: 'AgentCost', step: 'verify', model: 'claude-sonnet-5-5', costUsd: 0.31 });
	add(1, { _tag: 'StateChanged', from: 'review', to: 'triage' });
	add(0, { _tag: 'ClefDecision', decision: 'lower must-fix', probability: 0.74, detail: 'lowered f1-2 to nit (taste remark)' });
	add(1, { _tag: 'FindingsTriaged', round: 1, mustFix: ['f1-1'], tradeoffs: ['f1-3'], nits: ['f1-2', 'f1-4'] });
	add(1, { _tag: 'ReviewStored', reviewId: 'rv-28a1' });
	add(0, { _tag: 'StateChanged', from: 'triage', to: 'done' });
	add(0, { _tag: 'RunFinished', status: 'done' });
	return out;
})();

const reviewFindings: InboxFinding[] = [
	{ id: 'f1-1', round: 1, reviewer: 'contracts', file: 'packages/core/src/contract.ts', line: 64, severity: 'must-fix', claim: '`LockHolder.since` is a `Schema.Date`, but the daemon encodes an ISO string; a 0.8 CLI decodes every status reply as invalid.', evidence: 'contract.ts:64 declares `Schema.Date`; locks.ts:18 stores `since: string` and sends it as-is.', verdict: 'traced: status RPC → Locks.status → held[].since (string) → client decode with Schema.Date fails.' },
	{ id: 'f1-2', round: 1, reviewer: 'performance', file: 'packages/daemon/src/locks.ts', line: 41, severity: 'nit', lowered: { p: 0.74 }, claim: '`status()` copies the holders map on every call.', evidence: '`[...new Map(info)]` allocates a copy before mapping; at most 4 holders per resource.', verdict: 'structural: one extra copy per status call.' },
	{ id: 'f1-3', round: 1, reviewer: 'design', file: 'packages/daemon/src/handlers.ts', severity: 'tradeoff', claim: 'Holders without a run (`ship init --write`) get a synthetic `ext:` id, so the UI cannot link them to anything.', evidence: '`holderId` falls back to `ext:${origin}`.', verdict: 'code reading: handlers.ts holderId; no origin registry exists.' },
	{ id: 'f1-4', round: 1, reviewer: 'standards', file: 'packages/daemon/src/locks.ts', line: 18, severity: 'nit', claim: '`info` does not say what it holds; the RPC calls it `held`.', evidence: '`const info = new Map<string, …>()`', verdict: 'structural.' }
];

export const storedReviewRun: Run = {
	runId: 'r-ux40',
	kind: 'review',
	projectKey: 'github.com/f-elix/ship',
	cwd: '~/Documents/projects/ship',
	status: 'done',
	state: 'done',
	round: 1,
	createdAt: reviewEvents[0].at,
	updatedAt: reviewEvents.at(-1)!.at,
	branch: 'felix/lock-holders',
	planDir: null,
	title: 'Daemon: report lock holders',
	prUrl: 'https://github.com/f-elix/ship/pull/28',
	prNumber: 28,
	reviewId: 'rv-28a1',
	costUsd: 1.28,
	checks: [],
	findings: reviewFindings,
	disproved: [
		{ reviewer: 'design', file: 'packages/daemon/src/locks.ts', line: 50, claim: 'A holder is never removed when its fiber is interrupted.', reason: 'disproved: `Effect.ensuring` on line 56 deletes it on every exit.', round: 1 }
	],
	escalationReason: null,
	error: null,
	events: reviewEvents,
	commits: [],
	diffStat: { files: 5, additions: 168, deletions: 22 }
};

/** Runs the inbox can show, shared ones plus the made-up review. */
export const inboxRun = (id: string | null): Run | undefined =>
	id === storedReviewRun.runId ? storedReviewRun : id ? runById(id) : undefined;

// --- Unresolved threads on storefront PR #412 ---------------------------------------------

export interface PrThread {
	id: string;
	author: string;
	file: string;
	line: number;
	body: string;
	/** How `ship fix` would read the thread. */
	as: { kind: 'ship-finding'; ref: string; severity: Severity } | { kind: 'clef'; severity: Severity | 'none'; p: number; label: string };
}

export const prThreads: Record<number, PrThread[]> = {
	412: [
		{ id: 't1', author: 'dev-sara', file: 'src/lib/tax/regions.ts', line: 48, body: 'This drops the EU reverse-charge case for B2B orders — a VAT number should zero the rate.', as: { kind: 'clef', severity: 'must-fix', p: 0.86, label: 'must-fix' } },
		{ id: 't2', author: 'ship', file: 'src/lib/tax/round.ts', line: 22, body: 'Tax is rounded per line item, so a 3-line cart can be off by 1¢ against the invoice total.', as: { kind: 'ship-finding', ref: 'rv-41a2/f1-2', severity: 'must-fix' } },
		{ id: 't3', author: 'dev-sara', file: 'src/routes/checkout/+page.svelte', line: 120, body: 'nit: the tax line flashes $0.00 before the region resolves.', as: { kind: 'clef', severity: 'nit', p: 0.77, label: 'nit' } },
		{ id: 't4', author: 'mina', file: 'src/lib/tax/regions.test.ts', line: 12, body: 'Why not a snapshot here?', as: { kind: 'clef', severity: 'none', p: 0.91, label: 'no finding (question)' } }
	]
};

// --- What `ship resume` would redo ---------------------------------------------------------

export interface ResumePlan {
	keep: string[];
	redo: string;
	then: string[];
	note: string;
}

export const resumePlans: Record<string, ResumePlan> = {
	'r-4ze1': {
		keep: ['baseline'],
		redo: 'implement',
		then: ['checks', 'review', 'triage', 'fix', 'pr'],
		note: 'Baseline results are checkpointed and kept, including the failing `test`. implement starts over on a clean tree with the current env and the 30-minute timeout.'
	},
	'r-5yu7': {
		keep: ['checks · round 1'],
		redo: 'check-fix',
		then: ['checks · round 2'],
		note: 'Round 1 results are kept: `check` failed on src/lib/cart.ts:31. The check-fix agent restarts from the commit it started on; its 40s of uncommitted work is discarded.'
	}
};

// --- Code excerpts around cited lines -------------------------------------------------------

export interface Excerpt {
	start: number;
	lines: string[];
	/** For findings with no cited line: the line the evidence matches. */
	focus?: number;
}

const ex = (start: number, src: string, focus?: number): Excerpt => ({ start, lines: src.split('\n'), focus });

export const excerpts: Record<string, Excerpt> = {
	'r-1hn5:f2-1': ex(1, `-- 0042: store a currency on invoices
BEGIN;
ALTER TABLE invoices ADD COLUMN currency char(3) NOT NULL;

-- backfill from the customer's billing country
UPDATE invoices SET currency = c.default_currency
  FROM customers c WHERE c.id = invoices.customer_id;
COMMIT;`),
	'r-1hn5:f1-1': ex(1, `-- 0042: store a currency on invoices
BEGIN;
ALTER TABLE invoices ADD COLUMN currency char(3) NOT NULL;
COMMIT;`),
	'r-1hn5:f2-2': ex(52, `pub fn to_minor_units(inv: &Invoice, rates: &RateTable) -> Result<i64, ConvertError> {
    let cur = inv.currency.clone();
    if cur == inv.base_currency {
        return Ok(inv.total_minor);
    }
    let rate = rates.get(&cur).unwrap();
    let converted = (inv.total_minor as f64 * rate.value).round() as i64;
    Ok(converted)
}`),
	'r-1hn5:f2-3': ex(1, `pub mod convert;
pub mod mail;

use crate::money::Currency;

/// Currency used when an invoice is created without one.
pub const DEFAULT_CURRENCY: Currency = Currency::EUR;`, 7),
	'r-1hn5:f2-4': ex(10, `//! Currency conversion for invoices.
//!
//! convert: converts

use crate::rates::RateTable;`),
	'r-7k2m:f1-1': ex(83, `export const selectReviewers = (change: ChangeSummary) =>
	routeWithClef(change, triggeredReviewers(change, briefs)).pipe(
		Effect.map(({ triggered, added }) => [...triggered, ...added]),
		Effect.timeout('30 seconds'),
		Effect.tapError((e) => Effect.logWarning('clef unavailable', e)),
		Effect.catchAll(() => Effect.succeed([]))
	);`),
	'r-7k2m:f1-2': ex(1, `import { describe, expect, it } from 'vitest';
import { Effect, Layer } from 'effect';
import { selectReviewers } from '../src/router.ts';

const ClefStub = Layer.succeed(Clef, {
	scoreReviewers: () => Effect.succeed(fixedScores)
});`, 6),
	'r-7k2m:f1-3': ex(98, `const addedByClef = (scores: ReadonlyArray<ClefScore>) =>
	scores
		.filter((s) => !s.triggered)
		// Clef may only add reviewers; never drop a triggered one.
		.filter((s) => s.p >= 0.5)
		.map((s) => s.reviewer);`),
	'r-7k2m:f1-4': ex(135, `export const routeWithClef = (change: ChangeSummary, triggered: ReviewerName[]) =>
	Effect.gen(function* () {
		const clef = yield* Clef;
		const scores = yield* clef.scoreReviewers(change, allReviewers);
		const added = addedByClef(scores);
		return { triggered: triggered.filter(notDisabled), added };
	});`),
	'r-ux40:f1-1': ex(60, `export const LockHolder = Schema.Struct({
	runId: Schema.String,
	check: Schema.String,
	// when the permit was taken
	since: Schema.Date
});`),
	'r-ux40:f1-2': ex(37, `	const status = () =>
		Effect.sync(() => ({
			permits,
			queue: [...waiters].map(toQueued),
			held: [...new Map(info)].map(([runId, h]) => ({ runId, ...h }))
		}));`),
	'r-ux40:f1-3': ex(1, `// ship init runs checks without a run; its holder id is synthetic.
const holderId = (req: CheckRequest) => req.runId ?? \`ext:\${req.origin}\`;`, 2),
	'r-ux40:f1-4': ex(15, `export const makeLock = (resource: string, permits: number) =>
	Effect.gen(function* () {
		const sem = yield* Effect.makeSemaphore(permits);
		const info = new Map<string, { check: string; since: string }>();
		const waiters = new Set<Waiter>();`),
	'threads:t1': ex(45, `export const rateFor = (region: Region, order: Order): number => {
	const base = REGION_RATES[region.code] ?? 0;
	if (order.customer?.vatNumber) return base;
	return base * (order.digital ? 1 : region.goodsFactor);
};`),
	'threads:t2': ex(20, `export const lineTax = (line: CartLine, rate: number) =>
	// cents
	Math.round(line.unitPrice * line.qty * rate);`),
	'threads:t3': ex(118, `<dl class="totals">
	<dt>Tax</dt>
	<dd>{formatMoney(tax ?? 0)}</dd>
</dl>`),
	'threads:t4': ex(10, `it('applies the CA rate', () => {
	const r = rateFor(regions.CA, order);
	expect(r).toBe(0.0725);
});`)
};

// --- Inbox items ----------------------------------------------------------------------------

const r = (id: string) => runById(id)!;
const pr = (n: number): OpenPr => openPrs.find((p) => p.number === n)!;
const eventAt = (run: Run, pred: (e: RunEvent) => boolean) => run.events.find(pred)?.at ?? run.updatedAt;

const items: InboxItem[] = [
	{
		id: 'esc-r-1hn5',
		kind: 'escalated',
		projectKey: r('r-1hn5').projectKey,
		title: r('r-1hn5').title,
		reason: 'Review cap reached with 2 must-fix — draft PR #88',
		at: r('r-1hn5').updatedAt,
		runId: 'r-1hn5',
		prNumber: 88,
		tone: 'must-fix',
		unread: true
	},
	{
		id: 'thr-412',
		kind: 'threads',
		projectKey: pr(412).project,
		title: pr(412).title,
		reason: '#412 has 4 unresolved threads — fix or recheck',
		at: pr(412).updatedAt,
		runId: null,
		prNumber: 412,
		tone: 'must-fix',
		unread: true
	},
	{
		id: 'rev-rv-28a1',
		kind: 'review',
		projectKey: storedReviewRun.projectKey,
		title: storedReviewRun.title,
		reason: 'Review rv-28a1 stored — 1 must-fix, 1 tradeoff, 2 nits; post it to #28',
		at: storedReviewRun.updatedAt,
		runId: 'r-ux40',
		prNumber: 28,
		tone: 'must-fix',
		unread: true
	},
	{
		id: 'fail-r-4ze1',
		kind: 'failed',
		projectKey: r('r-4ze1').projectKey,
		title: r('r-4ze1').title,
		reason: 'implement timed out — retry from the failed step',
		at: r('r-4ze1').updatedAt,
		runId: 'r-4ze1',
		prNumber: null,
		tone: 'error',
		unread: true
	},
	{
		id: 'int-r-5yu7',
		kind: 'interrupted',
		projectKey: r('r-5yu7').projectKey,
		title: r('r-5yu7').title,
		reason: 'daemon stopped during check-fix — resume',
		at: r('r-5yu7').updatedAt,
		runId: 'r-5yu7',
		prNumber: null,
		tone: 'error',
		unread: false
	},
	{
		id: 'base-r-9q4x',
		kind: 'baseline',
		projectKey: r('r-9q4x').projectKey,
		title: r('r-9q4x').title,
		reason: 'lint was failing before the change — it goes in the PR body, not the fix loop',
		at: eventAt(r('r-9q4x'), (e) => e._tag === 'CheckFinished' && e.baseline && e.exitCode !== 0),
		runId: 'r-9q4x',
		prNumber: null,
		tone: 'nit',
		unread: false
	},
	{
		id: 'ack-r-7k2m',
		kind: 'tradeoff',
		projectKey: r('r-7k2m').projectKey,
		title: r('r-7k2m').title,
		reason: 'Tradeoff f1-4 carried forward: Clef can re-add a disabled reviewer',
		at: eventAt(r('r-7k2m'), (e) => e._tag === 'FindingsTriaged'),
		runId: 'r-7k2m',
		prNumber: null,
		tone: 'tradeoff',
		unread: false
	}
];

export const initialItems = items.sort((a, b) => b.at.localeCompare(a.at));

export const fakeRunIds = ['r-q2n8', 'r-zk41', 'r-c7vd', 'r-m30x', 'r-h9fe', 'r-w5ja'];

export { ago };
