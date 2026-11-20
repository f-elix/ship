import { Schema } from 'effect';
import { PositiveInt } from './primitives.ts';
import { ReviewerName } from './reviewer.ts';

export const Severity = Schema.Literals(['must-fix', 'tradeoff', 'nit']);
export type Severity = typeof Severity.Type;

/** What a reviewer reports. Reviewers see only the diff, never each other's output. */
export const Finding = Schema.Struct({
	reviewer: ReviewerName,
	/** Repo-relative path. */
	file: Schema.NonEmptyString,
	line: Schema.optionalKey(PositiveInt),
	severity: Severity,
	claim: Schema.NonEmptyString,
	evidence: Schema.NonEmptyString
});
export interface Finding extends Schema.Schema.Type<typeof Finding> {}

/**
 * The GitHub login of a PR comment's author, as `github:<login>`: the reviewer of a
 * finding read from a PR thread rather than reported by one of ship's reviewers.
 */
export const GithubAuthor = Schema.String.check(
	Schema.isPattern(/^github:[A-Za-z0-9-]+(?:\[bot\])?$/u, {
		expected: 'a GitHub author, as github:<login>'
	})
);

/** Who reported a verified finding: one of ship's reviewers, or a PR comment's author. */
export const FindingAuthor = Schema.Union([ReviewerName, GithubAuthor]);

/** Stable id of a verified finding within a run, assigned when the verifier accepts it. */
export const FindingId = Schema.NonEmptyString.pipe(Schema.brand('FindingId'));
export type FindingId = typeof FindingId.Type;

/**
 * A finding the verifier kept: deduplicated, checked against the code, and matched
 * against earlier rounds. `repeats` set means the same problem was already reported in
 * a previous round, which is how a stall is detected. A finding read from a PR thread is
 * a verified finding too, whose reviewer is the thread's author.
 */
export const VerifiedFinding = Schema.Struct({
	...Finding.fields,
	reviewer: FindingAuthor,
	id: FindingId,
	/** Review round that reported it. */
	round: PositiveInt,
	/** Other reviewers whose findings were merged into this one. */
	alsoReportedBy: Schema.Array(ReviewerName),
	/** The previous-round finding this one repeats. */
	repeats: Schema.optionalKey(FindingId)
});
export interface VerifiedFinding extends Schema.Schema.Type<typeof VerifiedFinding> {}

/** A finding the verifier dropped, with why. Kept in the event log for auditing. */
export const DisprovedFinding = Schema.Struct({
	finding: Finding,
	reason: Schema.NonEmptyString
});
export interface DisprovedFinding extends Schema.Schema.Type<typeof DisprovedFinding> {}
