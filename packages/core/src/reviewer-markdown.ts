import { Effect, Schema, SchemaIssue } from 'effect';
import { parse as parseYaml } from 'yaml';
import { configParseOptions } from './config.ts';
import { ReviewerDef, ReviewerFrontmatter } from './reviewer.ts';

/** A reviewer file could not be read or does not hold a valid reviewer. */
export class ReviewerFileError extends Schema.TaggedError<ReviewerFileError>()(
	'ReviewerFileError',
	{
		path: Schema.String,
		detail: Schema.String
	}
) {
	override get message(): string {
		return `Invalid reviewer ${this.path}: ${this.detail}`;
	}
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;

/**
 * Splits a markdown file into its YAML frontmatter and its body. The frontmatter is the
 * block between a `---` first line and the next `---` line.
 */
export const splitFrontmatter = (
	text: string
): { readonly frontmatter: string; readonly body: string } | null => {
	const content = text.replace(/^\uFEFF/u, '');
	const match = FRONTMATTER.exec(content);
	if (match === null) return null;
	return { frontmatter: match[1] ?? '', body: content.slice(match[0].length) };
};

const decodeFrontmatter = Schema.decodeUnknownEffect(ReviewerFrontmatter, configParseOptions);
const formatIssue = SchemaIssue.makeFormatterDefault();

/**
 * Parses a reviewer file: YAML frontmatter (`name`, `triggers`, `model`, `blocking`) and a
 * markdown body, the brief. `name` must match the file name without `.md`, so a project
 * file overrides the built-in it is named after.
 */
export const parseReviewerMarkdown = Effect.fn('parseReviewerMarkdown')(function* (
	path: string,
	text: string
) {
	const fail = (detail: string) => Effect.fail(new ReviewerFileError({ path, detail }));
	const parts = splitFrontmatter(text);
	if (parts === null) return yield* fail('missing a `---` frontmatter block');
	const yaml = yield* Effect.try({
		try: () => parseYaml(parts.frontmatter, { prettyErrors: false }) as unknown,
		catch: (error) =>
			new ReviewerFileError({
				path,
				detail: `frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`
			})
	});
	const frontmatter = yield* decodeFrontmatter(yaml ?? {}).pipe(
		Effect.mapError(
			(error) => new ReviewerFileError({ path, detail: formatIssue(error.issue) })
		)
	);
	const fileName = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/u, '');
	if (frontmatter.name !== fileName) {
		return yield* fail(`name "${frontmatter.name}" does not match the file name "${fileName}"`);
	}
	const brief = parts.body.trim();
	if (brief === '') return yield* fail('the brief (the markdown body) is empty');
	return { ...frontmatter, brief } satisfies ReviewerDef;
});
