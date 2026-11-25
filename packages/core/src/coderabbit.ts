/**
 * Reads CodeRabbit's review comments: the readable prose of an inline comment, and the
 * comments that CodeRabbit lists only in a review's body because GitHub would not take them
 * inline. CodeRabbit writes Markdown wrapped in HTML (`<details>`, `<picture>`), its own
 * severity line, hidden markers and a "Prompt to fix issue" for AI agents. Only the
 * title and explanation are kept: the severity is left to Clef, and a reviewer's prompt
 * is never handed to an agent.
 */

/** A comment from a CodeRabbit review body, at a place in the PR's code. */
export interface CodeRabbitBodyComment {
	/** The hash of CodeRabbit's `cr-comment` marker, stable across the review's edits. */
	readonly hash: string;
	/** Repo-relative path. */
	readonly path: string;
	/** The first line that the comment is about. */
	readonly line: number;
	/** The comment's title and explanation, as {@link reviewCommentProse} cleans them. */
	readonly text: string;
}

const MARKERS = /<!-- (?:coderabbit-ai-generated|cr-comment:v1:)/u;

/** `body` is a comment that CodeRabbit wrote: it carries one of CodeRabbit's hidden markers. */
export const isCodeRabbitComment = (body: string): boolean => MARKERS.test(body);

/** CodeRabbit's prompt for agents, to its end marker or, with none, to the comment's end. */
const AGENT_PROMPT = /<!-- ai-agent-prompt:start -->[\s\S]*?(?:<!-- ai-agent-prompt:end -->|$)/gu;
/** A `<details>` block with no `<details>` inside it. */
const INNERMOST_DETAILS = /<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details\s*>/giu;
const DETAILS_OPEN = /<details\b/iu;
const DETAILS_CLOSE = /<\/details\s*>/giu;
/** An HTML comment, to its end or, left unclosed, to the comment's end. */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/gu;
const PICTURE = /<picture\b[^>]*>[\s\S]*?<\/picture\s*>/giu;
const LAYOUT_TAG =
	/<\/?(?:details|summary|blockquote|dl|dd|dt|br|h\d|img|source|picture|strong)\b[^>]*>/giu;
/** The rating line of CodeRabbit's older format: `_⚠️ Potential issue_ | _🟠 Major_`. */
const OLD_RATING_LINE = /^_[^_\n]+_(?:\s*\|\s*_[^_\n]+_)+\s*$/u;
/**
 * CodeRabbit's rating line once its icons are gone, after an optional location:
 * `` `43-47`: ** Trivial** · **Maintainability** · **Quick win** ``.
 */
const RATING_LINE = /^(?:`[^`\n]*`:?\s*)?\*\*\s*[A-Z][a-z]+\*\*(?:\s*·\s*\*\*[^*\n]+\*\*)*\s*$/u;
/** The location line that an outside-diff comment opens with: `` `src/a.ts:78` ``. */
const LOCATION_LINE = /^`[^`\n]+:\d+(?:-\d+)?`$/u;

/**
 * The title and explanation of a CodeRabbit comment: its `<details>` blocks (the agent
 * prompt, suggested diffs, analysis), HTML comments, icons, rating line and location line
 * left out. Empty when nothing readable is left. It cleans any bot's review comment the
 * same way, so a prompt for agents hidden in a `<details>` block never reaches one.
 */
export const reviewCommentProse = (body: string): string => {
	let text = body.replace(AGENT_PROMPT, '');
	for (let previous = ''; previous !== text;) {
		previous = text;
		text = text.replace(INNERMOST_DETAILS, '');
	}
	// A tag left unpaired (one written in a code block, or a block never closed) means a
	// block's end is unknown: what may be inside one goes too, so a prompt never leaks.
	// Every close left precedes every open left, or the two would have paired.
	const close = [...text.matchAll(DETAILS_CLOSE)].at(-1);
	if (close !== undefined) text = text.slice(close.index + close[0].length);
	const open = text.search(DETAILS_OPEN);
	if (open !== -1) text = text.slice(0, open);
	return text
		.replace(HTML_COMMENT, '')
		.replace(PICTURE, '')
		.replace(LAYOUT_TAG, '')
		.split('\n')
		.map((line) => line.trim())
		.filter(
			(line) =>
				!RATING_LINE.test(line) && !OLD_RATING_LINE.test(line) && !LOCATION_LINE.test(line)
		)
		.join('\n')
		.replace(/\n{3,}/gu, '\n\n')
		.trim();
};

/** The body sections whose comments are findings, by their heading's first words. */
const KEPT_SECTIONS: ReadonlySet<string> = new Set(['Nitpick', 'Outside diff range']);

/**
 * A section heading, in a `<summary>` or a bold line: "Nitpick comments: 1" or
 * "**⚠️ Outside diff range comments (3)**", and the sections left out, such as
 * "Additional comments (2)". A comment's prose may name a section, but does not open its
 * line with `<summary>` or `**` and a section name; the "Prompt to fix all issues" block
 * repeats "Nitpick comments:" without a count.
 */
const SECTION_HEADING =
	/^(?:<summary>.*?|\*\*[^\w\n]*)([A-Z][a-z]*(?: [a-z]+)*) comments(?::\s*\d+|\s*\(\d+\))/gmu;
/** A file's group in the nitpick section: `<summary>src/a.ts: 2</summary>`. */
const FILE_SUMMARY = /<summary>([^<>\n]+?):\s*\d+<\/summary>/gu;
const COMMENT_MARKER = /<!-- cr-comment:v1:([0-9a-f]+) -->/gu;
/** A nitpick's line range, which opens its rating line: `` `43-47`: ``. */
const NITPICK_LOCATION = /^`(\d+)(?:-\d+)?`:/gmu;
/** An outside-diff comment's location line: `` `src/a.ts:78` `` or `` `src/a.ts:105-106` ``. */
const OUTSIDE_LOCATION = /^`([^`\n]+):(\d+)(?:-\d+)?`$/gmu;

/** The first match of `pattern` in `text`, or `undefined`. */
const first = (text: string, pattern: RegExp) => [...text.matchAll(pattern)][0];

/** The last match of `pattern` in `text` that starts before `end`, or `undefined`. */
const lastBefore = (text: string, pattern: RegExp, end: number) =>
	[...text.matchAll(pattern)].findLast((match) => match.index < end);

/**
 * The comment that ends at `marker` in `text` and starts at `start`, or `null` when it is
 * not in a kept section or its place or text cannot be read.
 */
const commentAt = (
	text: string,
	start: number,
	marker: RegExpExecArray
): CodeRabbitBodyComment | null => {
	const section = lastBefore(text, SECTION_HEADING, marker.index)?.[1];
	if (section === undefined || !KEPT_SECTIONS.has(section)) return null;
	const chunk = text.slice(start, marker.index);
	// The location opens the comment; a line in its explanation may look like one.
	const nitpick = first(chunk, NITPICK_LOCATION);
	const outside = first(chunk, OUTSIDE_LOCATION);
	const location =
		nitpick !== undefined && (outside === undefined || nitpick.index < outside.index)
			? {
					index: nitpick.index,
					path: lastBefore(text, FILE_SUMMARY, start + nitpick.index)?.[1],
					line: nitpick[1]
				}
			: outside === undefined
				? null
				: { index: outside.index, path: outside[1], line: outside[2] };
	if (location?.path === undefined) return null;
	const prose = reviewCommentProse(chunk.slice(location.index));
	const line = Number(location.line);
	if (prose === '' || !Number.isInteger(line) || line < 1) return null;
	return { hash: marker[1] ?? '', path: location.path.trim(), line, text: prose };
};

/**
 * The nitpick and outside-diff comments of a CodeRabbit review body, in order. Each ends
 * with a `cr-comment` marker and opens with its location: a nitpick's file is the group
 * that it is listed under, and an outside-diff comment names its own. A comment whose
 * place or text cannot be read is left out, so a body in another format gives none.
 */
export const parseCodeRabbitReviewBody = (body: string): ReadonlyArray<CodeRabbitBodyComment> => {
	// Outside-diff comments sit in a `>` quote.
	const text = body.replace(/^> ?/gmu, '');
	const markers = [...text.matchAll(COMMENT_MARKER)];
	const comments = markers.flatMap((marker, index) => {
		const previous = markers[index - 1];
		const start = previous === undefined ? 0 : previous.index + previous[0].length;
		return commentAt(text, start, marker) ?? [];
	});
	// A body may list a comment twice; the first is kept.
	return comments.filter(
		(comment, index) => comments.findIndex(({ hash }) => hash === comment.hash) === index
	);
};
