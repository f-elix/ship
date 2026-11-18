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

/** Stable id of a verified finding within a run, assigned when the verifier accepts it. */
export const FindingId = Schema.NonEmptyString.pipe(Schema.brand('FindingId'));
export type FindingId = typeof FindingId.Type;

/**
 * A finding the verifier kept: deduplicated, checked against the code, and matched
 * against earlier rounds. `repeats` set means the same problem was already reported in
 * a previous round, which is how a stall is detected.
 */
export const VerifiedFinding = Schema.Struct({
	...Finding.fields,
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
