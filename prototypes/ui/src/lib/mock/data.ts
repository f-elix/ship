import type {
	CheckRound,
	DaemonInfo,
	DisprovedFinding,
	Finding,
	LockResource,
	OpenPr,
	PlanDir,
	Project,
	Reviewer,
	Run,
	RunEvent,
	RunKind,
	RunStatus
} from './types.ts';

/** "Now" for every prototype, so relative times read the same everywhere. */
export const NOW = new Date('2026-11-23T15:42:00Z');

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const sha = (seed: string) => {
	let h = 2166136261;
	for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
	return (h >>> 0).toString(16).padStart(8, '0') + ((h * 31) >>> 0).toString(16).padStart(8, '0');
};

// --- Projects -----------------------------------------------------------------------------

export const projects: Project[] = [
	{
		key: 'github.com/f-elix/ship',
		name: 'ship',
		path: '~/Documents/projects/ship',
		defaultBranch: 'main',
		checks: [
			{ name: 'lint', run: 'pnpm run lint', lock: 'cpu' },
			{ name: 'typecheck', run: 'pnpm run typecheck', lock: 'cpu' },
			{ name: 'test', run: 'pnpm run test', lock: 'cpu' },
			{ name: 'format', run: 'pnpm run format:check', fix: 'pnpm run format', lock: 'cpu' }
		],
		format: 'pnpm exec prettier --write {files}',
		reviewersDisabled: ['ui-a11y'],
		clef: true,
		pr: { draft: true, squash: true },
		models: { implement: 'opus', fix: 'sonnet', review: 'sonnet', verify: 'sonnet', pr: 'haiku' },
		caps: { checkFixAttempts: 3, reviewRounds: 3 },
		conventions: ['typescript', 'effect', 'error-handling', 'comments', 'testing', 'file-organization']
	},
	{
		key: 'github.com/acme/storefront',
		name: 'storefront',
		path: '~/work/acme/storefront',
		defaultBranch: 'main',
		checks: [
			{ name: 'format', run: 'pnpm prettier --check {files}', fix: 'pnpm prettier --write {files}', lock: 'cpu' },
			{ name: 'lint', run: 'pnpm eslint {files}', lock: 'cpu' },
			{ name: 'check', run: 'pnpm svelte-check', lock: 'cpu' },
			{ name: 'test', run: 'pnpm vitest run', lock: 'db' }
		],
		format: 'pnpm prettier --write {files}',
		reviewersDisabled: [],
		clef: true,
		pr: { draft: false, squash: true },
		models: { implement: 'opus', fix: 'sonnet', review: 'sonnet', verify: 'sonnet', pr: 'haiku' },
		caps: { checkFixAttempts: 3, reviewRounds: 3 },
		conventions: ['typescript', 'svelte-components', 'sveltekit', 'styling', 'testing', 'comments']
	},
	{
		key: 'github.com/acme/billing-api',
		name: 'billing-api',
		path: '~/work/acme/billing-api',
		defaultBranch: 'develop',
		checks: [
			{ name: 'fmt', run: 'cargo fmt --check', fix: 'cargo fmt', lock: 'cpu' },
			{ name: 'clippy', run: 'cargo clippy -- -D warnings', lock: 'cpu' },
			{ name: 'test', run: 'cargo test', lock: 'db' }
		],
		reviewersDisabled: ['comments'],
		clef: false,
		pr: { draft: true, squash: false },
		models: { implement: 'opus', fix: 'sonnet', review: 'sonnet', verify: 'opus', pr: 'haiku' },
		caps: { checkFixAttempts: 2, reviewRounds: 2 },
		conventions: ['error-handling', 'testing', 'comments']
	}
];

// --- Reviewers (packages/core/src/briefs/reviewers) ---------------------------------------

export const reviewers: Reviewer[] = [
	{ name: 'standards', triggers: 'always', description: 'Repository conventions and written project rules, local idioms, readability and reuse of existing helpers.' },
	{ name: 'spec', model: 'sonnet', triggers: 'always', description: 'Whether the change does what its stated intent asks; missing, partial or wrong requirements and unrequested behaviour.' },
	{ name: 'design', model: 'sonnet', triggers: 'new modules, services', description: 'Ownership, module boundaries, interfaces, persistence strategy and new abstractions.' },
	{ name: 'tests', triggers: 'source changes', description: 'Whether changed behaviour is covered by tests, and whether the tests can fail and stay deterministic.' },
	{ name: 'error-handling', triggers: 'catch, Effect.fail, Result', description: 'How failures are raised, propagated, recovered from and reported.' },
	{ name: 'security', model: 'opus', triggers: 'auth, exec, sql, secrets', description: 'Authentication, authorisation, secrets, cryptography, injection, untrusted input.' },
	{ name: 'contracts', triggers: 'exports, rpc, schemas', description: 'Public and cross-module contracts; breaking changes and caller compatibility.' },
	{ name: 'data', triggers: 'migrations, sql', description: 'Persistence: migrations, schemas, queries, transactions; data integrity.' },
	{ name: 'performance', triggers: 'loops over I/O', description: 'Algorithmic cost, queries in loops, blocking I/O, unbounded concurrency.' },
	{ name: 'deps', model: 'haiku', triggers: 'package.json, lockfiles', description: 'Dependency manifests and lockfiles.' },
	{ name: 'comments', model: 'haiku', triggers: 'added comments', description: 'Accuracy and value of code comments and docs the change adds.' },
	{ name: 'domain-language', model: 'haiku', triggers: 'CONTEXT.md present', description: 'Names of domain concepts against the project glossary.' },
	{ name: 'ui-a11y', triggers: '.svelte, .tsx, .css', description: 'UI behaviour and accessibility; loading, empty and error states.' }
];

// --- Event log builder --------------------------------------------------------------------

type EventBody = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, 'seq' | 'at'> : never) : never;

class Log {
	events: RunEvent[] = [];
	#t: number;
	#state = 'idle';
	constructor(startMinutesAgo: number) {
		this.#t = NOW.getTime() - startMinutesAgo * 60_000;
	}
	at(seconds: number, body: EventBody) {
		this.#t += seconds * 1000;
		this.events.push({ ...body, seq: this.events.length + 1, at: new Date(this.#t).toISOString() } as RunEvent);
		return this;
	}
	state(seconds: number, to: string) {
		const from = this.#state;
		this.#state = to;
		return this.at(seconds, { _tag: 'StateChanged', from, to });
	}
	checks(project: Project, opts: { baseline: boolean; round: number; attempt: number; fail?: Record<string, string>; waitDb?: number }) {
		for (const c of project.checks) {
			if (!opts.baseline && c.fix) {
				this.at(1, { _tag: 'CheckStarted', check: c.name, command: 'fix', baseline: false, round: opts.round, attempt: opts.attempt, commandLine: c.fix });
				this.at(2, { _tag: 'CheckFinished', check: c.name, command: 'fix', baseline: false, round: opts.round, attempt: opts.attempt, exitCode: 0, durationMs: 1800, outputTail: '' });
			}
			if (c.lock === 'db' && opts.waitDb) {
				this.at(1, { _tag: 'LockWaiting', resource: 'db', check: c.name, position: 1 });
				this.at(opts.waitDb, { _tag: 'LockAcquired', resource: 'db', check: c.name, waitedMs: opts.waitDb * 1000 });
			} else {
				this.at(1, { _tag: 'LockAcquired', resource: c.lock, check: c.name, waitedMs: 0 });
			}
			this.at(0, { _tag: 'CheckStarted', check: c.name, command: 'run', baseline: opts.baseline, round: opts.round, attempt: opts.attempt, commandLine: c.run });
			const tail = opts.fail?.[c.name];
			const dur = c.name === 'test' ? 41 : c.name === 'typecheck' || c.name === 'check' || c.name === 'clippy' ? 14 : 4;
			this.at(dur, { _tag: 'CheckFinished', check: c.name, command: 'run', baseline: opts.baseline, round: opts.round, attempt: opts.attempt, exitCode: tail ? 1 : 0, durationMs: dur * 1000 + 312, outputTail: tail ?? '' });
			this.at(0, { _tag: 'LockReleased', resource: c.lock, check: c.name });
		}
		return this;
	}
	step(name: string, seconds: number, model: string, cost: number, outcome: 'ok' | 'failed' | 'timed-out' = 'ok', error?: string) {
		this.at(1, { _tag: 'StepStarted', step: name });
		this.at(seconds, { _tag: 'AgentCost', step: name, model, costUsd: cost });
		return this.at(0, { _tag: 'StepEnded', step: name, outcome, durationMs: seconds * 1000, ...(error ? { error } : {}) });
	}
}

const roundsFromLog = (events: RunEvent[]): CheckRound[] => {
	const rounds = new Map<string, CheckRound>();
	for (const e of events) {
		if (e._tag !== 'CheckFinished' || e.command !== 'run') continue;
		const key = `${e.baseline}:${e.round}:${e.attempt}`;
		const r = rounds.get(key) ?? { baseline: e.baseline, round: e.round, attempt: e.attempt, results: [] };
		r.results.push({ name: e.check, exitCode: e.exitCode, durationMs: e.durationMs, ...(e.exitCode ? { outputTail: e.outputTail } : {}) });
		rounds.set(key, r);
	}
	return [...rounds.values()];
};

const costOf = (events: RunEvent[]) =>
	events.reduce((t, e) => (e._tag === 'AgentCost' ? t + e.costUsd : t), 0);

const finding = (round: number, n: number, f: Omit<Finding, 'id' | 'round'>): Finding => ({ id: `f${round}-${n}`, round, ...f });

interface RunSeed {
	runId: string;
	kind: RunKind;
	project: Project;
	status: RunStatus;
	state: string;
	round: number;
	title: string;
	branch: string | null;
	planDir: string | null;
	prNumber: number | null;
	reviewId?: string | null;
	findings?: Finding[];
	disproved?: DisprovedFinding[];
	escalationReason?: Run['escalationReason'];
	error?: string | null;
	commits?: Run['commits'];
	diffStat: Run['diffStat'];
	log: Log;
}

const toRun = (s: RunSeed): Run => {
	const events = s.log.events;
	const prOpened = events.findLast((e) => e._tag === 'PrOpened');
	return {
		runId: s.runId,
		kind: s.kind,
		projectKey: s.project.key,
		cwd: s.project.path,
		status: s.status,
		state: s.state,
		round: s.round,
		createdAt: events[0].at,
		updatedAt: events.at(-1)!.at,
		branch: s.branch,
		planDir: s.planDir,
		title: s.title,
		prUrl: s.prNumber ? `https://${s.project.key}/pull/${s.prNumber}` : (prOpened?._tag === 'PrOpened' ? prOpened.url : null),
		prNumber: s.prNumber,
		reviewId: s.reviewId ?? null,
		costUsd: costOf(events),
		checks: roundsFromLog(events),
		findings: s.findings ?? [],
		disproved: s.disproved ?? [],
		escalationReason: s.escalationReason ?? null,
		error: s.error ?? null,
		events,
		commits: s.commits ?? [],
		diffStat: s.diffStat
	};
};

const [ship, storefront, billing] = projects;

// --- Runs ---------------------------------------------------------------------------------

// 1. ship: running, in review round 2.
const clefFindings1 = [
	finding(1, 1, { reviewer: 'error-handling', file: 'packages/core/src/router.ts', line: 88, severity: 'must-fix', claim: 'A Clef timeout is caught and turned into an empty reviewer set, so the round runs with no triggered reviewers at all.', evidence: '`Effect.catchAll(() => Effect.succeed([]))` replaces the whole selection, including the deterministic triggers computed on line 71.', verdict: 'traced: selectReviewers → routeWithClef → catchAll returns [] for both triggered and added reviewers.' }),
	finding(1, 2, { reviewer: 'tests', file: 'packages/core/test/router.test.ts', severity: 'must-fix', claim: 'No test covers Clef failing; the fallback path is untested.', evidence: 'The suite stubs Clef with a fixed success response in every case.', verdict: 'code reading: grep for `ClefUnavailable` in test/ finds nothing.' }),
	finding(1, 3, { reviewer: 'standards', file: 'packages/core/src/router.ts', line: 102, severity: 'nit', claim: 'Threshold 0.5 is a magic number repeated in two places.', evidence: '`p >= 0.5` on lines 102 and 131.', verdict: 'structural: two literal copies of one policy.' }),
	finding(1, 4, { reviewer: 'spec', file: 'packages/core/src/router.ts', line: 140, severity: 'tradeoff', claim: 'The plan says Clef may only add reviewers, but a reviewer disabled in config can now be re-added by Clef.', evidence: '`reviewers.disable` is applied before the Clef call, not after.', verdict: 'traced: disable filter runs on the triggered set only.' })
];
const log1 = new Log(34)
	.at(0, { _tag: 'RunCreated', branch: 'felix/clef-routing', planDir: '.plans/clef-routing', baseSha: sha('b2e7864') })
	.state(1, 'baseline.running')
	.checks(ship, { baseline: true, round: 0, attempt: 0 })
	.state(1, 'implement')
	.step('implement', 612, 'claude-opus-5-5', 3.84)
	.state(1, 'checks.running')
	.checks(ship, { baseline: false, round: 1, attempt: 0, fail: { typecheck: "packages/core/src/router.ts(97,15): error TS2345: Argument of type 'readonly ReviewerName[]' is not assignable to parameter of type 'ReviewerName[]'.\n  The type 'readonly ReviewerName[]' is 'readonly' and cannot be assigned to the mutable type 'ReviewerName[]'.\n\nFound 1 error in packages/core/src/router.ts:97" } })
	.step('check-fix', 74, 'claude-sonnet-5-5', 0.31)
	.checks(ship, { baseline: false, round: 1, attempt: 1 })
	.at(2, { _tag: 'CommitCreated', sha: sha('c1'), message: 'Route reviewer selection through Clef' })
	.state(1, 'review')
	.at(0, { _tag: 'ClefDecision', decision: 'reviewer routing', probability: 0.71, detail: 'added error-handling (p=0.71); risk routine → sonnet' })
	.at(1, { _tag: 'ReviewStarted', round: 1, fromSha: sha('b2e7864'), toSha: sha('c1'), reviewers: ['standards', 'spec', 'tests', 'error-handling', 'design'] })
	.at(48, { _tag: 'FindingsReported', round: 1, reviewer: 'standards', count: 2 })
	.at(12, { _tag: 'FindingsReported', round: 1, reviewer: 'tests', count: 1 })
	.at(20, { _tag: 'FindingsReported', round: 1, reviewer: 'error-handling', count: 1 })
	.at(31, { _tag: 'FindingsReported', round: 1, reviewer: 'spec', count: 2 })
	.at(40, { _tag: 'FindingsReported', round: 1, reviewer: 'design', count: 0 })
	.at(0, { _tag: 'AgentCost', step: 'review', model: 'claude-sonnet-5-5', costUsd: 1.12 })
	.at(55, { _tag: 'FindingsVerified', round: 1, verified: ['f1-1', 'f1-2', 'f1-3', 'f1-4'], disproved: 2 })
	.at(0, { _tag: 'AgentCost', step: 'verify', model: 'claude-sonnet-5-5', costUsd: 0.44 })
	.state(1, 'triage')
	.at(0, { _tag: 'ClefDecision', decision: 'lower must-fix', probability: 0.12, detail: 'kept f1-1, f1-2 as must-fix' })
	.at(1, { _tag: 'FindingsTriaged', round: 1, mustFix: ['f1-1', 'f1-2'], tradeoffs: ['f1-4'], nits: ['f1-3'] })
	.state(1, 'fix')
	.step('fix', 248, 'claude-sonnet-5-5', 0.92)
	.state(1, 'checks.running')
	.checks(ship, { baseline: false, round: 2, attempt: 0 })
	.at(2, { _tag: 'CommitCreated', sha: sha('c2'), message: 'Keep triggered reviewers when Clef fails' })
	.state(1, 'review')
	.at(1, { _tag: 'ReviewStarted', round: 2, fromSha: sha('c1'), toSha: sha('c2'), reviewers: ['standards', 'spec', 'tests', 'error-handling'] })
	.at(39, { _tag: 'FindingsReported', round: 2, reviewer: 'standards', count: 0 })
	.at(18, { _tag: 'FindingsReported', round: 2, reviewer: 'tests', count: 0 });

// 2. storefront: waiting on the db lock in checks.
const log2 = new Log(19)
	.at(0, { _tag: 'RunCreated', branch: 'mina/saved-carts', planDir: '.plans/saved-carts', baseSha: sha('sf-main') })
	.state(1, 'baseline.running')
	.checks(storefront, { baseline: true, round: 0, attempt: 0, fail: { lint: "src/routes/admin/+page.svelte\n  14:7  error  'unused' is assigned a value but never used  @typescript-eslint/no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)" } })
	.state(1, 'implement')
	.step('implement', 702, 'claude-opus-5-5', 4.61)
	.state(1, 'checks.running');
for (const c of storefront.checks.slice(0, 3)) {
	if (c.fix) {
		log2.at(1, { _tag: 'CheckStarted', check: c.name, command: 'fix', baseline: false, round: 1, attempt: 0, commandLine: c.fix });
		log2.at(2, { _tag: 'CheckFinished', check: c.name, command: 'fix', baseline: false, round: 1, attempt: 0, exitCode: 0, durationMs: 2100, outputTail: '' });
	}
	log2.at(1, { _tag: 'LockAcquired', resource: 'cpu', check: c.name, waitedMs: 0 });
	log2.at(0, { _tag: 'CheckStarted', check: c.name, command: 'run', baseline: false, round: 1, attempt: 0, commandLine: c.run });
	log2.at(9, { _tag: 'CheckFinished', check: c.name, command: 'run', baseline: false, round: 1, attempt: 0, exitCode: c.name === 'lint' ? 1 : 0, durationMs: 9120, outputTail: c.name === 'lint' ? "src/routes/admin/+page.svelte\n  14:7  error  'unused' is assigned a value but never used" : '' });
	log2.at(0, { _tag: 'LockReleased', resource: 'cpu', check: c.name });
}
log2.at(1, { _tag: 'LockWaiting', resource: 'db', check: 'test', position: 1 }).state(0, 'checks.waiting');

// 3. storefront: reviewing PR #412.
const log3 = new Log(6)
	.at(0, { _tag: 'ReviewRunCreated', prUrl: 'https://github.com/acme/storefront/pull/412', prNumber: 412, baseSha: sha('sf-412-base'), headSha: sha('sf-412-head') })
	.state(1, 'review')
	.at(0, { _tag: 'ClefDecision', decision: 'reviewer routing', probability: 0.83, detail: 'added security (p=0.83), ui-a11y by trigger; risk risky → opus' })
	.at(2, { _tag: 'ReviewStarted', round: 1, fromSha: sha('sf-412-base'), toSha: sha('sf-412-head'), reviewers: ['standards', 'spec', 'security', 'ui-a11y', 'tests', 'data'] })
	.at(64, { _tag: 'FindingsReported', round: 1, reviewer: 'ui-a11y', count: 3 })
	.at(22, { _tag: 'FindingsReported', round: 1, reviewer: 'standards', count: 1 })
	.at(40, { _tag: 'FindingsReported', round: 1, reviewer: 'data', count: 1 });

// 4. billing-api: escalated after the review cap.
const billingFindings = [
	finding(1, 1, { reviewer: 'data', file: 'migrations/0042_invoice_currency.sql', line: 3, severity: 'must-fix', claim: 'Adding a NOT NULL column without a default fails on the existing invoices table.', evidence: '`ALTER TABLE invoices ADD COLUMN currency char(3) NOT NULL;`', verdict: 'traced: production has rows; Postgres rejects the ALTER.' }),
	finding(2, 1, { reviewer: 'data', file: 'migrations/0042_invoice_currency.sql', line: 3, severity: 'must-fix', claim: 'Backfill runs after the constraint, so the migration still fails on existing rows.', evidence: 'The UPDATE on line 6 comes after the NOT NULL on line 3.', verdict: 'traced: same failure as round 1, reordered.', repeats: 'f1-1' }),
	finding(2, 2, { reviewer: 'error-handling', file: 'src/invoice/convert.rs', line: 57, severity: 'must-fix', claim: '`unwrap()` on the exchange-rate lookup panics the request handler when a currency is unknown.', evidence: '`let rate = rates.get(&cur).unwrap();`', verdict: 'traced: `currency` comes from the request body unvalidated.' }),
	finding(2, 3, { reviewer: 'spec', file: 'src/invoice/mod.rs', severity: 'tradeoff', claim: 'The plan asks for per-customer default currency; the change uses a global default.', evidence: '`DEFAULT_CURRENCY` constant, no customer lookup.', verdict: 'code reading: spec.md §2 vs mod.rs.' }),
	finding(2, 4, { reviewer: 'standards', file: 'src/invoice/convert.rs', line: 12, severity: 'nit', claim: 'Module doc restates the function names.', evidence: '`//! convert: converts`', verdict: 'structural.' })
];
const log4 = new Log(160)
	.at(0, { _tag: 'RunCreated', branch: 'jo/invoice-currency', planDir: '.plans/invoice-currency', baseSha: sha('bill-dev') })
	.state(1, 'baseline.running')
	.checks(billing, { baseline: true, round: 0, attempt: 0 })
	.state(1, 'implement')
	.step('implement', 940, 'claude-opus-5-5', 5.2)
	.state(1, 'checks.running')
	.checks(billing, { baseline: false, round: 1, attempt: 0, waitDb: 95 })
	.at(2, { _tag: 'CommitCreated', sha: sha('b1'), message: 'Store a currency on invoices' })
	.state(1, 'review')
	.at(1, { _tag: 'ReviewStarted', round: 1, fromSha: sha('bill-dev'), toSha: sha('b1'), reviewers: ['standards', 'spec', 'data', 'tests', 'error-handling'] })
	.at(120, { _tag: 'FindingsVerified', round: 1, verified: ['f1-1'], disproved: 1 })
	.at(0, { _tag: 'AgentCost', step: 'review', model: 'claude-sonnet-5-5', costUsd: 1.3 })
	.state(1, 'triage')
	.at(1, { _tag: 'FindingsTriaged', round: 1, mustFix: ['f1-1'], tradeoffs: [], nits: [] })
	.state(1, 'fix')
	.step('fix', 300, 'claude-sonnet-5-5', 0.88)
	.state(1, 'checks.running')
	.checks(billing, { baseline: false, round: 2, attempt: 0 })
	.at(2, { _tag: 'CommitCreated', sha: sha('b2'), message: 'Backfill invoice currency' })
	.state(1, 'review')
	.at(1, { _tag: 'ReviewStarted', round: 2, fromSha: sha('b1'), toSha: sha('b2'), reviewers: ['standards', 'spec', 'data', 'tests', 'error-handling'] })
	.at(140, { _tag: 'FindingsVerified', round: 2, verified: ['f2-1', 'f2-2', 'f2-3', 'f2-4'], disproved: 0 })
	.at(0, { _tag: 'AgentCost', step: 'review', model: 'claude-opus-5-5', costUsd: 2.4 })
	.state(1, 'triage')
	.at(1, { _tag: 'FindingsTriaged', round: 2, mustFix: ['f2-1', 'f2-2'], tradeoffs: ['f2-3'], nits: ['f2-4'] })
	.at(0, { _tag: 'Escalated', reason: 'review-cap' })
	.state(1, 'escalate')
	.at(4, { _tag: 'BranchPushed', sha: sha('b2'), remote: 'origin', ref: 'jo/invoice-currency' })
	.step('pr', 52, 'claude-haiku-5-5', 0.06)
	.at(1, { _tag: 'PrOpened', url: 'https://github.com/acme/billing-api/pull/88', draft: true })
	.state(0, 'escalated')
	.at(0, { _tag: 'RunFinished', status: 'escalated' });

// 5. ship: done, PR opened.
const log5 = new Log(1440 + 200)
	.at(0, { _tag: 'RunCreated', branch: 'felix/conventions', planDir: '.plans/conventions', baseSha: sha('8fb3117') })
	.state(1, 'baseline.running')
	.checks(ship, { baseline: true, round: 0, attempt: 0 })
	.state(1, 'implement')
	.step('implement', 1120, 'claude-opus-5-5', 6.02)
	.state(1, 'checks.running')
	.checks(ship, { baseline: false, round: 1, attempt: 0 })
	.at(2, { _tag: 'CommitCreated', sha: sha('d8480ad'), message: 'Add ship conventions and the ship-conventions skill' })
	.state(1, 'review')
	.at(1, { _tag: 'ReviewStarted', round: 1, fromSha: sha('8fb3117'), toSha: sha('d8480ad'), reviewers: ['standards', 'spec', 'comments', 'design', 'tests'] })
	.at(160, { _tag: 'FindingsVerified', round: 1, verified: ['f1-1'], disproved: 3 })
	.at(0, { _tag: 'AgentCost', step: 'review', model: 'claude-sonnet-5-5', costUsd: 1.4 })
	.state(1, 'triage')
	.at(1, { _tag: 'FindingsTriaged', round: 1, mustFix: [], tradeoffs: [], nits: ['f1-1'] })
	.state(1, 'pr')
	.at(3, { _tag: 'BranchPushed', sha: sha('d8480ad'), remote: 'origin', ref: 'felix/conventions' })
	.step('pr', 61, 'claude-haiku-5-5', 0.07)
	.at(1, { _tag: 'PrOpened', url: 'https://github.com/f-elix/ship/pull/26', draft: true })
	.state(0, 'done')
	.at(0, { _tag: 'RunFinished', status: 'done' });

// 6. storefront: fix run on PR #398, done.
const log6 = new Log(300)
	.at(0, { _tag: 'StateChanged', from: 'idle', to: 'fix' })
	.step('fix', 210, 'claude-sonnet-5-5', 0.74)
	.state(1, 'checks.running')
	.checks(storefront, { baseline: false, round: 1, attempt: 0 })
	.at(2, { _tag: 'CommitCreated', sha: sha('fx1'), message: 'Address review findings' })
	.at(3, { _tag: 'BranchPushed', sha: sha('fx1'), remote: 'origin', ref: 'dev/checkout-tax' })
	.state(0, 'done')
	.at(0, { _tag: 'RunFinished', status: 'done' });

// 7. ship: recheck of PR #25.
const log7 = new Log(1440 + 60)
	.at(0, { _tag: 'StateChanged', from: 'idle', to: 'recheck' })
	.step('recheck', 95, 'claude-sonnet-5-5', 0.33)
	.state(0, 'done')
	.at(0, { _tag: 'RunFinished', status: 'done' });

// 8. billing-api: failed, implement timed out.
const log8 = new Log(420)
	.at(0, { _tag: 'RunCreated', branch: 'jo/stripe-webhooks', planDir: '.plans/stripe-webhooks', baseSha: sha('bill-dev-2') })
	.state(1, 'baseline.running')
	.checks(billing, { baseline: true, round: 0, attempt: 0, fail: { test: "test invoice::tests::sends_receipt ... FAILED\n\nthread 'invoice::tests::sends_receipt' panicked at src/invoice/mail.rs:44:\nconnection refused (os error 61)\n\ntest result: FAILED. 211 passed; 1 failed" } })
	.state(1, 'implement')
	.step('implement', 1800, 'claude-opus-5-5', 7.9, 'timed-out', 'implement timed out after 30 minutes')
	.state(0, 'failed')
	.at(0, { _tag: 'RunFinished', status: 'failed' });

// 9. storefront: `ship checks`, interrupted by a daemon restart.
const log9 = new Log(95)
	.state(0, 'checks.running')
	.checks(storefront, { baseline: false, round: 1, attempt: 0, fail: { check: "src/lib/cart.ts:31:5\nError: Type 'string | undefined' is not assignable to type 'string'." } })
	.at(1, { _tag: 'StepStarted', step: 'check-fix' })
	.at(40, { _tag: 'RunInterrupted' });

// 10. ship: `ship implement`, cancelled.
const log10 = new Log(2900)
	.at(0, { _tag: 'StateChanged', from: 'idle', to: 'baseline.running' })
	.checks(ship, { baseline: true, round: 0, attempt: 0 })
	.state(1, 'implement')
	.at(1, { _tag: 'StepStarted', step: 'implement' })
	.at(200, { _tag: 'RunCancelled' })
	.at(0, { _tag: 'RunFinished', status: 'cancelled' });

export const runs: Run[] = [
	toRun({ runId: 'r-7k2m', kind: 'ship', project: ship, status: 'running', state: 'review', round: 2, title: 'Route reviewer selection through Clef', branch: 'felix/clef-routing', planDir: '.plans/clef-routing', prNumber: null, findings: clefFindings1, disproved: [
		{ reviewer: 'standards', file: 'packages/core/src/clef.ts', line: 20, claim: 'Credentials are read on every call.', reason: 'disproved: read once in the layer; the call site uses the cached value.', round: 1 },
		{ reviewer: 'spec', file: 'packages/core/src/router.ts', claim: 'Risk rating is never used.', reason: 'disproved: reviewModel() consumes it on line 151.', round: 1 }
	], commits: [{ sha: sha('c1'), message: 'Route reviewer selection through Clef' }, { sha: sha('c2'), message: 'Keep triggered reviewers when Clef fails' }], diffStat: { files: 9, additions: 412, deletions: 88 }, log: log1 }),
	toRun({ runId: 'r-9q4x', kind: 'ship', project: storefront, status: 'waiting', state: 'checks.waiting', round: 1, title: 'Add saved carts', branch: 'mina/saved-carts', planDir: '.plans/saved-carts', prNumber: null, diffStat: { files: 14, additions: 803, deletions: 41 }, log: log2 }),
	toRun({ runId: 'r-3vb8', kind: 'review', project: storefront, status: 'running', state: 'review', round: 1, title: 'Checkout: apply regional tax rules', branch: 'dev/checkout-tax', planDir: null, prNumber: 412, diffStat: { files: 22, additions: 1290, deletions: 310 }, log: log3 }),
	toRun({ runId: 'r-1hn5', kind: 'ship', project: billing, status: 'escalated', state: 'escalated', round: 2, title: 'Store a currency on invoices', branch: 'jo/invoice-currency', planDir: '.plans/invoice-currency', prNumber: 88, findings: billingFindings, escalationReason: 'review-cap', commits: [{ sha: sha('b1'), message: 'Store a currency on invoices' }, { sha: sha('b2'), message: 'Backfill invoice currency' }], diffStat: { files: 6, additions: 220, deletions: 12 }, log: log4 }),
	toRun({ runId: 'r-6tp0', kind: 'ship', project: ship, status: 'done', state: 'done', round: 1, title: 'Add ship conventions and the ship-conventions skill', branch: 'felix/conventions', planDir: '.plans/conventions', prNumber: 26, findings: [finding(1, 1, { reviewer: 'comments', file: 'packages/core/src/conventions/README.md', line: 9, severity: 'nit', claim: 'README says "four" topics; there are eleven.', evidence: 'Line 9.', verdict: 'code reading.' })], commits: [{ sha: sha('d8480ad'), message: 'Add ship conventions and the ship-conventions skill' }], diffStat: { files: 31, additions: 2410, deletions: 120 }, log: log5 }),
	toRun({ runId: 'r-2fd9', kind: 'fix', project: storefront, status: 'done', state: 'done', round: 1, title: 'Checkout: apply regional tax rules', branch: 'dev/checkout-tax', planDir: null, prNumber: 398, commits: [{ sha: sha('fx1'), message: 'Address review findings' }], diffStat: { files: 4, additions: 61, deletions: 23 }, log: log6 }),
	toRun({ runId: 'r-8wc3', kind: 'recheck', project: ship, status: 'done', state: 'done', round: 0, title: 'Retry transient agent failures', branch: 'felix/retry', planDir: null, prNumber: 25, diffStat: { files: 0, additions: 0, deletions: 0 }, log: log7 }),
	toRun({ runId: 'r-4ze1', kind: 'ship', project: billing, status: 'failed', state: 'failed', round: 0, title: 'Handle Stripe webhooks', branch: 'jo/stripe-webhooks', planDir: '.plans/stripe-webhooks', prNumber: null, error: 'implement timed out after 30 minutes', diffStat: { files: 0, additions: 0, deletions: 0 }, log: log8 }),
	toRun({ runId: 'r-5yu7', kind: 'checks', project: storefront, status: 'interrupted', state: 'checks.running', round: 1, title: 'Fix failing checks on mina/cart-types', branch: 'mina/cart-types', planDir: null, prNumber: null, diffStat: { files: 3, additions: 18, deletions: 9 }, log: log9 }),
	toRun({ runId: 'r-0ma2', kind: 'implement', project: ship, status: 'cancelled', state: 'cancelled', round: 0, title: 'Rename primitive to step', branch: 'felix/step-rename', planDir: '.plans/step-rename', prNumber: null, diffStat: { files: 0, additions: 0, deletions: 0 }, log: log10 })
];

export const runById = (id: string) => runs.find((r) => r.runId === id);
export const projectByKey = (key: string) => projects.find((p) => p.key === key);
export const activeRuns = () => runs.filter((r) => r.status === 'running' || r.status === 'waiting');
/** Runs that want a human: escalated, failed or interrupted. */
export const attentionRuns = () =>
	runs.filter((r) => r.status === 'escalated' || r.status === 'failed' || r.status === 'interrupted');

// --- Daemon, locks, plans, PRs ------------------------------------------------------------

export const daemon: DaemonInfo = {
	version: '0.9.0',
	pid: 48213,
	socket: '~/.ship/daemon.sock',
	log: '~/.ship/daemon.log',
	startedAt: ago(60 * 26),
	clefConfigured: true
};

export const locks: LockResource[] = [
	{ name: 'cpu', permits: 4, held: [{ runId: 'r-3vb8', check: 'review', since: ago(1) }], queue: [] },
	{
		name: 'db',
		permits: 1,
		held: [{ runId: 'ext:init', check: 'test (ship init --write, billing-api)', since: ago(2) }],
		queue: [{ runId: 'r-9q4x', check: 'test', since: ago(1) }]
	}
];

export const plans: PlanDir[] = [
	{
		path: '.plans/daemon-metrics',
		project: ship.key,
		title: 'Expose daemon metrics over RPC',
		branch: 'felix/daemon-metrics',
		updatedAt: ago(45),
		spec: '# Expose daemon metrics over RPC\n\nThe UI needs lock queue depth, active runs and Clef latency without tailing daemon.log.\n\n## Requirements\n\n- A `metrics` RPC returning lock permits, holders and queues.\n- Clef call latency as a p50/p95 over the last hour.\n- No new dependencies.',
		plan: '1. Add `Metrics` schema to contract.ts.\n2. Track lock holders in locks.ts.\n3. Add a ring buffer for Clef latencies.\n4. Wire the RPC in daemon handlers.\n5. Tests for each.'
	},
	{
		path: '.plans/guest-checkout',
		project: storefront.key,
		title: 'Guest checkout',
		branch: 'mina/guest-checkout',
		updatedAt: ago(130),
		spec: '# Guest checkout\n\nLet shoppers buy without an account. Email is required; an account can be created after purchase.',
		plan: '1. Make `customerId` optional on orders.\n2. Add an email step.\n3. Post-purchase account prompt.\n4. Migrate existing orders (no-op).'
	},
	{
		path: '.plans/refund-api',
		project: billing.key,
		title: 'Partial refunds',
		branch: 'jo/partial-refunds',
		updatedAt: ago(60 * 20),
		spec: '# Partial refunds\n\nSupport refunding part of an invoice, per line item.',
		plan: '1. `refunds` table.\n2. POST /invoices/:id/refunds.\n3. Ledger entries.'
	}
];

export const openPrs: OpenPr[] = [
	{ project: storefront.key, number: 412, title: 'Checkout: apply regional tax rules', author: 'dev-amir', headRef: 'dev/checkout-tax', updatedAt: ago(8), unresolvedThreads: 4, lastShipReview: 'r-3vb8' },
	{ project: storefront.key, number: 409, title: 'Upgrade to SvelteKit 3.4', author: 'renovate[bot]', headRef: 'renovate/sveltekit', updatedAt: ago(200), unresolvedThreads: 0, lastShipReview: null },
	{ project: ship.key, number: 28, title: 'Daemon: report lock holders', author: 'f-elix', headRef: 'felix/lock-holders', updatedAt: ago(90), unresolvedThreads: 2, lastShipReview: null },
	{ project: billing.key, number: 88, title: 'Store a currency on invoices', author: 'jo-b', headRef: 'jo/invoice-currency', updatedAt: ago(118), unresolvedThreads: 3, lastShipReview: 'r-1hn5' }
];

/** The global config, ~/.ship/config.json. */
export const globalConfig = {
	locks: { cpu: 4, db: 1 },
	models: { implement: 'opus', fix: 'sonnet', review: 'sonnet', reviewTrivial: 'haiku', reviewRisky: 'opus', verify: 'sonnet', pr: 'haiku' },
	caps: { checkFixAttempts: 3, reviewRounds: 3 },
	timeouts: { baseline: '10 minutes', implement: '30 minutes', review: '15 minutes' }
};

/** Daily cost over the last 14 days, oldest first, in USD. */
export const dailyCost = [4.1, 12.6, 9.3, 0, 0, 18.2, 22.7, 14.9, 7.4, 11.1, 0, 3.2, 19.8, 16.3];
