/**
 * The `post` primitive: posts a stored review as one GitHub review on the PR's pinned
 * head, and the rules that turn findings into that review.
 */
import { Effect, Schema } from 'effect';
import { Checkpoint } from './checkpoint.ts';
import type { VerifiedFinding } from './finding.ts';
import { Gh, type ReviewComment, type ReviewEvent } from './gh.ts';
import { diffTargetPath, Git } from './git.ts';
import { primitiveScopeFields } from './primitive-scope.ts';
import type { Primitive } from './primitive.ts';
import { ReviewId, Url } from './primitives.ts';
import { StepNotReady } from './run-step.ts';
import { Reviews } from './stored-review.ts';

/** What `post` sends GitHub: the review's verdict, its body and its inline comments. */
export interface ReviewToPost {
	readonly event: ReviewEvent;
	readonly body: string;
	readonly comments: ReadonlyArray<ReviewComment>;
	/**
	 * How many findings the body lists, as `file:line` (or `file` when a finding has no
	 * line), because their line is not in the diff.
	 */
	readonly inBody: number;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

/**
 * The new-side line ranges of each file's hunks in a unified diff, context lines included:
 * the lines GitHub accepts a review comment on, on its right side.
 */
export const commentableLines = (
	diff: string
): ReadonlyMap<string, ReadonlyArray<readonly [number, number]>> => {
	const ranges = new Map<string, Array<readonly [number, number]>>();
	let file: string | null = null;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+++ ')) {
			file = diffTargetPath(line);
			continue;
		}
		const hunk = HUNK.exec(line);
		if (hunk === null || file === null) continue;
		const start = Number(hunk[1]);
		const count = Number(hunk[2] ?? '1');
		if (count === 0) continue;
		const fileRanges = ranges.get(file) ?? [];
		fileRanges.push([start, start + count - 1]);
		ranges.set(file, fileRanges);
	}
	return ranges;
};

const SEVERITY_LABEL: Readonly<Record<VerifiedFinding['severity'], string>> = {
	'must-fix': 'Must-fix',
	tradeoff: 'Tradeoff',
	nit: 'Nit'
};

const location = (finding: VerifiedFinding): string =>
	finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;

const describe = (finding: VerifiedFinding): string =>
	[
		`**${SEVERITY_LABEL[finding.severity]}** (${finding.reviewer}): ${finding.claim}`,
		'',
		`Evidence: ${finding.evidence}`
	].join('\n');

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The review `post` sends for `findings` over `diff`. A finding on a line in the diff
 * becomes an inline comment; the rest are listed in the body as `file:line`, or `file`
 * when the finding has no line. Verified must-fix findings request changes; anything else
 * only comments, and ship never approves.
 */
export const reviewToPost = (
	findings: ReadonlyArray<VerifiedFinding>,
	diff: string
): ReviewToPost => {
	const lines = commentableLines(diff);
	const inDiff = (finding: VerifiedFinding): finding is VerifiedFinding & { line: number } =>
		finding.line !== undefined &&
		(lines.get(finding.file) ?? []).some(
			([start, end]) =>
				finding.line !== undefined && finding.line >= start && finding.line <= end
		);
	const inline = findings.filter(inDiff);
	const rest = findings.filter((finding) => !inDiff(finding));
	const bySeverity = (severity: VerifiedFinding['severity']) =>
		findings.filter((finding) => finding.severity === severity).length;
	const mustFix = bySeverity('must-fix');
	const body = [
		`ship review found ${count(mustFix, 'must-fix finding')}, ${count(bySeverity('tradeoff'), 'tradeoff')} and ${count(bySeverity('nit'), 'nit')}.`,
		...(rest.length === 0
			? []
			: [
					'',
					'Findings outside the diff:',
					'',
					...rest.map((finding) => `- \`${location(finding)}\`: ${describe(finding)}`)
				])
	].join('\n');
	return {
		event: mustFix > 0 ? 'REQUEST_CHANGES' : 'COMMENT',
		body,
		comments: inline.map((finding) => ({
			path: finding.file,
			line: finding.line,
			body: describe(finding)
		})),
		inBody: rest.length
	};
};

/** The marker `post` puts in a review's body, by which it finds the review again. */
export const reviewMarker = (id: ReviewId): string => `<!-- ship-review: ${id} -->`;

export const PostInput = Schema.Struct({
	...primitiveScopeFields,
	review: ReviewId
});
export interface PostInput extends Schema.Schema.Type<typeof PostInput> {}

/**
 * `post`: posts the stored review's findings as one review on its PR, at the head it
 * reviewed, and records the review's URL on the stored review. Returns the URL, or `null`
 * when there is nothing to post: a review without findings is not posted.
 *
 * It refuses when `HEAD` moved from the reviewed head, or the review has no PR. Posting
 * is checkpointed (`post`), and the review's body carries {@link reviewMarker}: a resumed
 * `post` that finds its marker on the PR takes that review instead of posting another.
 */
export const postPrimitive = {
	name: 'post',
	input: PostInput,
	output: Schema.NullOr(Url),
	timeoutMs: () => null,
	run: (input, kit) =>
		Effect.gen(function* () {
			const reviews = yield* Reviews;
			const git = yield* Git;
			const gh = yield* Gh;
			const checkpoint = yield* Checkpoint;
			const stored = yield* reviews
				.get(input.review)
				.pipe(
					Effect.catchTag('ReviewNotFound', (error) =>
						Effect.fail(new StepNotReady({ reason: error.message }))
					)
				);
			const { subject } = stored;
			if (stored.findings.length === 0) return null;
			if (subject.prUrl === null) {
				return yield* new StepNotReady({
					reason: `The review ${stored.id} has no PR to post on`
				});
			}
			const prUrl = subject.prUrl;
			const head = yield* git.headSha(input);
			if (head !== subject.headSha) {
				return yield* new StepNotReady({
					reason: `HEAD moved from the reviewed ${subject.headSha} to ${head}; check the PR out again before posting`
				});
			}
			const diff = yield* git.diff(input, { from: subject.baseSha, to: subject.headSha });
			const toPost = reviewToPost(stored.findings, diff);
			const marker = reviewMarker(stored.id);
			const url = yield* checkpoint.once(
				'post',
				Url,
				Effect.gen(function* () {
					const found = yield* gh.findReview(input, { prUrl, marker });
					const posted =
						found ??
						(yield* gh.submitReview(input, {
							prUrl,
							commitId: subject.headSha,
							event: toPost.event,
							body: `${toPost.body}\n\n${marker}`,
							comments: toPost.comments
						}));
					yield* kit.report({
						_tag: 'PrReviewPosted',
						url: posted,
						event: toPost.event,
						inline: toPost.comments.length,
						inBody: toPost.inBody
					});
					return posted;
				})
			);
			yield* reviews.save({ ...stored, postedUrl: url });
			return url;
		})
} satisfies Primitive<PostInput, string | null, unknown>;
