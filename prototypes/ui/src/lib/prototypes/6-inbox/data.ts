// The inbox's unit is a deliverable: what ship produced (a branch, a PR, a review) or was asked
// to produce (a plan). Runs are how a deliverable got made; they hang off it as history.
import { NOW, plans, projects, runById } from '#lib';
import type { CheckResult, Finding, Run } from '#lib';

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/** Where a deliverable stands, from the developer's side. Ordered by urgency. */
export type Stage = 'decide' | 'ready' | 'working' | 'queued' | 'closed';

export const STAGES: { id: Stage; label: string; hint: string }[] = [
	{ id: 'decide', label: 'Your call', hint: 'ship stopped and needs a decision' },
	{ id: 'ready', label: 'Ready for you', hint: 'produced and clean: review, merge or post' },
	{ id: 'working', label: 'In progress', hint: 'ship is on it; nothing to do yet' },
	{ id: 'queued', label: 'Up next', hint: 'plans ready to hand to ship' },
	{ id: 'closed', label: 'Closed', hint: 'merged, posted or abandoned' }
];

/** Whose code it is: ship wrote it, or ship reviewed someone else's PR. */
export type Origin = 'authored' | 'reviewed' | 'plan';

export interface PullRequest {
	number: number;
	url: string;
	state: 'draft' | 'open' | 'merged' | 'closed';
	/** CI on GitHub at the head, separate from ship's own checks. */
	ci: 'passing' | 'failing' | 'pending' | 'none';
	threads: { open: number; resolved: number };
	/** Human review on GitHub. */
	approval: 'none' | 'approved' | 'changes-requested';
}

export interface FileChange {
	path: string;
	status: 'A' | 'M' | 'D';
	add: number;
	del: number;
}

export interface HeadCheck {
	name: string;
	ok: boolean;
	/** Failed in the baseline too: not this change's to fix. */
	preexisting: boolean;
	outputTail?: string;
}

/** A PR review thread `ship fix` would act on. */
export interface Thread {
	id: string;
	author: string;
	file: string;
	line: number;
	body: string;
	/** How ship reads it: its own finding, or Clef's rating of a human comment. */
	readAs: { severity: Finding['severity'] | 'none'; by: 'ship' | 'clef'; p?: number };
}

export interface Action {
	label: string;
	/** The ship (or gh/git) command the button runs. */
	command: string;
	/** What happens to the deliverable once it ran (optimistic, for the prototype). */
	then?: { stage: Stage; headline: string };
	tone?: 'primary' | 'danger' | 'plain';
}

export interface Deliverable {
	id: string;
	origin: Origin;
	projectKey: string;
	title: string;
	branch: string | null;
	pr: PullRequest | null;
	stage: Stage;
	/** One sentence about the state of the output, never about the process. */
	headline: string;
	/** Short reason chip for the list. */
	tag: string;
	tone: 'must-fix' | 'tradeoff' | 'error' | 'ok' | 'neutral' | 'live';
	updatedAt: string;
	/** What the change sets out to do: the plan's intent or the PR description. */
	intent: string;
	primary: Action | null;
	secondary: Action[];
	/** Findings left for a human, by severity. */
	open: { mustFix: Finding[]; tradeoffs: Finding[]; nits: Finding[] };
	/** Findings ship already resolved before handing over; evidence the output is sound. */
	resolved: Finding[];
	disproved: number;
	reviewers: string[];
	rounds: number;
	threads: Thread[];
	files: FileChange[];
	commits: { sha: string; message: string }[];
	checks: HeadCheck[];
	/** When the output was not produced: why, and what retrying keeps. */
	failure: { error: string; produced: string; retry: string } | null;
	/** While ship works: plain-language progress toward the output. */
	progress: { now: string; step: number; of: number; eta: string } | null;
	runIds: string[];
	unread: boolean;
}

export const projectName = (key: string) => projects.find((p) => p.key === key)?.name ?? key;

const run = (id: string): Run => runById(id)!;

const sev = (r: Run, ids: string[]) => r.findings.filter((f) => ids.includes(f.id));

/** The last pass's results at the head, with baseline failures flagged. */
const headChecks = (r: Run): HeadCheck[] => {
	const base = r.checks.find((c) => c.baseline);
	const last = r.checks.filter((c) => !c.baseline).at(-1) ?? base;
	if (!last) return [];
	const failedBefore = new Set(base?.results.filter((c) => c.exitCode !== 0).map((c) => c.name));
	return last.results.map((c: CheckResult) => ({
		name: c.name,
		ok: c.exitCode === 0,
		preexisting: failedBefore.has(c.name),
		...(c.outputTail ? { outputTail: c.outputTail } : {})
	}));
};

// --- Made-up records the shared mocks do not have -----------------------------------------

const reviewOf28: Finding[] = [
	{ id: 'f1-1', round: 1, reviewer: 'contracts', file: 'packages/core/src/contract.ts', line: 64, severity: 'must-fix', claim: '`LockHolder.since` is a `Schema.Date`, but the daemon sends an ISO string, so every status reply fails to decode in a 0.8 CLI.', evidence: 'contract.ts:64 declares `Schema.Date`; locks.ts:18 stores `since: string` and sends it as is.', verdict: 'traced: status RPC → Locks.status → held[].since (string) → client decode with Schema.Date fails.' },
	{ id: 'f1-3', round: 1, reviewer: 'design', file: 'packages/daemon/src/handlers.ts', line: 29, severity: 'tradeoff', claim: 'Holders without a run (`ship init --write`) get a synthetic `ext:` id, so a UI cannot link them to anything.', evidence: '`holderId` falls back to `ext:${origin}`.', verdict: 'code reading: no origin registry exists.' },
	{ id: 'f1-2', round: 1, reviewer: 'performance', file: 'packages/daemon/src/locks.ts', line: 41, severity: 'nit', claim: '`status()` copies the holders map on every call.', evidence: '`[...new Map(info)]` before mapping; at most 4 holders per resource.', verdict: 'structural: one extra copy per call. Lowered from must-fix by Clef (p=0.74).' },
	{ id: 'f1-4', round: 1, reviewer: 'standards', file: 'packages/daemon/src/locks.ts', line: 18, severity: 'nit', claim: '`info` does not say what it holds; the RPC calls it `held`.', evidence: '`const info = new Map<string, …>()`', verdict: 'structural.' }
];

const threads412: Thread[] = [
	{ id: 't1', author: 'dev-sara', file: 'src/lib/tax/regions.ts', line: 48, body: 'This drops the EU reverse-charge case for B2B orders. A VAT number should zero the rate.', readAs: { severity: 'must-fix', by: 'clef', p: 0.86 } },
	{ id: 't2', author: 'ship', file: 'src/lib/tax/round.ts', line: 22, body: 'Tax is rounded per line item, so a 3-line cart can be off by 1¢ against the invoice total.', readAs: { severity: 'must-fix', by: 'ship' } },
	{ id: 't3', author: 'dev-sara', file: 'src/routes/checkout/+page.svelte', line: 120, body: 'nit: the tax line flashes $0.00 before the region resolves.', readAs: { severity: 'nit', by: 'clef', p: 0.77 } },
	{ id: 't4', author: 'mina', file: 'src/lib/tax/regions.test.ts', line: 12, body: 'Why not a snapshot here?', readAs: { severity: 'none', by: 'clef', p: 0.91 } }
];

const partial412: Finding[] = [
	{ id: 'p-1', round: 1, reviewer: 'ui-a11y', file: 'src/routes/checkout/TaxLine.svelte', line: 14, severity: 'must-fix', claim: 'The tax total updates without an `aria-live` region, so screen readers never announce the new total.', evidence: '`<span class="total">{tax}</span>` with no live region.', verdict: 'Not verified yet.' },
	{ id: 'p-2', round: 1, reviewer: 'data', file: 'src/lib/server/db/schema.ts', line: 88, severity: 'must-fix', claim: '`tax_rate` is a `real`; rates like 0.0825 lose precision.', evidence: '`taxRate: real("tax_rate")`', verdict: 'Not verified yet.' },
	{ id: 'p-3', round: 1, reviewer: 'standards', file: 'src/lib/tax/regions.ts', line: 9, severity: 'nit', claim: 'Region codes duplicate the list in `src/lib/geo.ts`.', evidence: 'Two literal arrays of ISO codes.', verdict: 'Not verified yet.' }
];

// --- Deliverables -------------------------------------------------------------------------

const r1hn5 = run('r-1hn5');
const r7k2m = run('r-7k2m');
const r9q4x = run('r-9q4x');
const r4ze1 = run('r-4ze1');
const r5yu7 = run('r-5yu7');
const r6tp0 = run('r-6tp0');

const empty = { mustFix: [], tradeoffs: [], nits: [] };

export const deliverables: Deliverable[] = [
	{
		id: 'billing-88',
		origin: 'authored',
		projectKey: r1hn5.projectKey,
		title: r1hn5.title,
		branch: r1hn5.branch,
		pr: { number: 88, url: 'https://github.com/acme/billing-api/pull/88', state: 'draft', ci: 'passing', threads: { open: 0, resolved: 0 }, approval: 'none' },
		stage: 'decide',
		headline: 'Draft PR is up, but 2 must-fix findings are still open after 2 review rounds. The migration problem came back after ship’s fix.',
		tag: '2 must-fix',
		tone: 'must-fix',
		updatedAt: r1hn5.updatedAt,
		intent: 'Store a currency on every invoice, defaulting to the customer’s billing currency, and convert totals to minor units with the day’s rate.',
		primary: { label: 'Fix the 2 must-fix', command: 'ship fix 88', tone: 'primary', then: { stage: 'working', headline: 'Fixing 2 must-fix findings on PR #88. Checks run after.' } },
		secondary: [
			{ label: 'Take over locally', command: 'gh pr checkout 88' },
			{ label: 'Mark ready anyway', command: 'gh pr ready 88', then: { stage: 'ready', headline: 'PR #88 marked ready with 2 must-fix open. The PR body lists them for reviewers.' } }
		],
		open: { mustFix: sev(r1hn5, ['f2-1', 'f2-2']), tradeoffs: sev(r1hn5, ['f2-3']), nits: sev(r1hn5, ['f2-4']) },
		resolved: [],
		disproved: 1,
		reviewers: ['standards', 'spec', 'data', 'tests', 'error-handling'],
		rounds: 2,
		threads: [],
		files: [
			{ path: 'migrations/0042_invoice_currency.sql', status: 'A', add: 9, del: 0 },
			{ path: 'src/invoice/convert.rs', status: 'A', add: 118, del: 0 },
			{ path: 'src/invoice/mod.rs', status: 'M', add: 31, del: 6 },
			{ path: 'src/invoice/model.rs', status: 'M', add: 14, del: 2 },
			{ path: 'src/money.rs', status: 'M', add: 22, del: 4 },
			{ path: 'tests/invoice_currency.rs', status: 'A', add: 26, del: 0 }
		],
		commits: r1hn5.commits,
		checks: headChecks(r1hn5),
		failure: null,
		progress: null,
		runIds: ['r-1hn5'],
		unread: true
	},
	{
		id: 'ship-28-review',
		origin: 'reviewed',
		projectKey: 'github.com/f-elix/ship',
		title: 'Daemon: report lock holders',
		branch: 'felix/lock-holders',
		pr: { number: 28, url: 'https://github.com/f-elix/ship/pull/28', state: 'open', ci: 'passing', threads: { open: 2, resolved: 0 }, approval: 'none' },
		stage: 'decide',
		headline: 'Review written, not posted. 1 must-fix would request changes on f-elix’s PR.',
		tag: 'review to post',
		tone: 'must-fix',
		updatedAt: ago(30),
		intent: 'Add the holders of each lock resource to `ship daemon status`, so a waiting run can say what it is waiting behind.',
		primary: { label: 'Post review', command: 'ship post rv-28a1', tone: 'primary', then: { stage: 'closed', headline: 'Review posted on PR #28: changes requested, 3 inline comments, 1 in the body.' } },
		secondary: [{ label: 'Discard review', command: '—', tone: 'danger', then: { stage: 'closed', headline: 'Review rv-28a1 discarded. Nothing was posted.' } }],
		open: { mustFix: reviewOf28.filter((f) => f.severity === 'must-fix'), tradeoffs: reviewOf28.filter((f) => f.severity === 'tradeoff'), nits: reviewOf28.filter((f) => f.severity === 'nit') },
		resolved: [],
		disproved: 1,
		reviewers: ['standards', 'spec', 'contracts', 'performance', 'design'],
		rounds: 1,
		threads: [],
		files: [
			{ path: 'packages/core/src/contract.ts', status: 'M', add: 24, del: 3 },
			{ path: 'packages/daemon/src/locks.ts', status: 'M', add: 71, del: 12 },
			{ path: 'packages/daemon/src/handlers.ts', status: 'M', add: 18, del: 2 },
			{ path: 'packages/cli/src/commands/daemon.ts', status: 'M', add: 33, del: 5 },
			{ path: 'packages/daemon/test/locks.test.ts', status: 'M', add: 22, del: 0 }
		],
		commits: [{ sha: '5c01e9f7d2a8b346', message: 'Report lock holders in daemon status' }],
		checks: [],
		failure: null,
		progress: null,
		runIds: [],
		unread: true
	},
	{
		id: 'billing-webhooks',
		origin: 'authored',
		projectKey: r4ze1.projectKey,
		title: r4ze1.title,
		branch: r4ze1.branch,
		pr: null,
		stage: 'decide',
		headline: 'Nothing produced. The implementer hit the 30-minute timeout before committing.',
		tag: 'not produced',
		tone: 'error',
		updatedAt: r4ze1.updatedAt,
		intent: 'Receive Stripe webhooks for payment and refund events, verify their signatures and record them on the matching invoice.',
		primary: { label: 'Retry', command: 'ship resume r-4ze1', tone: 'primary', then: { stage: 'working', headline: 'Implementing again from a clean tree. The baseline is kept.' } },
		secondary: [
			{ label: 'Raise timeout and retry', command: 'timeouts.implement = "45 minutes" · ship resume r-4ze1', then: { stage: 'working', headline: 'Implementing again with a 45-minute limit.' } },
			{ label: 'Abandon', command: '—', tone: 'danger', then: { stage: 'closed', headline: 'Abandoned. The plan stays in .plans/stripe-webhooks.' } }
		],
		open: empty,
		resolved: [],
		disproved: 0,
		reviewers: [],
		rounds: 0,
		threads: [],
		files: [],
		commits: [],
		checks: headChecks(r4ze1),
		failure: {
			error: 'implement timed out after 30 minutes',
			produced: 'No commits. The branch is still at develop.',
			retry: 'Retrying keeps the baseline results and starts the implementer over on a clean tree.'
		},
		progress: null,
		runIds: ['r-4ze1'],
		unread: false
	},
	{
		id: 'storefront-cart-types',
		origin: 'authored',
		projectKey: r5yu7.projectKey,
		title: 'Fix failing checks on mina/cart-types',
		branch: 'mina/cart-types',
		pr: null,
		stage: 'decide',
		headline: 'Fix for the failing `check` was not committed: the daemon stopped mid-fix.',
		tag: 'interrupted',
		tone: 'error',
		updatedAt: r5yu7.updatedAt,
		intent: 'Make the branch pass its checks: `check` fails on src/lib/cart.ts:31.',
		primary: { label: 'Resume', command: 'ship resume r-5yu7', tone: 'primary', then: { stage: 'working', headline: 'Fixing `check` again. Its 40s of uncommitted work was discarded.' } },
		secondary: [{ label: 'Cancel', command: 'ship cancel r-5yu7', tone: 'danger', then: { stage: 'closed', headline: 'Cancelled. Nothing was committed.' } }],
		open: empty,
		resolved: [],
		disproved: 0,
		reviewers: [],
		rounds: 0,
		threads: [],
		files: [],
		commits: [],
		checks: headChecks(r5yu7),
		failure: {
			error: 'daemon stopped while the check-fix agent ran',
			produced: 'No commits. Round 1 check results are saved.',
			retry: 'Resuming keeps round 1’s results and restarts the check-fix agent.'
		},
		progress: null,
		runIds: ['r-5yu7'],
		unread: false
	},
	{
		id: 'ship-clef-routing',
		origin: 'authored',
		projectKey: r7k2m.projectKey,
		title: r7k2m.title,
		branch: r7k2m.branch,
		pr: null,
		stage: 'working',
		headline: '2 commits, checks pass. Waiting on the second review of ship’s fixes.',
		tag: 'review 2/3',
		tone: 'live',
		updatedAt: r7k2m.updatedAt,
		intent: 'Ask Clef which extra reviewers a change needs and which model to review it with. Clef may only add reviewers, and every call falls back to the triggers when Clef is unavailable.',
		primary: null,
		secondary: [{ label: 'Cancel', command: 'ship cancel r-7k2m', tone: 'danger', then: { stage: 'closed', headline: 'Cancelled. 2 commits stay on felix/clef-routing; no PR was opened.' } }],
		open: { mustFix: [], tradeoffs: sev(r7k2m, ['f1-4']), nits: [] },
		resolved: sev(r7k2m, ['f1-1', 'f1-2', 'f1-3']),
		disproved: 2,
		reviewers: ['standards', 'spec', 'tests', 'error-handling', 'design'],
		rounds: 2,
		threads: [],
		files: [
			{ path: 'packages/core/src/router.ts', status: 'M', add: 164, del: 41 },
			{ path: 'packages/core/src/clef.ts', status: 'M', add: 58, del: 12 },
			{ path: 'packages/core/src/review-step.ts', status: 'M', add: 22, del: 9 },
			{ path: 'packages/core/src/reviewers.ts', status: 'M', add: 18, del: 6 },
			{ path: 'packages/core/test/router.test.ts', status: 'M', add: 121, del: 14 },
			{ path: 'README.md', status: 'M', add: 29, del: 6 }
		],
		commits: r7k2m.commits,
		checks: headChecks(r7k2m),
		failure: null,
		progress: { now: 'Reviewing the fixes', step: 4, of: 5, eta: '~3 min' },
		runIds: ['r-7k2m'],
		unread: false
	},
	{
		id: 'storefront-saved-carts',
		origin: 'authored',
		projectKey: r9q4x.projectKey,
		title: r9q4x.title,
		branch: r9q4x.branch,
		pr: null,
		stage: 'working',
		headline: 'Implemented in 14 files. Checking, queued behind another run for the test database.',
		tag: 'checking',
		tone: 'neutral',
		updatedAt: r9q4x.updatedAt,
		intent: 'Signed-in shoppers can save a cart, name it and restore it later from their account page.',
		primary: null,
		secondary: [{ label: 'Cancel', command: 'ship cancel r-9q4x', tone: 'danger', then: { stage: 'closed', headline: 'Cancelled before any commit.' } }],
		open: empty,
		resolved: [],
		disproved: 0,
		reviewers: [],
		rounds: 0,
		threads: [],
		files: [
			{ path: 'src/lib/server/db/schema.ts', status: 'M', add: 42, del: 0 },
			{ path: 'src/lib/server/carts.ts', status: 'A', add: 188, del: 0 },
			{ path: 'src/routes/account/carts/+page.svelte', status: 'A', add: 141, del: 0 },
			{ path: 'src/routes/account/carts/+page.server.ts', status: 'A', add: 77, del: 0 },
			{ path: 'src/routes/cart/+page.svelte', status: 'M', add: 64, del: 21 },
			{ path: 'src/lib/server/carts.test.ts', status: 'A', add: 203, del: 0 }
		],
		commits: [],
		checks: headChecks(r9q4x),
		failure: null,
		progress: { now: 'Waiting for the test database', step: 2, of: 5, eta: '~12 min' },
		runIds: ['r-9q4x'],
		unread: false
	},
	{
		id: 'storefront-412',
		origin: 'reviewed',
		projectKey: 'github.com/acme/storefront',
		title: 'Checkout: apply regional tax rules',
		branch: 'dev/checkout-tax',
		pr: { number: 412, url: 'https://github.com/acme/storefront/pull/412', state: 'open', ci: 'failing', threads: { open: 4, resolved: 1 }, approval: 'changes-requested' },
		stage: 'working',
		headline: 'Reviewing dev-amir’s PR: 3 of 6 reviewers reported so far. Not verified yet.',
		tag: 'reviewing',
		tone: 'neutral',
		updatedAt: ago(1),
		intent: 'Apply tax by shipping region (US states, EU VAT, CA provinces) at checkout, with rates stored per region.',
		primary: null,
		secondary: [{ label: 'Cancel review', command: 'ship cancel r-3vb8', tone: 'danger' }],
		open: { mustFix: partial412.filter((f) => f.severity === 'must-fix'), tradeoffs: [], nits: partial412.filter((f) => f.severity === 'nit') },
		resolved: [],
		disproved: 0,
		reviewers: ['standards', 'spec', 'security', 'ui-a11y', 'tests', 'data'],
		rounds: 1,
		threads: threads412,
		files: [
			{ path: 'src/lib/tax/regions.ts', status: 'A', add: 312, del: 0 },
			{ path: 'src/lib/tax/round.ts', status: 'A', add: 48, del: 0 },
			{ path: 'src/lib/server/db/schema.ts', status: 'M', add: 36, del: 4 },
			{ path: 'src/routes/checkout/+page.svelte', status: 'M', add: 92, del: 61 },
			{ path: 'src/routes/checkout/TaxLine.svelte', status: 'A', add: 40, del: 0 },
			{ path: 'src/lib/tax/regions.test.ts', status: 'A', add: 410, del: 0 }
		],
		commits: [],
		checks: [],
		failure: null,
		progress: { now: 'Reviewers reporting', step: 1, of: 3, eta: '~4 min' },
		runIds: ['r-3vb8'],
		unread: false
	},
	{
		id: 'ship-26',
		origin: 'authored',
		projectKey: r6tp0.projectKey,
		title: r6tp0.title,
		branch: r6tp0.branch,
		pr: { number: 26, url: 'https://github.com/f-elix/ship/pull/26', state: 'draft', ci: 'passing', threads: { open: 0, resolved: 0 }, approval: 'none' },
		stage: 'ready',
		headline: 'Draft PR is up and clean: checks pass, no findings left, CI green.',
		tag: 'clean',
		tone: 'ok',
		updatedAt: r6tp0.updatedAt,
		intent: 'Bundle ship’s design conventions with the CLI, apply them to every run, and add `ship conventions` and a skill to read them while planning.',
		primary: { label: 'Mark ready for review', command: 'gh pr ready 26', tone: 'primary', then: { stage: 'ready', headline: 'PR #26 is open for review. CI green.' } },
		secondary: [{ label: 'Open diff', command: 'gh pr diff 26' }],
		open: empty,
		resolved: r6tp0.findings,
		disproved: 3,
		reviewers: ['standards', 'spec', 'comments', 'design', 'tests'],
		rounds: 1,
		threads: [],
		files: [
			{ path: 'packages/core/src/conventions/*.md', status: 'A', add: 1820, del: 0 },
			{ path: 'packages/core/src/conventions.ts', status: 'A', add: 212, del: 0 },
			{ path: 'packages/cli/src/commands/conventions.ts', status: 'A', add: 96, del: 0 },
			{ path: 'packages/core/src/implementer.ts', status: 'M', add: 41, del: 18 },
			{ path: 'skills/ship-conventions/SKILL.md', status: 'A', add: 64, del: 0 },
			{ path: 'README.md', status: 'M', add: 22, del: 2 }
		],
		commits: r6tp0.commits,
		checks: headChecks(r6tp0),
		failure: null,
		progress: null,
		runIds: ['r-6tp0'],
		unread: true
	},
	{
		id: 'storefront-398',
		origin: 'reviewed',
		projectKey: 'github.com/acme/storefront',
		title: 'Checkout: show tax breakdown',
		branch: 'dev/checkout-tax-breakdown',
		pr: { number: 398, url: 'https://github.com/acme/storefront/pull/398', state: 'open', ci: 'passing', threads: { open: 3, resolved: 0 }, approval: 'changes-requested' },
		stage: 'ready',
		headline: 'Fixes for 3 review threads pushed, checks pass. The threads are still open on GitHub.',
		tag: 'fixes pushed',
		tone: 'ok',
		updatedAt: run('r-2fd9').updatedAt,
		intent: 'Show tax per line item and per region in the order summary.',
		primary: { label: 'Recheck and resolve threads', command: 'ship recheck 398', tone: 'primary', then: { stage: 'ready', headline: 'All 3 findings verified fixed; their threads are resolved. Ready for re-review.' } },
		secondary: [{ label: 'Open PR', command: 'gh pr view 398 --web' }],
		open: empty,
		resolved: [
			{ id: 't-1', round: 1, reviewer: 'github:dev-sara', file: 'src/lib/tax/breakdown.ts', line: 30, severity: 'must-fix', claim: 'Breakdown sums unrounded values, so it disagrees with the total.', evidence: 'Thread on line 30.', verdict: 'Fixed in 3a9c1f0.' },
			{ id: 't-2', round: 1, reviewer: 'github:mina', file: 'src/routes/checkout/Summary.svelte', line: 58, severity: 'must-fix', claim: 'Empty regions render a "0.00" row.', evidence: 'Thread on line 58.', verdict: 'Fixed in 3a9c1f0.' },
			{ id: 't-3', round: 1, reviewer: 'github:dev-sara', file: 'src/lib/tax/breakdown.ts', line: 12, severity: 'nit', claim: 'Rename `x` to `regionTotal`.', evidence: 'Thread on line 12.', verdict: 'Fixed in 3a9c1f0.' }
		],
		disproved: 0,
		reviewers: [],
		rounds: 0,
		threads: [],
		files: [
			{ path: 'src/lib/tax/breakdown.ts', status: 'M', add: 38, del: 17 },
			{ path: 'src/routes/checkout/Summary.svelte', status: 'M', add: 15, del: 6 },
			{ path: 'src/lib/tax/breakdown.test.ts', status: 'M', add: 8, del: 0 }
		],
		commits: run('r-2fd9').commits,
		checks: headChecks(run('r-2fd9')),
		failure: null,
		progress: null,
		runIds: ['r-2fd9'],
		unread: false
	},
	{
		id: 'ship-25',
		origin: 'authored',
		projectKey: 'github.com/f-elix/ship',
		title: 'Retry transient agent failures',
		branch: 'felix/retry',
		pr: { number: 25, url: 'https://github.com/f-elix/ship/pull/25', state: 'merged', ci: 'passing', threads: { open: 0, resolved: 3 }, approval: 'approved' },
		stage: 'closed',
		headline: 'Merged. All 3 findings verified fixed, threads resolved.',
		tag: 'merged',
		tone: 'ok',
		updatedAt: ago(60 * 22),
		intent: 'Retry agent calls that fail on transient errors, and let `ship resume` retry failed runs from the failed step.',
		primary: null,
		secondary: [],
		open: empty,
		resolved: [],
		disproved: 0,
		reviewers: [],
		rounds: 0,
		threads: [],
		files: [],
		commits: [{ sha: '8fb3117a1c22d0e9', message: 'Retry transient agent failures and let ship resume retry failed runs' }],
		checks: [],
		failure: null,
		progress: null,
		runIds: ['r-8wc3'],
		unread: false
	},
	{
		id: 'ship-step-rename',
		origin: 'authored',
		projectKey: 'github.com/f-elix/ship',
		title: 'Rename primitive to step',
		branch: 'felix/step-rename',
		pr: null,
		stage: 'closed',
		headline: 'Cancelled during implement. Nothing committed.',
		tag: 'cancelled',
		tone: 'neutral',
		updatedAt: run('r-0ma2').updatedAt,
		intent: 'Rename the internal "primitive" concept to "step" across core, daemon and CLI.',
		primary: null,
		secondary: [],
		open: empty,
		resolved: [],
		disproved: 0,
		reviewers: [],
		rounds: 0,
		threads: [],
		files: [],
		commits: [],
		checks: [],
		failure: null,
		progress: null,
		runIds: ['r-0ma2'],
		unread: false
	},
	...plans.map((p): Deliverable => ({
		id: `plan:${p.path}`,
		origin: 'plan',
		projectKey: p.project,
		title: p.title,
		branch: p.branch,
		pr: null,
		stage: 'queued',
		headline: p.project.endsWith('storefront')
			? 'Plan written. The working tree has uncommitted changes, so ship can’t start yet.'
			: 'Plan written and the tree is clean. Ready to hand to ship.',
		tag: 'plan',
		tone: 'neutral',
		updatedAt: p.updatedAt,
		intent: p.spec.split('\n').filter((l) => l && !l.startsWith('#'))[0] ?? '',
		primary: { label: 'Ship it', command: `ship run ${p.path}`, tone: 'primary', then: { stage: 'working', headline: 'Checking the baseline before implementing.' } },
		secondary: [{ label: 'Implement only', command: `ship implement ${p.path}`, then: { stage: 'working', headline: 'Implementing. No review or PR afterwards.' } }],
		open: empty,
		resolved: [],
		disproved: 0,
		reviewers: [],
		rounds: 0,
		threads: [],
		files: [],
		commits: [],
		checks: [],
		failure: null,
		progress: null,
		runIds: [],
		unread: false
	}))
];

/** The plan text shown for a queued deliverable. */
export const planFor = (id: string) => plans.find((p) => `plan:${p.path}` === id);

// --- Code around cited lines --------------------------------------------------------------

export interface Excerpt {
	start: number;
	lines: string[];
}

const ex = (start: number, src: string): Excerpt => ({ start, lines: src.split('\n') });

export const excerpts: Record<string, Excerpt> = {
	'billing-88:f2-1': ex(1, `-- 0042: store a currency on invoices
BEGIN;
ALTER TABLE invoices ADD COLUMN currency char(3) NOT NULL;

-- backfill from the customer's billing country
UPDATE invoices SET currency = c.default_currency
  FROM customers c WHERE c.id = invoices.customer_id;
COMMIT;`),
	'billing-88:f2-2': ex(52, `pub fn to_minor_units(inv: &Invoice, rates: &RateTable) -> Result<i64, ConvertError> {
    let cur = inv.currency.clone();
    if cur == inv.base_currency {
        return Ok(inv.total_minor);
    }
    let rate = rates.get(&cur).unwrap();
    let converted = (inv.total_minor as f64 * rate.value).round() as i64;
    Ok(converted)
}`),
	'billing-88:f2-4': ex(10, `//! Currency conversion for invoices.
//!
//! convert: converts

use crate::rates::RateTable;`),
	'ship-28-review:f1-1': ex(60, `export const LockHolder = Schema.Struct({
	runId: Schema.String,
	check: Schema.String,
	/** When the holder took its permit. */
	since: Schema.Date
});`),
	'ship-28-review:f1-2': ex(38, `export const status = Effect.gen(function* () {
	const info = yield* Ref.get(holders);
	return [...new Map(info)].map(([resource, held]) => ({
		resource,
		held: [...held.values()]
	}));
});`),
	'ship-28-review:f1-4': ex(16, `const permits = new Map<LockResource, Semaphore>();
// Holders by resource, for status.
const info = new Map<string, Map<string, Holder>>();`),
	'ship-28-review:f1-3': ex(28, `const holderId = (req: CheckRequest) =>
	req.runId ?? \`ext:\${req.origin}\`;

export const runChecks = (req: CheckRequest) =>`),
	'storefront-412:p-1': ex(10, `<script lang="ts">
	let { tax }: { tax: string } = $props();
</script>

<span class="total">{tax}</span>`),
	'storefront-412:p-2': ex(85, `export const regions = pgTable('regions', {
	code: text('code').primaryKey(),
	name: text('name').notNull(),
	taxRate: real('tax_rate').notNull()
});`),
	'ship-clef-routing:f1-4': ex(136, `export const route = (change: ChangeSummary, config: ReviewerConfig) =>
	Effect.gen(function* () {
		const enabled = briefs.filter((b) => !config.disable.includes(b.name));
		const triggered = triggeredReviewers(change, enabled);
		const added = yield* clefAdditions(change, briefs);`)
};
