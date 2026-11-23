/**
 * The `review` step: route, review, verify. It picks the reviewers for the change,
 * runs them, and verifies what they report, so a review's findings are always verified.
 * `ship run` calls it once per round with a `followUp` for the rounds after the first;
 * `ship review` calls it once over a PR.
 */
import { Duration, Effect, Schema } from 'effect';
import { agentContext } from './agent-context.ts';
import { Checkpoint } from './checkpoint.ts';
import { Conventions } from './conventions.ts';
import { withDefault } from './defaults.ts';
import { Finding, VerifiedFinding } from './finding.ts';
import { Git, type CommitRange } from './git.ts';
import { ReviewerName } from './reviewer.ts';
import {
	ChangeIntent,
	DEFAULT_REVIEW_CONCURRENCY,
	modelForRisk,
	reviewChanges,
	Reviewers,
	ReviewRisk,
	type ReviewSubject
} from './reviewers.ts';
import { StepTimeout, type StepKit } from './run-step.ts';
import { ReviewRound } from './run.ts';
import { ShipHome } from './ship-paths.ts';
import { stepScopeFields, type StepScope } from './step-scope.ts';
import type { Step } from './step.ts';
import { GitSha, PositiveInt } from './values.ts';

/**
 * What a review after a fix carries over from the round before: the findings the fix was
 * given, which the verifier checks again, and where routing starts.
 */
export const ReviewFollowUp = Schema.Struct({
	/**
	 * The must-fix findings and nits the last fix was given. The verifier says which are
	 * fixed; an unfixed one comes back as a finding that `repeats` it. Reviewers with a
	 * must-fix finding among them review again.
	 */
	previous: Schema.Array(VerifiedFinding),
	/** Tradeoffs already kept, so a repeat of one is dropped. */
	knownTradeoffs: Schema.Array(VerifiedFinding),
	/** Routing looks at `routedFromSha..HEAD`: the fix commits only. */
	routedFromSha: GitSha
});
export interface ReviewFollowUp extends Schema.Schema.Type<typeof ReviewFollowUp> {}

export const ReviewStepInput = Schema.Struct({
	...stepScopeFields,
	round: PositiveInt,
	/** What the change sets out to do; the reviewers and the verifier check it against this. */
	intent: ChangeIntent,
	/** `null` for a first review: routing looks at the whole range and nothing carries over. */
	followUp: Schema.NullOr(ReviewFollowUp)
});
export interface ReviewStepInput extends Schema.Schema.Type<typeof ReviewStepInput> {}

/**
 * The reviewed head, the reviewers routing picked and the risk Clef rated the change,
 * checkpointed as `route`.
 */
const Routed = Schema.Struct({
	toSha: GitSha,
	reviewers: Schema.Array(ReviewerName),
	// A `route` checkpointed before Clef rated risk resumes without a rating.
	risk: Schema.NullOr(ReviewRisk).pipe(withDefault(null))
});
interface Routed extends Schema.Schema.Type<typeof Routed> {}

/**
 * What reviewers and the verifier see of `range`, with the conventions that apply to it:
 * those whose triggers match, and those Clef adds. The topics are checkpointed
 * (`conventions`), so a resumed step does not ask Clef again.
 */
export const reviewSubject = Effect.fnUntraced(function* (
	scope: StepScope,
	intent: ChangeIntent,
	range: CommitRange
) {
	const conventions = yield* Conventions;
	const changes = yield* reviewChanges(scope, range);
	const names = yield* (yield* Checkpoint).once(
		'conventions',
		Schema.Array(Schema.String),
		conventions
			.reviewScope({ scope, changes })
			.pipe(Effect.map((picked) => picked.topics.map((topic) => topic.name)))
	);
	return {
		diff: changes.diff,
		commits: changes.commits,
		intent,
		conventions: {
			dir: conventions.dir,
			topics: conventions.topics.filter((topic) => names.includes(topic.name))
		}
	} satisfies ReviewSubject;
});

const loadReviewers = Effect.fnUntraced(function* (scope: StepScope) {
	const reviewers = yield* Reviewers;
	const home = yield* ShipHome;
	return yield* reviewers.load({
		projectDir: home.projectReviewers(scope.projectKey),
		disable: scope.config.reviewers.disable
	});
});

/**
 * Picks the round's reviewers. Every round reviews the whole range, `base..HEAD`.
 * Routing looks at `base..HEAD` for a first review and at `followUp.routedFromSha..HEAD`
 * after a fix, when every reviewer with a must-fix finding in `followUp.previous` runs
 * again too. Reports `ReviewStarted`.
 */
const route = (input: ReviewStepInput, kit: StepKit) =>
	Effect.gen(function* () {
		const git = yield* Git;
		const reviewers = yield* Reviewers;
		const routedFromSha = input.followUp?.routedFromSha ?? input.baseSha;
		const toSha = yield* git.headSha(input);
		const changes = yield* reviewChanges(input, { from: routedFromSha, to: toSha });
		const loaded = yield* loadReviewers(input);
		const routed = yield* reviewers.route({ scope: input, reviewers: loaded, changes });
		const reasons = new Map(
			routed.reviewers.map((picked) => [picked.reviewer.name, picked.reasons])
		);
		const returning = (input.followUp?.previous ?? [])
			.filter((finding) => finding.severity === 'must-fix')
			.flatMap((finding) => finding.alsoReportedBy.concat(finding.reviewer));
		for (const name of returning) {
			reasons.set(name, [
				...new Set([...(reasons.get(name) ?? []), `must-fix in round ${input.round - 1}`])
			]);
		}
		// In load order, and only reviewers that still exist.
		const picked = loaded.map((reviewer) => reviewer.name).filter((name) => reasons.has(name));
		for (const name of picked) {
			yield* Effect.logInfo(
				`Round ${input.round} reviewer ${name}: ${(reasons.get(name) ?? []).join(', ')}`
			);
		}
		yield* kit.report({
			_tag: 'ReviewStarted',
			round: input.round,
			fromSha: input.baseSha,
			toSha,
			reviewers: picked
		});
		return { toSha, reviewers: picked, risk: routed.risk } satisfies Routed;
	});

/**
 * `review`: routes, runs the picked reviewers against `intent` and verifies their
 * findings, also checking whether the fix resolved `followUp.previous`. Returns the
 * round with its verified findings.
 *
 * Reviewers run on the model for the risk Clef rated the change (`modelForRisk`), unless
 * their own frontmatter names one. Routing with its risk, each reviewer's report and the
 * verdicts are checkpointed (`route`, `reviewer/<name>`, `verify`), so a resumed review
 * re-runs only the reviewers that had not finished and asks Clef nothing again. Reviewer
 * calls and the verifier have their own timeouts, so the step has none.
 */
export const reviewStep = {
	name: 'review',
	input: ReviewStepInput,
	output: ReviewRound,
	timeoutMs: () => null,
	run: (input, kit) =>
		Effect.gen(function* () {
			const checkpoint = yield* Checkpoint;
			const reviewers = yield* Reviewers;
			const routed = yield* checkpoint.once('route', Routed, route(input, kit));
			const subject = yield* reviewSubject(input, input.intent, {
				from: input.baseSha,
				to: routed.toSha
			});
			const context = yield* agentContext(input);
			const picked = (yield* loadReviewers(input)).filter((def) =>
				routed.reviewers.includes(def.name)
			);
			const findings = yield* Effect.forEach(
				picked,
				(def) =>
					checkpoint.once(
						`reviewer/${def.name}`,
						Schema.Array(Finding),
						reviewers
							.review({
								...subject,
								reviewers: [def],
								model: modelForRisk(input.config.models, routed.risk),
								timeoutMs: input.config.timeouts.review,
								context,
								onReport: (report) =>
									Effect.andThen(
										kit.recordCost(report.cost),
										kit.report({
											_tag: 'FindingsReported',
											round: input.round,
											reviewer: report.reviewer,
											findings: report.findings
										})
									)
							})
							.pipe(
								Effect.map((reports) =>
									reports.flatMap((report) => report.findings)
								)
							)
					),
				{ concurrency: DEFAULT_REVIEW_CONCURRENCY }
			);
			const timeoutMs = input.config.timeouts.verify;
			const verified = yield* checkpoint.once(
				'verify',
				Schema.Array(VerifiedFinding),
				Effect.gen(function* () {
					const result = yield* reviewers.verify({
						...subject,
						scope: input,
						round: input.round,
						findings: findings.flat(),
						previous: input.followUp?.previous ?? [],
						knownTradeoffs: input.followUp?.knownTradeoffs ?? [],
						model: input.config.models.verify,
						timeoutMs,
						context
					});
					if (result.cost !== null) yield* kit.recordCost(result.cost);
					yield* kit.report({
						_tag: 'FindingsVerified',
						round: input.round,
						verified: result.verified,
						disproved: result.disproved
					});
					return result.verified;
				}).pipe(
					Effect.timeoutOrElse({
						duration: Duration.millis(timeoutMs),
						orElse: () => Effect.fail(new StepTimeout({ step: 'verify', timeoutMs }))
					})
				)
			);
			return {
				round: input.round,
				fromSha: input.baseSha,
				toSha: routed.toSha,
				reviewers: routed.reviewers,
				findings: verified
			};
		})
} satisfies Step<ReviewStepInput, ReviewRound, unknown>;
