/**
 * Loads a findings source: the findings, the PR they are about and the open review thread
 * of each finding that has one.
 */
import { Effect, Schema } from 'effect';
import { Clef, type ChoiceQuestion, type ClefScope } from './clef.ts';
import {
	isCodeRabbitComment,
	parseCodeRabbitReviewBody,
	reviewCommentProse
} from './coderabbit.ts';
import { FindingId, VerifiedFinding, type Severity } from './finding.ts';
import { FINDING_MARKER, parseFindingMarker, type FindingsSource } from './findings-source.ts';
import {
	botLogin,
	Gh,
	type GhError,
	type PrDetails,
	type PrReview,
	type ReviewThread
} from './gh.ts';
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

/** A bot's or CodeRabbit's comment, which may hold a prompt for agents. */
const isBotWritten = (thread: ReviewThread) =>
	thread.authorIsBot || isCodeRabbitComment(thread.body);

/**
 * A thread's comment without ship's finding markers. A bot's or CodeRabbit's comment is
 * only its prose, without its rating or its prompt for agents.
 */
const commentText = (thread: ReviewThread): string =>
	isBotWritten(thread)
		? reviewCommentProse(thread.body)
		: thread.body.replace(new RegExp(FINDING_MARKER.source, 'gu'), '').trim();

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
	/**
	 * The open review thread of each finding that has one, by finding id. A comment from a
	 * review's body has none.
	 */
	threads: Schema.Record(Schema.String, Schema.String),
	/**
	 * The URLs of the open threads left out because their author may not push to the
	 * repository and is no trusted bot: anyone can comment on a public PR, and ship would
	 * act on what they say.
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

/**
 * What loading a source reads from the config: whether Clef is on, and the bots whose
 * review comments are trusted.
 */
export interface FindingsScope extends ClefScope {
	readonly config: ClefScope['config'] & {
		/** Bot logins, with or without GitHub's `[bot]` suffix, in any case. */
		readonly trustedBots: ReadonlyArray<string>;
	};
}

/**
 * Whether `account` is one of the bots that `scope` trusts. The account must be a bot: a user may
 * take a bot's login, but not its account type.
 */
const isTrustedBot = (
	scope: FindingsScope,
	account: { readonly author: string | null; readonly authorIsBot: boolean }
) =>
	account.authorIsBot &&
	account.author !== null &&
	scope.config.trustedBots.some((bot) => botLogin(bot) === account.author);

/**
 * Splits `threads` into those whose author may push to the repository or is a trusted bot,
 * and the rest's URLs.
 */
const byTrust = (scope: FindingsScope, threads: ReadonlyArray<ReviewThread>) => {
	const trusted = (thread: ReviewThread) => thread.authorCanWrite || isTrustedBot(scope, thread);
	return {
		trusted: threads.filter(trusted),
		ignoredThreads: threads.filter((thread) => !trusted(thread)).map((thread) => thread.url)
	};
};

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

/** A review comment that ship has no label for, as Clef is asked about it. */
interface UnlabelledComment {
	readonly path: string;
	readonly line: number | null;
	/** The comment's text, as the finding would claim it. */
	readonly text: string;
	/** Where the comment is on GitHub, for the log. */
	readonly url: string;
}

/**
 * What an unlabelled comment is, as Clef rates it: its most probable kind. Without Clef's
 * answer, a must-fix, as before Clef.
 */
const commentKind = Effect.fnUntraced(function* (scope: ClefScope, comment: UnlabelledComment) {
	const answers = yield* (yield* Clef).ask(scope, {
		decision: 'Treating an unlabelled review comment as a must-fix',
		state: [
			`File: ${comment.path}${comment.line === null ? '' : `:${comment.line}`}`,
			'',
			'Comment:',
			comment.text
		].join('\n'),
		questions: { kind: THREAD_QUESTION }
	});
	if (answers === null) return 'must-fix';
	const { pick, probabilities } = answers.kind;
	yield* Effect.logInfo(
		`Review comment ${comment.url}: ${pick} (clef: p=${(probabilities[pick] ?? 0).toFixed(2)})`
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
	scope: FindingsScope,
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
			const text = commentText(thread);
			// A bot's or CodeRabbit's comment with no prose left is no finding. Its claim
			// would be empty, so the fix agent would have only the comment's URL to go on,
			// and the page there holds the prompt that was stripped.
			if (label === null && isBotWritten(thread) && text === '')
				return Effect.succeed('none');
			return label === null
				? commentKind(scope, {
						path: thread.path,
						line: thread.line,
						text,
						url: thread.url
					})
				: Effect.succeed(label);
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

/**
 * The comments that trusted bots listed only in their reviews' bodies, as findings of the
 * kind that Clef rates each, reported by `github:<bot>` with the review's URL as evidence. Only
 * each bot's latest review with a body counts: CodeRabbit lists the comments on the
 * commits that it last reviewed, and an earlier review's comments cannot be resolved, so they
 * would stay findings for good. A comment takes the id `cr-<hash>` from CodeRabbit's
 * marker, so it keeps its id as the review is edited. None has a thread.
 */
const fromReviewBodies = Effect.fnUntraced(function* (
	scope: FindingsScope,
	reviews: ReadonlyArray<PrReview>
) {
	// A later review by the same bot replaces an earlier one.
	const latest = new Map(
		reviews.flatMap((review) =>
			review.author !== null && review.body.trim() !== '' && isTrustedBot(scope, review)
				? [[review.author, review] as const]
				: []
		)
	);
	const comments = [...latest].flatMap(([author, review]) =>
		parseCodeRabbitReviewBody(review.body).map((comment) => ({ author, review, comment }))
	);
	const kinds = yield* Effect.forEach(
		comments,
		({ review, comment }) => commentKind(scope, { ...comment, url: review.url }),
		{ concurrency: 'unbounded' }
	);
	return comments.flatMap(
		({ author, review, comment }, index): ReadonlyArray<VerifiedFinding> => {
			const kind = kinds[index] ?? 'none';
			if (kind === 'none') return [];
			return [
				{
					reviewer: `github:${author}`,
					file: comment.path,
					line: comment.line,
					severity: kind,
					claim: comment.text,
					evidence: review.url,
					id: FindingId.make(`cr-${comment.hash}`),
					round: 1,
					alsoReportedBy: []
				}
			];
		}
	);
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
 * open threads. A PR's findings also count the open threads of the bots that `scope`
 * trusts, and the comments that those bots listed in their latest review's body, which
 * have no thread. Clef rates the unlabelled threads and comments of a PR, unless
 * `scope`'s project turned it off. Fails with `ReviewNotFound` for an unknown review,
 * `ReviewWithoutPr` for a review of a branch without a PR, `PrNotFound` when the PR cannot
 * be read, and `GhError` when its threads or reviews cannot.
 */
export const loadFindings = Effect.fn('loadFindings')(function* (
	repo: GitRepo,
	source: FindingsSource,
	scope: FindingsScope
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
		const { trusted, ignoredThreads } = byTrust(scope, yield* gh.reviewThreads(repo, pr.url));
		const fromPr = yield* fromThreads(scope, trusted);
		// Only a trusted bot's review body counts, so there is nothing to read without one.
		const fromBodies =
			scope.config.trustedBots.length === 0
				? []
				: yield* fromReviewBodies(scope, yield* gh.reviews(repo, pr.url));
		return {
			pr,
			loaded: {
				findings: [...fromPr.findings, ...fromBodies],
				threads: fromPr.threads,
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
		scope,
		review.postedUrl === null ? [] : yield* gh.reviewThreads(repo, pr.url)
	);
	return {
		pr,
		loaded: { ...fromReview(review, trusted), ignoredThreads, intent: review.subject.intent }
	};
});
