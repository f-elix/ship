// Mirrors the shapes in packages/core/src (event.ts, run.ts, rpc.ts, finding.ts, config.ts).
// The prototypes never talk to ship; these types keep the mock data honest to the real contract.

export type RunStatus =
	| 'running'
	| 'waiting'
	| 'done'
	| 'escalated'
	| 'failed'
	| 'cancelled'
	| 'interrupted';

export type RunKind = 'ship' | 'review' | 'fix' | 'recheck' | 'implement' | 'checks' | 'pr' | 'post';

export type EscalationReason =
	| 'check-fix-cap'
	| 'checks-unrelated'
	| 'review-cap'
	| 'stall'
	| 'timeout';

export type Severity = 'must-fix' | 'tradeoff' | 'nit';

/** The `ship run` pipeline's top-level states, in the order a clean run visits them. */
export const PIPELINE_STATES = [
	'baseline',
	'implement',
	'checks',
	'review',
	'triage',
	'fix',
	'pr'
] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number] | 'escalate';

export interface Finding {
	id: string;
	reviewer: string;
	file: string;
	line?: number;
	severity: Severity;
	claim: string;
	evidence: string;
	/** Verifier's reason, starting with `traced`, `structural` or `code reading`. */
	verdict: string;
	/** Set when the same problem was reported in an earlier round. */
	repeats?: string;
	round: number;
}

export interface DisprovedFinding {
	reviewer: string;
	file: string;
	line?: number;
	claim: string;
	reason: string;
	round: number;
}

export interface CheckResult {
	name: string;
	exitCode: number;
	durationMs: number;
	outputTail?: string;
}

export interface CheckRound {
	baseline: boolean;
	round: number;
	attempt: number;
	results: CheckResult[];
}

/** One event of the run's log, as `ship logs --json` would print it (envelope flattened). */
export type RunEvent = { seq: number; at: string } & (
	| { _tag: 'RunCreated'; branch: string; planDir: string; baseSha: string }
	| { _tag: 'ReviewRunCreated'; prUrl: string; prNumber: number; baseSha: string; headSha: string }
	| { _tag: 'StateChanged'; from: string; to: string }
	| { _tag: 'StepStarted'; step: string }
	| {
			_tag: 'StepEnded';
			step: string;
			outcome: 'ok' | 'failed' | 'timed-out' | 'interrupted';
			durationMs: number;
			error?: string;
	  }
	| {
			_tag: 'CheckStarted';
			check: string;
			command: 'run' | 'fix';
			baseline: boolean;
			round: number;
			attempt: number;
			commandLine: string;
	  }
	| {
			_tag: 'CheckFinished';
			check: string;
			command: 'run' | 'fix';
			baseline: boolean;
			round: number;
			attempt: number;
			exitCode: number;
			durationMs: number;
			outputTail: string;
	  }
	| { _tag: 'LockWaiting'; resource: string; check: string; position?: number }
	| { _tag: 'LockAcquired'; resource: string; check: string; waitedMs: number }
	| { _tag: 'LockReleased'; resource: string; check: string }
	| { _tag: 'ReviewStarted'; round: number; fromSha: string; toSha: string; reviewers: string[] }
	| { _tag: 'FindingsReported'; round: number; reviewer: string; count: number }
	| { _tag: 'FindingsVerified'; round: number; verified: string[]; disproved: number }
	| { _tag: 'FindingsTriaged'; round: number; mustFix: string[]; tradeoffs: string[]; nits: string[] }
	// Not a RunEvent today: Clef decisions go to daemon.log and the step checkpoint. Shown here
	// because a UI would want them in the timeline.
	| { _tag: 'ClefDecision'; decision: string; probability: number; detail: string }
	| { _tag: 'Escalated'; reason: EscalationReason }
	| { _tag: 'AgentCost'; step: string; model: string; costUsd: number }
	| { _tag: 'CommitCreated'; sha: string; message: string }
	| { _tag: 'BranchPushed'; sha: string; remote: string; ref: string }
	| { _tag: 'PrOpened'; url: string; draft: boolean }
	| { _tag: 'ReviewStored'; reviewId: string }
	| {
			_tag: 'PrReviewPosted';
			url: string;
			event: 'COMMENT' | 'REQUEST_CHANGES';
			inline: number;
			inBody: number;
	  }
	| { _tag: 'RunFinished'; status: RunStatus }
	| { _tag: 'RunInterrupted' }
	| { _tag: 'RunResumed' }
	| { _tag: 'RunCancelled' }
);

export type RunEventTag = RunEvent['_tag'];

export interface Run {
	runId: string;
	kind: RunKind;
	projectKey: string;
	cwd: string;
	status: RunStatus;
	/** Machine state as a dotted path, e.g. `checks.waiting`. */
	state: string;
	round: number;
	createdAt: string;
	updatedAt: string;
	branch: string | null;
	planDir: string | null;
	/** Title of the plan (first heading of spec.md) or the PR. */
	title: string;
	prUrl: string | null;
	prNumber: number | null;
	reviewId: string | null;
	costUsd: number;
	checks: CheckRound[];
	findings: Finding[];
	disproved: DisprovedFinding[];
	escalationReason: EscalationReason | null;
	error: string | null;
	events: RunEvent[];
	commits: { sha: string; message: string }[];
	diffStat: { files: number; additions: number; deletions: number };
}

export interface CheckConfig {
	name: string;
	run: string;
	fix?: string;
	lock: string;
}

export interface Project {
	key: string;
	name: string;
	path: string;
	defaultBranch: string;
	checks: CheckConfig[];
	format?: string;
	reviewersDisabled: string[];
	clef: boolean;
	pr: { draft: boolean; squash: boolean };
	models: Record<string, string>;
	caps: { checkFixAttempts: number; reviewRounds: number };
	/** Convention topics that apply to the repo's stack. */
	conventions: string[];
}

export interface Reviewer {
	name: string;
	description: string;
	model?: 'haiku' | 'sonnet' | 'opus';
	triggers: string;
}

export interface LockResource {
	name: string;
	permits: number;
	held: { runId: string; check: string; since: string }[];
	queue: { runId: string; check: string; since: string }[];
}

export interface DaemonInfo {
	version: string;
	pid: number;
	socket: string;
	log: string;
	startedAt: string;
	clefConfigured: boolean;
}

export interface PlanDir {
	path: string;
	project: string;
	title: string;
	branch: string;
	spec: string;
	plan: string;
	updatedAt: string;
}

export interface OpenPr {
	project: string;
	number: number;
	title: string;
	author: string;
	headRef: string;
	updatedAt: string;
	unresolvedThreads: number;
	lastShipReview: string | null;
}
