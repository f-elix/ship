/**
 * Loads a findings source: the findings, the PR they are about and the review thread each
 * finding was posted as.
 */
import { Effect, Schema } from 'effect';
import { FindingId, VerifiedFinding, type Severity } from './finding.ts';
import { FINDING_MARKER, parseFindingMarker, type FindingsSource } from './findings-source.ts';
import { Gh, type GhError, type PrDetails, type ReviewThread } from './gh.ts';
import type { GitRepo } from './git.ts';
import { ReviewId } from './primitives.ts';
import { ChangeIntent } from './reviewers.ts';
import { Reviews, type ReviewNotFound, type StoredReview } from './stored-review.ts';

/** The severity labels `post` writes, as `**Must-fix** (reviewer): claim`. */
const LABELS: Readonly<Record<string, Severity>> = {
	'Must-fix': 'must-fix',
	Tradeoff: 'tradeoff',
	Nit: 'nit'
};
const LABEL = /^\*\*(Must-fix|Tradeoff|Nit)\*\* /u;

/**
 * A review thread as a finding: a must-fix, unless ship posted it with another severity
 * label, reported by `github:<login>`, claiming what the comment says (markers left out),
 * with the comment's URL as evidence. `id` is the finding's id within the source.
 */
export const threadFinding = (thread: ReviewThread, id: FindingId): VerifiedFinding => {
	const body = thread.body.replace(new RegExp(FINDING_MARKER.source, 'gu'), '').trim();
	const label = LABEL.exec(body)?.[1];
	return {
		reviewer: `github:${thread.author ?? 'ghost'}`,
		file: thread.path,
		...(thread.line === null || thread.line < 1 ? {} : { line: thread.line }),
		severity: label === undefined ? 'must-fix' : (LABELS[label] ?? 'must-fix'),
		claim: body === '' ? `See ${thread.url}` : body,
		evidence: thread.url,
		id,
		round: 1,
		alsoReportedBy: []
	};
};

/** A loaded source: the findings to fix or recheck, and where they live on GitHub. */
export const LoadedFindings = Schema.Struct({
	/** The must-fix findings and nits; tradeoffs are never fixed or rechecked. */
	findings: Schema.Array(VerifiedFinding),
	/** The open review thread of each finding that has one, by finding id. */
	threads: Schema.Record(Schema.String, Schema.String),
	/** What the change sets out to do: the stored review's intent, or the PR's description. */
	intent: ChangeIntent
});
export interface LoadedFindings extends Schema.Schema.Type<typeof LoadedFindings> {}

/** GitHub has no PR `ref` names, or `gh` could not read it. */
export class PrNotFound extends Schema.TaggedError<PrNotFound>()('PrNotFound', {
	ref: Schema.String,
	detail: Schema.String
}) {
	override get message(): string {
		return `Could not read the pull request ${this.ref}: ${this.detail}`;
	}
}

/** A stored review names no PR, so there is nothing to check out, push or resolve. */
export class ReviewWithoutPr extends Schema.TaggedError<ReviewWithoutPr>()('ReviewWithoutPr', {
	reviewId: ReviewId
}) {
	override get message(): string {
		return `Review ${this.reviewId} is of a branch without a pull request`;
	}
}

const actionable = (finding: VerifiedFinding) => finding.severity !== 'tradeoff';

/** The stored finding a marked thread was posted from, or `null`. */
const storedFinding = Effect.fnUntraced(function* (thread: ReviewThread) {
	const marker = parseFindingMarker(thread.body);
	if (marker === null) return null;
	const review = yield* (yield* Reviews)
		.get(marker.reviewId)
		.pipe(Effect.catchTag('ReviewNotFound', () => Effect.succeed(null)));
	return review?.findings.find((finding) => finding.id === marker.findingId) ?? null;
});

/**
 * A PR's open threads as findings. A thread ship posted is its stored finding, id
 * included, when this machine still has the review and no earlier thread took the id;
 * otherwise it keeps only its labelled severity. Other threads get ids `t1`, `t2`, ….
 */
const fromThreads = Effect.fnUntraced(function* (threads: ReadonlyArray<ReviewThread>) {
	const findings: Array<VerifiedFinding> = [];
	const byFinding: Record<string, string> = {};
	for (const [index, thread] of threads.entries()) {
		const stored = yield* storedFinding(thread);
		const finding =
			stored !== null && !(stored.id in byFinding)
				? stored
				: threadFinding(thread, FindingId.make(`t${index + 1}`));
		if (!actionable(finding)) continue;
		findings.push(finding);
		byFinding[finding.id] = thread.id;
	}
	return { findings, threads: byFinding };
});

/** A stored review's must-fix findings and nits, and the open threads it posted them as. */
const fromReview = (review: StoredReview, threads: ReadonlyArray<ReviewThread>) => {
	const findings = review.findings.filter(actionable);
	const ids = new Set<string>(findings.map((finding) => finding.id));
	const byFinding: Record<string, string> = {};
	for (const thread of threads) {
		const marker = parseFindingMarker(thread.body);
		if (marker?.reviewId === review.id && ids.has(marker.findingId)) {
			byFinding[marker.findingId] = thread.id;
		}
	}
	return { findings, threads: byFinding };
};

/**
 * Loads `source` in `repo`: its PR, as GitHub has it now, and the findings with their
 * open threads. Fails with `ReviewNotFound` for an unknown review, `ReviewWithoutPr` for a
 * review of a branch without a PR, `PrNotFound` when the PR cannot be read, and `GhError`
 * when its threads cannot.
 */
export const loadFindings = Effect.fn('loadFindings')(function* (
	repo: GitRepo,
	source: FindingsSource
): Effect.fn.Return<
	{ readonly pr: PrDetails; readonly loaded: LoadedFindings },
	ReviewNotFound | ReviewWithoutPr | PrNotFound | GhError,
	Gh | Reviews
> {
	const gh = yield* Gh;
	const viewPr = (ref: string) =>
		gh
			.viewPr(repo, ref)
			.pipe(Effect.mapError((error) => new PrNotFound({ ref, detail: error.stderr.trim() })));
	if (source._tag === 'PrThreads') {
		const pr = yield* viewPr(source.pr);
		const fromPr = yield* fromThreads(yield* gh.reviewThreads(repo, pr.url));
		return {
			pr,
			loaded: {
				...fromPr,
				intent: ChangeIntent.cases.Description.make({ title: pr.title, body: pr.body })
			}
		};
	}
	const review = yield* (yield* Reviews).get(source.reviewId);
	const prUrl = review.subject.prUrl;
	if (prUrl === null) return yield* new ReviewWithoutPr({ reviewId: review.id });
	const pr = yield* viewPr(prUrl);
	// Only a posted review has threads on the PR.
	const threads = review.postedUrl === null ? [] : yield* gh.reviewThreads(repo, pr.url);
	return {
		pr,
		loaded: { ...fromReview(review, threads), intent: review.subject.intent }
	};
});
