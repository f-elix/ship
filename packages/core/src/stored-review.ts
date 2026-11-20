/**
 * Reviews that outlive the run that made them. `ship review` stores its review; the later
 * `fix`, `recheck` and `post` commands take its `ReviewId`.
 */
import { Context, type Effect, Schema } from 'effect';
import { VerifiedFinding } from './finding.ts';
import { ChangeIntent } from './reviewers.ts';
import { GitSha, ProjectKey, ReviewId, RunId, Url } from './values.ts';

/** What a stored review reviewed: a project's `baseSha..headSha`, against `intent`. */
export const ReviewSubjectRef = Schema.Struct({
	projectKey: ProjectKey,
	/** The reviewed pull request; `null` for a review of a branch with no PR. */
	prUrl: Schema.NullOr(Url),
	baseSha: GitSha,
	headSha: GitSha,
	/** The plan's files or the PR's description the reviewers checked the change against. */
	intent: ChangeIntent
});
export interface ReviewSubjectRef extends Schema.Schema.Type<typeof ReviewSubjectRef> {}

export const StoredReview = Schema.Struct({
	id: ReviewId,
	/** The run that made the review. */
	runId: RunId,
	subject: ReviewSubjectRef,
	/** Every verified finding of the review, of every severity. */
	findings: Schema.Array(VerifiedFinding),
	/** The GitHub review it was posted as; `null` until it is posted. */
	postedUrl: Schema.NullOr(Url)
});
export interface StoredReview extends Schema.Schema.Type<typeof StoredReview> {}

/** The id of the review a run made in `round`: stable, so storing it again replaces it. */
export const reviewIdFor = (runId: RunId, round: number): ReviewId =>
	ReviewId.make(`${runId}-r${round}`);

/** No review is stored under the id. */
export class ReviewNotFound extends Schema.TaggedError<ReviewNotFound>()('ReviewNotFound', {
	reviewId: ReviewId
}) {
	override get message(): string {
		return `No review is stored as ${this.reviewId}`;
	}
}

export interface ReviewsShape {
	/** Stores the review, replacing the one stored under the same id. */
	readonly save: (review: StoredReview) => Effect.Effect<void>;
	readonly get: (id: ReviewId) => Effect.Effect<StoredReview, ReviewNotFound>;
	/** The reviews of the pull request at `url`, oldest first. */
	readonly byPr: (url: string) => Effect.Effect<ReadonlyArray<StoredReview>>;
}

/** Where stored reviews are kept; the store package provides it. */
export class Reviews extends Context.Service<Reviews, ReviewsShape>()('@ship/core/Reviews') {}
