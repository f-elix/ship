/**
 * Loads a findings source: the findings, the PR they are about and the review thread each
 * finding was posted as.
 */
import { Effect, Schema } from 'effect';
import { Clef, type ChoiceQuestion, type ClefScope } from './clef.ts';
import { FindingId, VerifiedFinding, type Severity } from './finding.ts';
import { FINDING_MARKER, parseFindingMarker, type FindingsSource } from './findings-source.ts';
import { Gh, type GhError, type PrDetails, type ReviewThread } from './gh.ts';
import type { GitRepo } from './git.ts';
import { ChangeIntent } from './reviewers.ts';
import type { ShipHome } from './ship-paths.ts';
import { Reviews, type ReviewNotFound, type StoredReview } from './stored-review.ts';
import { ReviewId } from './values.ts';

/** The severity labels `post` writes, as `**Must-fix** (reviewer): claim`. */
const LABELS: Readonly<Record<string, Severity>> = {
	'Must-fix': 'must-fix',
	Tradeoff: 'tradeoff',
	Nit: 'nit'
};
const LABEL = /^\*\*(Must-fix|Tradeoff|Nit)\*\* /u;

/** A thread's comment without ship's finding markers. */
const commentText = (thread: ReviewThread): string =>
	thread.body.replace(new RegExp(FINDING_MARKER.source, 'gu'), '').trim();

/** The severity ship labelled a thread with when it posted it, or `null` for no label. */
const threadLabel = (thread: ReviewThread): Severity | null => {
	const label = LABEL.exec(commentText(thread))?.[1];
	return label === undefined ? null : (LABELS[label] ?? null);
};

/**
 * A review thread as a finding of `severity`, reported by `github:<login>`, claiming what
 * the comment says (markers left out), with the comment's URL as evidence. `id` is the
 * finding's id within the source.
 */
export const threadFinding = (
	thread: ReviewThread,
	id: FindingId,
	severity: Severity
): VerifiedFinding => {
	const body = commentText(thread);
	return {
		reviewer: `github:${thread.author ?? 'ghost'}`,
		file: thread.path,
		...(thread.line === null || thread.line < 1 ? {} : { line: thread.line }),
		severity,
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

/** What Clef rates an unlabelled thread: a finding of either severity, or no finding. */
type ThreadKind = 'must-fix' | 'nit' | 'none';

const THREAD_QUESTION: ChoiceQuestion<ThreadKind> = {
	type: 'choice',
	instructions: 'What does this pull request review comment ask of the code change?',
	criteria: {
		'must-fix':
			'a change the author must make: a defect, a missing case, a broken contract, or a request the reviewer expects addressed',
		nit: 'an optional suggestion: naming, style, wording, or a matter of taste',
		none: 'no change at all: a question, praise, an acknowledgement, or a discussion'
	}
};

/**
 * What an unlabelled thread is, as Clef rates it: its most probable kind. Without Clef's
 * answer, a must-fix, as before Clef.
 */
const threadKind = Effect.fnUntraced(function* (scope: ClefScope, thread: ReviewThread) {
	const answers = yield* (yield* Clef).ask(scope, {
		decision: 'Treating an unlabelled review thread as a must-fix',
		state: [
			`File: ${thread.path}${thread.line === null ? '' : `:${thread.line}`}`,
			'',
			'Comment:',
			commentText(thread)
		].join('\n'),
		questions: { kind: THREAD_QUESTION }
	});
	if (answers === null) return 'must-fix';
	const { pick, probabilities } = answers.kind;
	yield* Effect.logInfo(
		`Review thread ${thread.url}: ${pick} (clef: p=${(probabilities[pick] ?? 0).toFixed(2)})`
	);
	return pick;
});

/**
 * A PR's open threads as findings. A thread ship posted is its stored finding, id
 * included, when this machine still has the review and no earlier thread took the id;
 * otherwise it keeps its labelled severity. An unlabelled thread is the kind Clef rates
 * it, asked for every such thread at once; one Clef rates no finding is left out. Other
 * threads take their GitHub id, so a finding keeps its id as threads around it are
 * resolved.
 */
const fromThreads = Effect.fnUntraced(function* (
	scope: ClefScope,
	threads: ReadonlyArray<ReviewThread>
) {
	const stored = yield* Effect.forEach(threads, storedFinding);
	const taken = new Set<string>();
	const own = stored.map((finding) => {
		if (finding === null || taken.has(finding.id)) return null;
		if (actionable(finding)) taken.add(finding.id);
		return finding;
	});
	const kinds = yield* Effect.forEach(
		threads,
		(thread, index): Effect.Effect<ThreadKind | Severity | null, never, Clef | ShipHome> => {
			if (own[index] !== null) return Effect.succeed(null);
			const label = threadLabel(thread);
			return label === null ? threadKind(scope, thread) : Effect.succeed(label);
		},
		{ concurrency: 'unbounded' }
	);
	const findings: Array<VerifiedFinding> = [];
	const byFinding: Record<string, string> = {};
	threads.forEach((thread, index) => {
		const kind = kinds[index] ?? null;
		const finding =
			own[index] ??
			(kind === null || kind === 'none'
				? null
				: threadFinding(thread, FindingId.make(thread.id), kind));
		if (finding === null || !actionable(finding)) return;
		findings.push(finding);
		byFinding[finding.id] = thread.id;
	});
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
 * open threads. Clef rates the unlabelled threads of a PR, unless `scope`'s project
 * turned it off. Fails with `ReviewNotFound` for an unknown review, `ReviewWithoutPr` for a
 * review of a branch without a PR, `PrNotFound` when the PR cannot be read, and `GhError`
 * when its threads cannot.
 */
export const loadFindings = Effect.fn('loadFindings')(function* (
	repo: GitRepo,
	source: FindingsSource,
	scope: ClefScope
): Effect.fn.Return<
	{ readonly pr: PrDetails; readonly loaded: LoadedFindings },
	ReviewNotFound | ReviewWithoutPr | PrNotFound | GhError,
	Gh | Reviews | Clef | ShipHome
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
		const fromPr = yield* fromThreads(scope, trusted);
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
