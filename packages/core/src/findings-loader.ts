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
	/**
	 * The URLs of the open threads left out because their author may not push to the
	 * repository: anyone can comment on a public PR, and ship would act on what they say.
	 */
	ignoredThreads: Schema.Array(Schema.String),
	/** What the change sets out to do: the stored review's intent, or the PR's description. */
	intent: ChangeIntent
});
export interface LoadedFindings extends Schema.Schema.Type<typeof LoadedFindings> {}

/** `ref` names no PR on GitHub, or `gh` could not read it. */
export class PrNotFound extends Schema.TaggedError<PrNotFound>()('PrNotFound', {
	ref: Schema.String,
	detail: Schema.String,
	cause: Schema.optionalKey(Schema.Defect())
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

/** Splits `threads` into those whose author may push to the repository and the rest's URLs. */
const byTrust = (threads: ReadonlyArray<ReviewThread>) => ({
	trusted: threads.filter((thread) => thread.authorCanWrite),
	ignoredThreads: threads.filter((thread) => !thread.authorCanWrite).map((thread) => thread.url)
});

/**
 * A PR's open threads as findings. A thread ship posted is its stored finding, id
 * included, when this machine still has the review and no earlier thread took the id;
 * otherwise it keeps only its labelled severity. Other threads take their GitHub id, so a
 * finding keeps its id as threads around it are resolved.
 */
const fromThreads = Effect.fnUntraced(function* (threads: ReadonlyArray<ReviewThread>) {
	const findings: Array<VerifiedFinding> = [];
	const byFinding: Record<string, string> = {};
	for (const thread of threads) {
		const stored = yield* storedFinding(thread);
		const finding =
			stored !== null && !(stored.id in byFinding)
				? stored
				: threadFinding(thread, FindingId.make(thread.id));
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
			.pipe(
				Effect.mapError(
					(error) => new PrNotFound({ ref, detail: error.stderr.trim(), cause: error })
				)
			);
	if (source._tag === 'PrThreads') {
		const pr = yield* viewPr(source.pr);
		const { trusted, ignoredThreads } = byTrust(yield* gh.reviewThreads(repo, pr.url));
		const fromPr = yield* fromThreads(trusted);
		return {
			pr,
			loaded: {
				...fromPr,
				ignoredThreads,
				intent: ChangeIntent.cases.Description.make({ title: pr.title, body: pr.body })
			}
		};
	}
	const review = yield* (yield* Reviews).get(source.reviewId);
	const prUrl = review.subject.prUrl;
	if (prUrl === null) return yield* new ReviewWithoutPr({ reviewId: review.id });
	const pr = yield* viewPr(prUrl);
	// Only a posted review has threads on the PR.
	const { trusted, ignoredThreads } = byTrust(
		review.postedUrl === null ? [] : yield* gh.reviewThreads(repo, pr.url)
	);
	return {
		pr,
		loaded: { ...fromReview(review, trusted), ignoredThreads, intent: review.subject.intent }
	};
});
