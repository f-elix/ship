/**
 * The review round: `route`, `review` and `verify`, and the context reducers that take each
 * step's output. `ship run` loops through it after every passing check; `ship review` runs
 * it once over a PR. Both machines keep these as flat states with these names: state names
 * are persisted in snapshots, so renaming them would break resuming a run.
 */
import { Effect } from 'effect';
import { Conventions } from './conventions.ts';
import { readCredentials, type Credentials } from './credentials.ts';
import type { Finding, VerifiedFinding } from './finding.ts';
import { Git, type CommitRange } from './git.ts';
import {
	reviewChanges,
	Reviewers,
	type AgentContext,
	type ChangeIntent,
	type ReviewSubject
} from './reviewers.ts';
import { runStep, StepNotReady } from './run-step.ts';
import type { ReviewInProgress, ReviewRoundState } from './run.ts';
import { ShipHome } from './ship-paths.ts';

/** Where a run's agents work, and where their transcripts go. */
export const agentContext = Effect.fnUntraced(function* (
	state: Pick<ReviewRoundState, 'runId' | 'cwd' | 'env'>
) {
	const home = yield* ShipHome;
	return {
		cwd: state.cwd,
		env: state.env,
		transcript: { dir: home.transcripts(state.runId) }
	} satisfies AgentContext;
});

const missingReview = new StepNotReady({ reason: 'No review round is in progress' });

/** What reviewers and the verifier see of `range`, with the conventions that apply to it. */
const reviewSubject = Effect.fnUntraced(function* (
	state: ReviewRoundState,
	intent: ChangeIntent,
	range: CommitRange
) {
	const changes = yield* reviewChanges(state, range);
	const conventions = yield* (yield* Conventions).scope({ repo: state, changes });
	return {
		diff: changes.diff,
		commits: changes.commits,
		intent,
		conventions
	} satisfies ReviewSubject;
});

const loadReviewers = Effect.fnUntraced(function* (state: ReviewRoundState) {
	const reviewers = yield* Reviewers;
	const home = yield* ShipHome;
	return yield* reviewers.load({
		projectDir: home.projectReviewers(state.projectKey),
		disable: state.config.reviewers.disable
	});
});

/**
 * The Clef input for routing: the saved Cloudflare credentials, or `null` when the project
 * turned Clef off, none are saved, or the file cannot be read, which logs a warning.
 */
const clefRouting = Effect.fnUntraced(function* (state: ReviewRoundState) {
	if (!state.config.reviewers.clef) return null;
	const home = yield* ShipHome;
	const credentials: Credentials = yield* readCredentials(home.home).pipe(
		Effect.catchTag('CredentialsFileError', (error) =>
			Effect.as(Effect.logWarning('Routing without Clef', error), {})
		)
	);
	if (credentials.cloudflare === undefined) {
		yield* Effect.logWarning(
			'No Cloudflare credentials are saved (`ship auth cloudflare`); routing without Clef'
		);
		return null;
	}
	return { credentials: credentials.cloudflare };
});

/**
 * Picks the round's reviewers and starts the round. Every round reviews the whole branch,
 * `base..HEAD`. Routing looks at `base..HEAD` in round 1, then at the fix commits,
 * `lastReviewedSha..HEAD`, and from round 2 every reviewer that had a must-fix finding in
 * the previous round runs again too.
 */
export const routeStep = (state: ReviewRoundState) =>
	runStep('route', state, { timeoutMs: null }, (kit) =>
		Effect.gen(function* () {
			const git = yield* Git;
			const reviewers = yield* Reviewers;
			const routedFromSha = state.lastReviewedSha ?? state.baseSha;
			const toSha = yield* git.headSha(state);
			const changes = yield* reviewChanges(state, { from: routedFromSha, to: toSha });
			const loaded = yield* loadReviewers(state);
			const routed = yield* reviewers.route({
				reviewers: loaded,
				changes,
				clef: yield* clefRouting(state)
			});
			if (routed.clefError !== null) {
				yield* Effect.logWarning(
					'Routing with the deterministic triggers only',
					routed.clefError
				);
			}
			const reasons = new Map(
				routed.reviewers.map((picked) => [picked.reviewer.name, picked.reasons])
			);
			const previous = state.reviewRounds.at(-1);
			if (previous !== undefined) {
				const returning = previous.findings
					.filter((finding) => finding.severity === 'must-fix')
					.flatMap((finding) => finding.alsoReportedBy.concat(finding.reviewer));
				for (const name of returning) {
					reasons.set(name, [
						...new Set([
							...(reasons.get(name) ?? []),
							`must-fix in round ${previous.round}`
						])
					]);
				}
			}
			// In load order, and only reviewers that still exist.
			const picked = loaded
				.map((reviewer) => reviewer.name)
				.filter((name) => reasons.has(name));
			for (const name of picked) {
				yield* Effect.logInfo(
					`Round ${state.round} reviewer ${name}: ${(reasons.get(name) ?? []).join(', ')}`
				);
			}
			yield* kit.report({
				_tag: 'ReviewStarted',
				round: state.round,
				fromSha: state.baseSha,
				toSha,
				reviewers: picked
			});
			return {
				round: state.round,
				fromSha: state.baseSha,
				toSha,
				routedFromSha,
				reviewers: picked,
				findings: []
			} satisfies ReviewInProgress;
		})
	);

/**
 * Runs the round's reviewers against `intent`. Each reviewer call has its own timeout, so
 * the step has none: reviewers run in batches and the step can rightly outlast one call.
 */
export const reviewStep = (state: ReviewRoundState, intent: ChangeIntent) =>
	runStep('review', state, { timeoutMs: null }, (kit) =>
		Effect.gen(function* () {
			const review = state.review;
			if (review === null) return yield* missingReview;
			const reviewers = yield* Reviewers;
			const picked = (yield* loadReviewers(state)).filter((def) =>
				review.reviewers.includes(def.name)
			);
			const reports = yield* reviewers.review({
				...(yield* reviewSubject(state, intent, {
					from: review.fromSha,
					to: review.toSha
				})),
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

/**
 * Verifies the round's findings against `intent` and checks whether the last fix resolved
 * the must-fix findings and nits it was given.
 */
export const verifyStep = (state: ReviewRoundState, intent: ChangeIntent) =>
	runStep('verify', state, { timeoutMs: state.config.timeouts.verify }, (kit) =>
		Effect.gen(function* () {
			const review = state.review;
			if (review === null) return yield* missingReview;
			const reviewers = yield* Reviewers;
			const result = yield* reviewers.verify({
				...(yield* reviewSubject(state, intent, {
					from: review.fromSha,
					to: review.toSha
				})),
				round: review.round,
				findings: review.findings,
				previous: [...state.unresolved.mustFix, ...state.unresolved.nits],
				knownTradeoffs: state.unresolved.tradeoffs,
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

/** The context once `route` started the round. */
export const startRound = <C extends ReviewRoundState>(
	context: C,
	review: ReviewInProgress
): C => ({
	...context,
	review
});

/** The context once `review` reported the round's findings. */
export const withFindings = <C extends ReviewRoundState>(
	context: C,
	findings: ReadonlyArray<Finding>
): C => ({ ...context, review: context.review && { ...context.review, findings } });

/**
 * The context once `verify` closed the round: the round joins `reviewRounds` with its
 * verified findings, and the next round routes from its head. `null` when no round was in
 * progress, which fails the run.
 */
export const completeRound = <C extends ReviewRoundState>(
	context: C,
	verified: ReadonlyArray<VerifiedFinding>
): C | null =>
	context.review === null
		? null
		: {
				...context,
				review: null,
				lastReviewedSha: context.review.toSha,
				reviewRounds: [
					...context.reviewRounds,
					{
						round: context.review.round,
						fromSha: context.review.fromSha,
						toSha: context.review.toSha,
						reviewers: context.review.reviewers,
						findings: verified
					}
				]
			};
