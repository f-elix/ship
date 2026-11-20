/**
 * The run contexts and summaries of `ship fix` and `ship recheck`: runs over a pull
 * request's findings, in the caller's checkout at the PR's head.
 */
import { Schema } from 'effect';
import { VerifiedFinding } from './finding.ts';
import { PushTarget } from './pr-branch.ts';
import { primitiveScopeFields } from './primitive-scope.ts';
import { CostUsd, GitSha, PositiveInt, Url } from './primitives.ts';
import { ChangeIntent } from './reviewers.ts';
import { checkRounds, ofTag, type SummaryInput } from './run-summary.ts';
import {
	AgentSession,
	CheckRound,
	RecheckedFinding,
	type FixSummary,
	type RecheckSummary
} from './run.ts';

/** The pull request a run works on, as it was when the run was created. */
export const TargetPr = Schema.Struct({
	number: PositiveInt,
	url: Url,
	/** The PR's head, pinned when the run was created; resuming never refetches it. */
	headSha: GitSha
});
export interface TargetPr extends Schema.Schema.Type<typeof TargetPr> {}

/**
 * The context of a `ship fix` run, persisted in snapshots like `RunState`. `cwd` is the
 * caller's checkout; `baseSha` is `pr.headSha`, so the checks see only the fix's changes.
 */
export const FixRunState = Schema.Struct({
	...primitiveScopeFields,
	kind: Schema.Literal('fix'),
	pr: TargetPr,
	/** The must-fix findings and nits the fix agent works through. */
	findings: Schema.Array(VerifiedFinding),
	/** Where the commits go; `null` with `--local`, which keeps them local. */
	push: Schema.NullOr(PushTarget),
	/** `false` with `--no-checks`: the work is committed without running the checks. */
	runChecks: Schema.Boolean,
	/** Started by `fix`; the check fixes resume it. */
	implementerSession: Schema.NullOr(AgentSession),
	checks: Schema.Array(CheckRound),
	/** Running cost for display while the run is live; the summary sums `AgentCost` events. */
	costUsd: CostUsd,
	/** Why the run failed; set only when it ends `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface FixRunState extends Schema.Schema.Type<typeof FixRunState> {}

/** What a fix run starts from; {@link initialFixRunState} fills in the rest. */
export type NewFixRunState = Pick<
	FixRunState,
	'runId' | 'projectKey' | 'cwd' | 'env' | 'config' | 'pr' | 'findings' | 'push' | 'runChecks'
>;

/** The context of a fix run that has not taken a step yet. */
export const initialFixRunState = (start: NewFixRunState): FixRunState => ({
	...start,
	kind: 'fix',
	baseSha: start.pr.headSha,
	implementerSession: null,
	checks: [],
	costUsd: 0,
	error: null
});

/**
 * The context of a `ship recheck` run. `cwd` is the caller's checkout at `pr.headSha`;
 * `baseSha` is the merge base of the PR's base branch and its head, as for `ship review`.
 */
export const RecheckRunState = Schema.Struct({
	...primitiveScopeFields,
	kind: Schema.Literal('recheck'),
	pr: TargetPr,
	/** What the change sets out to do; the verifier reads the findings against it. */
	intent: ChangeIntent,
	/** The must-fix findings and nits to check again. */
	findings: Schema.Array(VerifiedFinding),
	/** The open review thread of each finding that has one, by finding id. */
	threads: Schema.Record(Schema.String, Schema.String),
	/** `false` with `--local`: no thread is resolved on GitHub. */
	resolve: Schema.Boolean,
	/** What `recheck` found; `null` until it ends. */
	rechecked: Schema.NullOr(Schema.Array(RecheckedFinding)),
	/** Running cost for display while the run is live; the summary sums `AgentCost` events. */
	costUsd: CostUsd,
	/** Why the run failed; set only when it ends `failed`. */
	error: Schema.NullOr(Schema.String)
});
export interface RecheckRunState extends Schema.Schema.Type<typeof RecheckRunState> {}

/** What a recheck run starts from; {@link initialRecheckRunState} fills in the rest. */
export type NewRecheckRunState = Pick<
	RecheckRunState,
	| 'runId'
	| 'projectKey'
	| 'cwd'
	| 'env'
	| 'config'
	| 'baseSha'
	| 'pr'
	| 'intent'
	| 'findings'
	| 'threads'
	| 'resolve'
>;

/** The context of a recheck run that has not taken a step yet. */
export const initialRecheckRunState = (start: NewRecheckRunState): RecheckRunState => ({
	...start,
	kind: 'recheck',
	rechecked: null,
	costUsd: 0,
	error: null
});

const costOf = (input: SummaryInput) =>
	ofTag(input.events, 'AgentCost').reduce((total, event) => total + event.costUsd, 0);

/**
 * A fix run's summary, built from its event log: the PR, the findings and the ignored
 * threads from `PrRunCreated`, the commits from `CommitCreated` and whether it pushed from
 * `BranchPushed`.
 */
export const buildFixSummary = (input: SummaryInput): FixSummary => {
	const created = ofTag(input.events, 'PrRunCreated')[0];
	return {
		kind: 'fix',
		runId: input.runId,
		status: input.status,
		prUrl: created?.prUrl ?? '',
		findings: created?.findings ?? [],
		ignoredThreads: created?.ignoredThreads ?? [],
		commits: [...new Set(ofTag(input.events, 'CommitCreated').map((event) => event.sha))],
		pushed: ofTag(input.events, 'BranchPushed').length > 0,
		checks: checkRounds(input.events),
		costUsd: costOf(input),
		error: input.status === 'failed' ? input.error : null
	};
};

/**
 * A recheck run's summary, built from its event log: the PR and the ignored threads from
 * `PrRunCreated`, each finding's status from the latest `FindingsRechecked`, and the
 * threads `ThreadResolved` reports.
 */
export const buildRecheckSummary = (input: SummaryInput): RecheckSummary => {
	const created = ofTag(input.events, 'PrRunCreated')[0];
	return {
		kind: 'recheck',
		runId: input.runId,
		status: input.status,
		prUrl: created?.prUrl ?? '',
		findings: ofTag(input.events, 'FindingsRechecked').at(-1)?.findings ?? [],
		resolvedThreads: [
			...new Set(ofTag(input.events, 'ThreadResolved').map((event) => event.threadId))
		],
		ignoredThreads: created?.ignoredThreads ?? [],
		costUsd: costOf(input),
		error: input.status === 'failed' ? input.error : null
	};
};
