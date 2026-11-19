import { Schema } from 'effect';
import { withDefault } from './defaults.ts';
import { ModelId } from './primitives.ts';

/**
 * Kebab-case reviewer name, e.g. `error-handling` or `ui-a11y`. Like lock resources and
 * model ids, it is written by hand in config and frontmatter, so it stays an unbranded string.
 */
export const ReviewerName = Schema.String.check(
	Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, { expected: 'a kebab-case reviewer name' })
);

/**
 * Coarse classification of a changed file, assigned by the router from its path.
 * `deps` covers manifests and lockfiles; `ui` covers components, styles and markup.
 */
export const FileKind = Schema.Literals(['source', 'test', 'docs', 'config', 'deps', 'ui']);
export type FileKind = typeof FileKind.Type;

const compilableRegExp = Schema.makeFilter(
	(pattern: string) => {
		try {
			new RegExp(pattern, 'u');
			return true;
		} catch {
			return false;
		}
	},
	{ expected: 'a valid regular expression' }
);

/**
 * Deterministic triggers. A reviewer runs when any of them matches the diff under review:
 * `always`, any changed path matching a glob in `paths`, any added line matching a
 * pattern in `addedLines` (outside `docs` files), or any changed file of a kind in `fileKinds`.
 * A reviewer with no matching trigger can still be picked by Cloudflare Clef (see `clef.ts`).
 */
export const ReviewerTriggers = Schema.Struct({
	always: Schema.Boolean.pipe(withDefault(false)),
	paths: Schema.Array(Schema.NonEmptyString).pipe(withDefault([])),
	addedLines: Schema.Array(Schema.String.check(compilableRegExp)).pipe(withDefault([])),
	fileKinds: Schema.Array(FileKind).pipe(withDefault([]))
});
export interface ReviewerTriggers extends Schema.Schema.Type<typeof ReviewerTriggers> {}

/**
 * A convention a reviewer reads: a topic name such as `testing`, or a reference such as
 * `references/testing`. See `conventions.ts`.
 */
export const ConventionRef = Schema.String.check(
	Schema.isPattern(/^(?:references\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
		expected: 'a convention topic name or references/<name>'
	})
);

/** The parsed frontmatter of a reviewer markdown file. */
export const ReviewerFrontmatter = Schema.Struct({
	name: ReviewerName,
	/**
	 * One sentence on what the reviewer covers. Clef decides from it whether to add the
	 * reviewer; without one it reads the brief's first paragraph.
	 */
	description: Schema.optionalKey(Schema.NonEmptyString),
	triggers: ReviewerTriggers.pipe(withDefault({})),
	/** Overrides the configured `review` model for this reviewer. */
	model: Schema.optionalKey(ModelId),
	/**
	 * The conventions the reviewer is given: topics, given only when they apply to the repo
	 * and the change, and references, always given. `'*'` gives every topic that applies.
	 */
	conventions: Schema.optionalKey(
		Schema.Union([Schema.Literal('*'), Schema.Array(ConventionRef)])
	)
});
export interface ReviewerFrontmatter extends Schema.Schema.Type<typeof ReviewerFrontmatter> {}

/** A reviewer: frontmatter plus the markdown body, its brief. */
export const ReviewerDef = Schema.Struct({
	...ReviewerFrontmatter.fields,
	brief: Schema.NonEmptyString
});
export interface ReviewerDef extends Schema.Schema.Type<typeof ReviewerDef> {}
