/**
 * The `review` primitive: route, review, verify. It picks the reviewers for the change,
 * runs them, and verifies what they report, so a review's findings are always verified.
 * `ship run` calls it once per round with a `followUp` for the rounds after the first;
 * `ship review` calls it once over a PR.
 */
import { Duration, Effect, Schema } from 'effect';
import { agentContext } from './agent-context.ts';
import { Checkpoint } from './checkpoint.ts';
import { Conventions } from './conventions.ts';
import { readCredentials, type Credentials } from './credentials.ts';
import { Finding, VerifiedFinding } from './finding.ts';
import { Git, type CommitRange } from './git.ts';
import { primitiveScopeFields, type PrimitiveScope } from './primitive-scope.ts';
import type { Primitive } from './primitive.ts';
import { GitSha, PositiveInt } from './primitives.ts';
import { ReviewerName } from './reviewer.ts';
import {
	ChangeIntent,
	DEFAULT_REVIEW_CONCURRENCY,
	reviewChanges,
	Reviewers,
	type ReviewSubject
} from './reviewers.ts';
import { StepTimeout, type StepKit } from './run-step.ts';
import { ReviewRound } from './run.ts';
import { ShipHome } from './ship-paths.ts';

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

export const ReviewPrimitiveInput = Schema.Struct({
	...primitiveScopeFields,
	round: PositiveInt,
	/** What the change sets out to do; the reviewers and the verifier check it against this. */
	intent: ChangeIntent,
	/** `null` for a first review: routing looks at the whole range and nothing carries over. */
	followUp: Schema.NullOr(ReviewFollowUp)
});
export interface ReviewPrimitiveInput extends Schema.Schema.Type<typeof ReviewPrimitiveInput> {}

/** The reviewed head and the reviewers routing picked, checkpointed as `route`. */
const Routed = Schema.Struct({ toSha: GitSha, reviewers: Schema.Array(ReviewerName) });
interface Routed extends Schema.Schema.Type<typeof Routed> {}

/** What reviewers and the verifier see of `range`, with the conventions that apply to it. */
export const reviewSubject = Effect.fnUntraced(function* (
	scope: PrimitiveScope,
	intent: ChangeIntent,
	range: CommitRange
) {
	const changes = yield* reviewChanges(scope, range);
	const conventions = yield* (yield* Conventions).scope({ repo: scope, changes });
	return {
		diff: changes.diff,
		commits: changes.commits,
		intent,
		conventions
	} satisfies ReviewSubject;
});

const loadReviewers = Effect.fnUntraced(function* (scope: PrimitiveScope) {
	const reviewers = yield* Reviewers;
	const home = yield* ShipHome;
	return yield* reviewers.load({
		projectDir: home.projectReviewers(scope.projectKey),
		disable: scope.config.reviewers.disable
	});
});

/**
 * The Clef input for routing: the saved Cloudflare credentials, or `null` when the project
 * turned Clef off, none are saved, or the file cannot be read, which logs a warning.
 */
const clefRouting = Effect.fnUntraced(function* (scope: PrimitiveScope) {
	if (!scope.config.reviewers.clef) return null;
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
 * Picks the round's reviewers. Every round reviews the whole range, `base..HEAD`.
 * Routing looks at `base..HEAD` for a first review and at `followUp.routedFromSha..HEAD`
 * after a fix, when every reviewer with a must-fix finding in `followUp.previous` runs
 * again too. Reports `ReviewStarted`.
 */
const route = (input: ReviewPrimitiveInput, kit: StepKit) =>
	Effect.gen(function* () {
		const git = yield* Git;
		const reviewers = yield* Reviewers;
		const routedFromSha = input.followUp?.routedFromSha ?? input.baseSha;
		const toSha = yield* git.headSha(input);
		const changes = yield* reviewChanges(input, { from: routedFromSha, to: toSha });
		const loaded = yield* loadReviewers(input);
		const routed = yield* reviewers.route({
			reviewers: loaded,
			changes,
			clef: yield* clefRouting(input)
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
		return { toSha, reviewers: picked } satisfies Routed;
	});

/**
 * `review`: routes, runs the picked reviewers against `intent` and verifies their
 * findings, also checking whether the fix resolved `followUp.previous`. Returns the
 * round with its verified findings.
 *
 * Routing, each reviewer's report and the verdicts are checkpointed (`route`,
 * `reviewer/<name>`, `verify`), so a resumed review re-runs only the reviewers that had
 * not finished. Reviewer calls and the verifier have their own timeouts, so the
 * primitive has none.
 */
export const reviewPrimitive = {
	name: 'review',
	input: ReviewPrimitiveInput,
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
								model: input.config.models.review,
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
} satisfies Primitive<ReviewPrimitiveInput, ReviewRound, unknown>;
