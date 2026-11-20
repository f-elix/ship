/**
 * Findings sources: what `ship fix` and `ship recheck` work through. A source is a review
 * ship stored, or a PR's open review threads. This module is part of the wire contract;
 * `findings-loader.ts` loads a source.
 */
import { Schema } from 'effect';
import { FindingId } from './finding.ts';
import { parsePrUrl } from './pr-url.ts';
import { ReviewId } from './values.ts';

/** Where a command's findings come from. */
export const FindingsSource = Schema.TaggedUnion({
	/** A review an earlier `ship review` or `ship run` stored. */
	Review: { reviewId: ReviewId },
	/** A PR's unresolved, non-outdated review threads; `pr` is a PR number or URL. */
	PrThreads: { pr: Schema.NonEmptyString }
});
export type FindingsSource = typeof FindingsSource.Type;

/**
 * The source a command-line argument names: a PR number or URL reads the PR's threads,
 * anything else is a review id. `null` for a blank argument.
 */
export const parseFindingsSource = (argument: string): FindingsSource | null => {
	const value = argument.trim();
	if (value === '') return null;
	return /^\d+$/u.test(value) || parsePrUrl(value) !== null
		? FindingsSource.cases.PrThreads.make({ pr: value })
		: FindingsSource.cases.Review.make({ reviewId: ReviewId.make(value) });
};

/**
 * The hidden marker `post` puts in each inline comment, which ties the thread it opens to
 * the stored review and the finding it posts. Finding ids are unique only within a
 * review, so the marker names both.
 */
export const findingMarker = (reviewId: ReviewId, findingId: FindingId): string =>
	`<!-- ship-finding: ${reviewId}/${findingId} -->`;

/** Matches a {@link findingMarker}: the review id, then the finding id. */
export const FINDING_MARKER = /<!-- ship-finding: ([^\s/]+)\/(\S+) -->/u;

/** The review and finding a comment's {@link findingMarker} names, or `null`. */
export const parseFindingMarker = (
	body: string
): { readonly reviewId: ReviewId; readonly findingId: FindingId } | null => {
	const match = FINDING_MARKER.exec(body);
	if (match === null) return null;
	const [, reviewId = '', findingId = ''] = match;
	return { reviewId: ReviewId.make(reviewId), findingId: FindingId.make(findingId) };
};
