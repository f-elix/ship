import { Data, Effect, Queue, Schema, Stream } from 'effect';
import {
	Agent,
	type AgentCallCost,
	type AgentError,
	type AgentRunInput,
	type AgentShape
} from './agent.ts';
import { baselinePass, Checks, filesForChecks } from './checks.ts';
import type { CheckEvent } from './event.ts';
import type { VerifiedFinding } from './finding.ts';
import { Git, type CommitRange } from './git.ts';
import { Pr } from './pr.ts';
import type { Step } from './primitives.ts';
import { reviewChanges, Reviewers, type AgentContext } from './reviewers.ts';
import {
	runStep,
	StepNotReady,
	type RunReporter,
	type StepError,
	type StepKit,
	type StepOutcome
} from './run-step.ts';
import {
	CommitSubject,
	type AgentSession,
	type CheckRound,
	type EscalationReason,
	type ReviewInProgress,
	type RunState,
	type UnresolvedFindings
} from './run.ts';
import { PLAN_FILES, ShipHome } from './ship-paths.ts';

// --- Shared helpers ---

const specPath = (state: RunState) => `${state.planDir}/${PLAN_FILES.spec}`;
const planPath = (state: RunState) => `${state.planDir}/${PLAN_FILES.plan}`;
const planName = (state: RunState) => state.planDir.slice(state.planDir.lastIndexOf('/') + 1);

/**
 * The message of the round's commit, and of the single commit a squash leaves. Round 0
 * uses the implementer's subject, or `Implement <plan name>` when it gave none.
 */
export const commitMessage = (state: RunState): string =>
	state.round === 0
		? (state.commitSubject ?? `Implement ${planName(state)}`)
		: `Address review round ${state.round} findings`;

/** Every check passed. */
export const checksPassed = (round: CheckRound): boolean =>
	round.results.every((result) => result.exitCode === 0);

const agentContext = Effect.fnUntraced(function* (state: RunState) {
	const home = yield* ShipHome;
	return {
		cwd: state.cwd,
		env: state.env,
		transcript: { dir: home.transcripts(state.runId) }
	} satisfies AgentContext;
});

/** Runs the project's format command on the run's changed files, if it has one. */
const formatChanges = Effect.fnUntraced(function* (state: RunState) {
	if (state.config.format === null) return;
	const git = yield* Git;
	const checks = yield* Checks;
	const changed = yield* git.changedFiles(state, { from: state.baseSha });
	const result = yield* checks.format({
		cwd: state.cwd,
		env: state.env,
		command: state.config.format,
		files: filesForChecks(changed)
	});
	if (result !== null && result.exitCode !== 0) {
		yield* Effect.logWarning(`The format command exited with ${result.exitCode}`);
	}
});

/** What an implementer call produced: its session and cost, and the step's output. */
interface ImplementerReply<A> {
	readonly session: AgentSession;
	readonly cost: AgentCallCost;
	readonly value: A;
}

type ImplementerAsk<A> = (
	agent: AgentShape,
	input: AgentRunInput
) => Effect.Effect<ImplementerReply<A>, AgentError>;

/** An implementer call whose answer is only its work on the tree. */
const askPlain: ImplementerAsk<void> = (agent, input) =>
	Effect.map(agent.run(input), (result) => ({
		session: result.session,
		cost: result.cost,
		value: undefined
	}));

/** What `implement` answers alongside its work. */
const ImplementOutput = Schema.Struct({ commitSubject: CommitSubject });

/**
 * Asks the implementer for its work and a commit subject. A missing or invalid subject
 * does not fail the step: the call is still billed and its session kept, and the
 * subject is `null` so the commit falls back to the default message.
 */
const askWithSubject: ImplementerAsk<CommitSubject | null> = (agent, input) =>
	agent.runStructured(input, ImplementOutput).pipe(
		Effect.map((result): ImplementerReply<CommitSubject | null> => ({
			session: result.session,
			cost: result.cost,
			value: result.output.commitSubject
		})),
		Effect.catchTag('AgentOutputMismatch', (error) =>
			error.spend === undefined
				? Effect.fail(error)
				: Effect.as(
						Effect.logWarning(
							`The implementer gave no valid commit subject: ${error.detail}`
						),
						{ session: error.spend.session, cost: error.spend.cost, value: null }
					)
		)
	);

/**
 * One implementer call (`implement`, `fixChecks` or `fix`): resumes the implementer
 * session when there is one, keeps the new session, then formats the changes.
 */
const implementerCall = <A>(
	step: 'implement' | 'fixChecks' | 'fix',
	state: RunState,
	prompt: string,
	ask: ImplementerAsk<A>
) =>
	runStep(step, state, { timeoutMs: state.config.timeouts[step] }, (kit) =>
		Effect.gen(function* () {
			const agent = yield* Agent;
			const context = yield* agentContext(state);
			const input: AgentRunInput = {
				step,
				prompt,
				model:
					step === 'implement' ? state.config.models.implement : state.config.models.fix,
				access: 'edit',
				...(state.implementerSession === null ? {} : { resume: state.implementerSession }),
				cwd: context.cwd,
				env: context.env,
				additionalDirectories: [state.planDir],
				timeoutMs: state.config.timeouts[step],
				transcript: context.transcript
			};
			const reply = yield* ask(agent, input);
			yield* kit.recordCost(reply.cost);
			yield* kit.recordSession(reply.session);
			yield* formatChanges(state);
			return reply.value;
		})
	);

const IMPLEMENTER_RULES = [
	'- Work in the current directory on the current branch.',
	'- Leave your changes uncommitted; ship commits them after the checks pass.',
	'- Never edit or commit the spec or the plan.',
	'- If part of the work is already done, for example by an earlier interrupted attempt, continue from it.'
].join('\n');

// --- Checks ---

/** What the checks stream logic sends its parent: lock waits and then the outcome. */
export type ChecksEvent =
	| { readonly type: 'lock.waiting' }
	| { readonly type: 'lock.acquired' }
	| { readonly type: 'checks.done'; readonly outcome: StepOutcome<CheckRound> };

/**
 * A checks step as events: `lock.waiting` and `lock.acquired` as the checks wait for and
 * get their lock, then `checks.done`. Each command's timeout starts once its lock is held.
 */
const checksEvents = <R>(
	step: 'baseline' | 'checks',
	state: RunState,
	body: (
		kit: StepKit,
		onEvent: (event: CheckEvent) => Effect.Effect<void>
	) => Effect.Effect<CheckRound, StepError, R>
) =>
	Stream.callback<ChecksEvent, never, R | Git | RunReporter>((queue) =>
		Effect.gen(function* () {
			const outcome = yield* runStep(step, state, { timeoutMs: null }, (kit) =>
				body(kit, (event) =>
					Effect.andThen(
						kit.emit(event),
						event._tag === 'LockWaiting'
							? Queue.offer(queue, { type: 'lock.waiting' })
							: event._tag === 'LockAcquired'
								? Queue.offer(queue, { type: 'lock.acquired' })
								: Effect.void
					)
				)
			);
			yield* Queue.offer(queue, { type: 'checks.done', outcome });
			yield* Queue.end(queue);
		})
	);

/**
 * Checks the run can start in place (plan dir excluded from git, clean tree, HEAD still
 * at the base), then runs every check on the base commit.
 */
export const baselineStep = (state: RunState) =>
	checksEvents('baseline', state, (_kit, onEvent) =>
		Effect.gen(function* () {
			const git = yield* Git;
			const checks = yield* Checks;
			yield* git.excludePath(state, state.planDir);
			if (!(yield* git.isClean(state))) {
				return yield* new StepNotReady({
					reason: 'The working tree has uncommitted changes; commit or stash them first'
				});
			}
			const head = yield* git.headSha(state);
			if (head !== state.baseSha) {
				return yield* new StepNotReady({
					reason: `HEAD moved from ${state.baseSha} to ${head} before the baseline checks`
				});
			}
			return yield* checks.run(
				baselinePass({ cwd: state.cwd, env: state.env, config: state.config, onEvent })
			);
		})
	);

/** Runs the checks on the run's changed files and commits the work when they all pass. */
export const checksStep = (state: RunState) =>
	checksEvents('checks', state, (kit, onEvent) =>
		Effect.gen(function* () {
			const git = yield* Git;
			const checks = yield* Checks;
			const changed = yield* git.changedFiles(state, { from: state.baseSha });
			const round = yield* checks.run({
				cwd: state.cwd,
				env: state.env,
				checks: state.config.checks,
				files: filesForChecks(changed),
				pass: { baseline: false, round: state.round, attempt: state.checkFixAttempts },
				timeoutMs: state.config.timeouts.checks,
				onEvent
			});
			if (!checksPassed(round)) return round;
			const message = commitMessage(state);
			const sha = yield* git.commit(state, message);
			if (sha !== null) yield* kit.report({ _tag: 'CommitCreated', sha, message });
			return round;
		})
	);

// --- Implementer steps ---

export const implementStep = (state: RunState) =>
	implementerCall(
		'implement',
		state,
		[
			'Implement the planned change described by these files:',
			'',
			`- Spec: ${specPath(state)}`,
			`- Implementation plan: ${planPath(state)}`,
			'',
			'Read both, then implement the whole plan, with tests where the plan or the project calls for them.',
			'',
			IMPLEMENTER_RULES,
			'',
			'When you are done, answer with `commitSubject`: the subject line of the commit for this change. Write it in the imperative mood, at most 72 characters, with no trailing period, saying what the change does (e.g. "Add retry to webhook delivery").'
		].join('\n'),
		askWithSubject
	);

/** Resumes the implementer with the failing checks of the latest pass. */
export const fixChecksStep = (state: RunState) => {
	const failing = (state.checks.at(-1)?.results ?? []).filter((result) => result.exitCode !== 0);
	return implementerCall(
		'fixChecks',
		state,
		[
			'These checks fail after your changes. Fix the causes in the code; never weaken or skip a check.',
			'',
			...failing.flatMap((result) => [
				`## ${result.name} (exit code ${result.exitCode})`,
				'',
				'```',
				result.outputTail ?? '',
				'```',
				''
			]),
			IMPLEMENTER_RULES
		].join('\n'),
		askPlain
	);
};

const describeFinding = (finding: VerifiedFinding): string =>
	[
		`## ${finding.id}: ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}`,
		'',
		finding.claim,
		'',
		`Evidence: ${finding.evidence}`
	].join('\n');

/** Resumes the implementer with the verified must-fix findings of the latest review. */
export const fixStep = (state: RunState) =>
	implementerCall(
		'fix',
		state,
		[
			'Reviewers found these problems in your changes, and each was verified against the code. Fix every one.',
			'',
			...state.unresolved.mustFix.map(describeFinding),
			'',
			IMPLEMENTER_RULES
		].join('\n'),
		askPlain
	);

// --- Review ---

const missingReview = new StepNotReady({ reason: 'No review round is in progress' });

const reviewSubject = (state: RunState, range: CommitRange) =>
	Effect.map(reviewChanges(state, range), (changes) => ({
		diff: changes.diff,
		commits: changes.commits,
		specPath: specPath(state),
		planPath: planPath(state)
	}));

const loadReviewers = Effect.fnUntraced(function* (state: RunState) {
	const reviewers = yield* Reviewers;
	const home = yield* ShipHome;
	return yield* reviewers.load({
		projectDir: home.projectReviewers(state.projectKey),
		disable: state.config.reviewers.disable
	});
});

/**
 * Picks the reviewers for the range under review: `base..HEAD` in round 1, then
 * `lastReviewedSha..HEAD`, and starts the round.
 */
export const routeStep = (state: RunState) =>
	runStep('route', state, { timeoutMs: null }, (kit) =>
		Effect.gen(function* () {
			const git = yield* Git;
			const reviewers = yield* Reviewers;
			const fromSha = state.lastReviewedSha ?? state.baseSha;
			const toSha = yield* git.headSha(state);
			const changes = yield* reviewChanges(state, { from: fromSha, to: toSha });
			const routed = yield* reviewers.route({
				reviewers: yield* loadReviewers(state),
				changes,
				llm: state.config.reviewers.llmRouter
					? {
							model: state.config.models.route,
							timeoutMs: state.config.timeouts.route,
							context: yield* agentContext(state)
						}
					: null
			});
			yield* Effect.forEach(routed.costs, kit.recordCost, { discard: true });
			if (routed.llmError !== null) {
				yield* Effect.logWarning(`The LLM router failed: ${routed.llmError.message}`);
			}
			const names = routed.reviewers.map((picked) => picked.reviewer.name);
			yield* kit.report({
				_tag: 'ReviewStarted',
				round: state.round,
				fromSha,
				toSha,
				reviewers: names
			});
			return {
				round: state.round,
				fromSha,
				toSha,
				reviewers: names,
				findings: []
			} satisfies ReviewInProgress;
		})
	);

/**
 * Runs the round's reviewers. Each reviewer call has its own timeout, so the step has
 * none: reviewers run in batches and the step can rightly outlast one call.
 */
export const reviewStep = (state: RunState) =>
	runStep('review', state, { timeoutMs: null }, (kit) =>
		Effect.gen(function* () {
			const review = state.review;
			if (review === null) return yield* missingReview;
			const reviewers = yield* Reviewers;
			const picked = (yield* loadReviewers(state)).filter((def) =>
				review.reviewers.includes(def.name)
			);
			const reports = yield* reviewers.review({
				...(yield* reviewSubject(state, { from: review.fromSha, to: review.toSha })),
				reviewers: picked,
				model: state.config.models.review,
				timeoutMs: state.config.timeouts.review,
				context: yield* agentContext(state),
				onReport: (report) =>
					Effect.andThen(
						kit.recordCost(report.cost),
						kit.report({
							_tag: 'FindingsReported',
							round: review.round,
							reviewer: report.reviewer,
							findings: report.findings
						})
					)
			});
			return reports.flatMap((report) => report.findings);
		})
	);

/** Verifies the round's findings and checks whether the last fix resolved the must-fix ones. */
export const verifyStep = (state: RunState) =>
	runStep('verify', state, { timeoutMs: state.config.timeouts.verify }, (kit) =>
		Effect.gen(function* () {
			const review = state.review;
			if (review === null) return yield* missingReview;
			const reviewers = yield* Reviewers;
			const result = yield* reviewers.verify({
				...(yield* reviewSubject(state, { from: review.fromSha, to: review.toSha })),
				round: review.round,
				findings: review.findings,
				previous: state.unresolved.mustFix,
				model: state.config.models.verify,
				timeoutMs: state.config.timeouts.verify,
				context: yield* agentContext(state)
			});
			if (result.cost !== null) yield* kit.recordCost(result.cost);
			yield* kit.report({
				_tag: 'FindingsVerified',
				round: review.round,
				verified: result.verified,
				disproved: result.disproved
			});
			return result.verified;
		})
	);

// --- Triage ---

export type TriageNext = Data.TaggedEnum<{
	pr: {};
	fix: {};
	escalate: { readonly reason: EscalationReason };
}>;
export const TriageNext = Data.taggedEnum<TriageNext>();

export interface TriageResult {
	readonly unresolved: UnresolvedFindings;
	readonly next: TriageNext;
}

const mergeById = (
	earlier: ReadonlyArray<VerifiedFinding>,
	later: ReadonlyArray<VerifiedFinding>
): ReadonlyArray<VerifiedFinding> => {
	const ids = new Set(earlier.map((finding) => finding.id));
	return [...earlier, ...later.filter((finding) => !ids.has(finding.id))];
};

/**
 * Sorts the latest round's verified findings and picks what comes next. Only this
 * round's must-fix findings loop; tradeoffs and nits pile up for the PR body. A must-fix
 * finding that repeats an earlier one is a stall; the review cap applies after that.
 */
export const triage = (state: RunState): TriageResult => {
	const verified = state.reviewRounds.at(-1)?.findings ?? [];
	const bySeverity = (severity: VerifiedFinding['severity']) =>
		verified.filter((finding) => finding.severity === severity);
	const mustFix = bySeverity('must-fix');
	const unresolved: UnresolvedFindings = {
		mustFix,
		tradeoffs: mergeById(state.unresolved.tradeoffs, bySeverity('tradeoff')),
		nits: mergeById(state.unresolved.nits, bySeverity('nit'))
	};
	const next =
		mustFix.length === 0
			? TriageNext.pr()
			: mustFix.some((finding) => finding.repeats !== undefined)
				? TriageNext.escalate({ reason: 'stall' })
				: state.round >= state.config.caps.reviewRounds
					? TriageNext.escalate({ reason: 'review-cap' })
					: TriageNext.fix();
	return { unresolved, next };
};

export const triageStep = (state: RunState) =>
	runStep('triage', state, { timeoutMs: null }, (kit) =>
		Effect.gen(function* () {
			const result = triage(state);
			const ids = (findings: ReadonlyArray<VerifiedFinding>) => findings.map((f) => f.id);
			yield* kit.report({
				_tag: 'FindingsTriaged',
				round: state.round,
				mustFix: ids(result.unresolved.mustFix),
				tradeoffs: ids(result.unresolved.tradeoffs),
				nits: ids(result.unresolved.nits)
			});
			return result;
		})
	);

// --- Publishing ---

/** Squashes when configured, pushes, then opens or updates the PR. Returns its URL. */
const publish = (
	step: Extract<Step, 'pr' | 'escalate'>,
	state: RunState,
	kit: StepKit,
	escalation: EscalationReason | null
) =>
	Effect.gen(function* () {
		const git = yield* Git;
		const pr = yield* Pr;
		if (state.config.pr.squash && (yield* git.headSha(state)) !== state.baseSha) {
			yield* git.squash(state, {
				base: state.baseSha,
				message: commitMessage({ ...state, round: 0 })
			});
		}
		yield* git.push(state, state.branch);
		const range = { from: state.baseSha, to: yield* git.headSha(state) };
		const [base, diff, commits] = yield* Effect.all([
			git.defaultBranch(state),
			git.diff(state, range),
			git.commits(state, range)
		]);
		const context = yield* agentContext(state);
		const result = yield* pr.open({
			repo: { cwd: state.cwd, env: state.env },
			branch: state.branch,
			base,
			diff,
			commits,
			specPath: specPath(state),
			planPath: planPath(state),
			checks: state.checks,
			unresolved: state.unresolved,
			escalation,
			draft: escalation !== null || state.config.pr.draft,
			model: state.config.models.pr,
			timeoutMs: state.config.timeouts[step],
			transcript: context.transcript
		});
		yield* kit.recordCost(result.cost);
		yield* kit.report({ _tag: 'PrOpened', url: result.url, draft: result.draft });
		return result.url;
	});

export const prStep = (state: RunState) =>
	runStep('pr', state, { timeoutMs: state.config.timeouts.pr }, (kit) =>
		publish('pr', state, kit, null)
	);

/** Commits any unfinished work, then publishes a draft PR that says why the run stopped. */
export const escalateStep = (state: RunState) =>
	runStep('escalate', state, { timeoutMs: state.config.timeouts.escalate }, (kit) =>
		Effect.gen(function* () {
			const reason = state.escalationReason;
			if (reason === null) {
				return yield* new StepNotReady({ reason: 'Escalating without a reason' });
			}
			const git = yield* Git;
			yield* kit.report({ _tag: 'Escalated', reason });
			const message = `WIP: unfinished work (ship escalated: ${reason})`;
			const sha = yield* git.commit(state, message);
			if (sha !== null) yield* kit.report({ _tag: 'CommitCreated', sha, message });
			return yield* publish('escalate', state, kit, reason);
		})
	);
