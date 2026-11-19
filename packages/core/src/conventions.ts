import { Context, Effect, FileSystem, Layer, Schema, SchemaIssue } from 'effect';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { configParseOptions } from './config.ts';
import { Git, type GitError, type GitRepo } from './git.ts';
import { splitFrontmatter } from './reviewer-markdown.ts';
import { ReviewerName, ReviewerTriggers, type ReviewerFrontmatter } from './reviewer.ts';
import { matchTriggers, type ReviewChanges } from './router.ts';

// --- Built-in conventions ---

/**
 * The conventions: `<topic>.md` (with `<topic>.details.md` for some) and
 * `references/<name>/`. Resolved next to this module like `BUILTIN_BRIEFS_DIR`; the CLI
 * build copies `src/conventions` to `dist/conventions`, so keep this module directly in `src/`.
 */
export const BUILTIN_CONVENTIONS_DIR = fileURLToPath(new URL('./conventions', import.meta.url));

/** The references every implementer gets; reviewers get those their brief lists. */
export const CONVENTION_REFERENCES = [
	'software-design-philosophy',
	'codebase-design',
	'testing'
] as const;

// --- Topics ---

/** The frontmatter of a topic's base file, `<topic>.md`. */
export const ConventionFrontmatter = Schema.Struct({
	/** The file name without `.md`. */
	name: ReviewerName,
	description: Schema.NonEmptyString,
	/**
	 * Dependency names; the topic applies when the repo uses any of them. `typescript`
	 * also matches a tracked `tsconfig.json`.
	 */
	stack: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
	/** When set, a reviewer gets the topic only when they match the change. */
	triggers: Schema.optionalKey(ReviewerTriggers)
});
export interface ConventionFrontmatter extends Schema.Schema.Type<typeof ConventionFrontmatter> {}

/** A topic: its frontmatter and the absolute paths of its files. */
export interface Convention extends ConventionFrontmatter {
	/** `<topic>.md`: what a reviewer can't catch on the diff. Implementers and reviewers read it. */
	readonly base: string;
	/** `<topic>.details.md`: what a reviewer checks on the diff; only reviewers read it. */
	readonly details: string | null;
}

/** A convention file could not be read or does not hold a valid topic. */
export class ConventionFileError extends Schema.TaggedError<ConventionFileError>()(
	'ConventionFileError',
	{
		path: Schema.String,
		detail: Schema.String
	}
) {
	override get message(): string {
		return `Invalid convention ${this.path}: ${this.detail}`;
	}
}

const decodeFrontmatter = Schema.decodeUnknownEffect(ConventionFrontmatter, configParseOptions);
const formatIssue = SchemaIssue.makeFormatterDefault();

/** Parses a topic's base file. `name` must match the file name without `.md`. */
export const parseConventionMarkdown = Effect.fn('parseConventionMarkdown')(function* (
	path: string,
	text: string
) {
	const fail = (detail: string) => Effect.fail(new ConventionFileError({ path, detail }));
	const parts = splitFrontmatter(text);
	if (parts === null) return yield* fail('missing a `---` frontmatter block');
	const yaml = yield* Effect.try({
		try: () => parseYaml(parts.frontmatter, { prettyErrors: false }) as unknown,
		catch: (error) =>
			new ConventionFileError({
				path,
				detail: `frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`
			})
	});
	const frontmatter = yield* decodeFrontmatter(yaml ?? {}).pipe(
		Effect.mapError(
			(error) => new ConventionFileError({ path, detail: formatIssue(error.issue) })
		)
	);
	const fileName = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/u, '');
	if (frontmatter.name !== fileName) {
		return yield* fail(`name "${frontmatter.name}" does not match the file name "${fileName}"`);
	}
	return frontmatter;
});

// --- Stack ---

/** The dependency fields of a `package.json` that make up the stack. */
const DEPENDENCY_FIELDS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies'
] as const;

/** The dependency names in a `package.json`'s text; none when it is not a JSON object. */
export const packageDependencies = (text: string): ReadonlyArray<string> => {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return [];
	}
	if (typeof json !== 'object' || json === null) return [];
	return DEPENDENCY_FIELDS.flatMap((field) => {
		const deps = (json as Record<string, unknown>)[field];
		return typeof deps === 'object' && deps !== null ? Object.keys(deps) : [];
	});
};

// --- Selection ---

/** The topics that apply, and the dir they and the references live in. */
export interface ConventionScope {
	/** The conventions dir, which agents given conventions may read. */
	readonly dir: string;
	/** The topics whose stack matches the repo, minus `conventions.disable`. */
	readonly topics: ReadonlyArray<Convention>;
}

export interface SelectInput {
	readonly topics: ReadonlyArray<Convention>;
	/** Dependency names the repo uses, from `Conventions.stack`. */
	readonly stack: ReadonlySet<string>;
	/** The change under review; when set, a topic with triggers applies only if they match. */
	readonly changes?: ReviewChanges;
	/** Topic names to skip, from the project's `conventions.disable`. */
	readonly disable: ReadonlyArray<string>;
}

/** The topics that apply to the repo and, when given, the change. */
export const selectConventions = (input: SelectInput): ReadonlyArray<Convention> =>
	input.topics.filter(
		(topic) =>
			!input.disable.includes(topic.name) &&
			topic.stack.some((name) => input.stack.has(name)) &&
			(input.changes === undefined ||
				topic.triggers === undefined ||
				matchTriggers(topic.triggers, input.changes).length > 0)
	);

const referencePath = (dir: string, name: string) => `${dir}/references/${name}/SKILL.md`;

/** What an implementer reads: every applying topic's base file, then every reference. */
export const implementerConventionFiles = (scope: ConventionScope): ReadonlyArray<string> => [
	...scope.topics.map((topic) => topic.base),
	...CONVENTION_REFERENCES.map((name) => referencePath(scope.dir, name))
];

/**
 * What a reviewer reads, from its brief's `conventions` list: each listed topic that
 * applies, base then details, and each listed reference. `'*'` lists every topic.
 */
export const reviewerConventionFiles = (
	scope: ConventionScope,
	list: ReviewerFrontmatter['conventions']
): ReadonlyArray<string> => {
	if (list === undefined) return [];
	const topicFiles = (topic: Convention) =>
		topic.details === null ? [topic.base] : [topic.base, topic.details];
	if (list === '*') return scope.topics.flatMap(topicFiles);
	return list.flatMap((entry) => {
		if (entry.startsWith('references/')) {
			return [referencePath(scope.dir, entry.slice('references/'.length))];
		}
		const topic = scope.topics.find((candidate) => candidate.name === entry);
		return topic === undefined ? [] : topicFiles(topic);
	});
};

/** Tells agents given conventions that the repo's own written rules win. */
export const REPO_RULES_WIN =
	"Where these conventions conflict with the repository's own written rules (AGENTS.md, CLAUDE.md, its docs), the repository's rules win.";

// --- Service ---

export interface ConventionsShape {
	/** The conventions dir. */
	readonly dir: string;
	/** Every topic, sorted by name, read once when the layer is built. */
	readonly topics: ReadonlyArray<Convention>;
	/**
	 * The dependency names in every git-tracked `package.json`, at any depth, plus
	 * `typescript` when a `tsconfig.json` is tracked.
	 */
	readonly stack: (repo: GitRepo) => Effect.Effect<ReadonlySet<string>, GitError>;
	/**
	 * The topics that apply to the repo, minus `disable`; with `changes`, a topic with
	 * triggers applies only when they match.
	 */
	readonly scope: (input: {
		readonly repo: GitRepo;
		readonly disable: ReadonlyArray<string>;
		readonly changes?: ReviewChanges;
	}) => Effect.Effect<ConventionScope, GitError>;
}

const make = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const git = yield* Git;

		const fileError = (path: string) => (error: { message: string }) =>
			new ConventionFileError({ path, detail: error.message });

		const readTopics = Effect.gen(function* () {
			const exists = yield* fs.exists(dir).pipe(Effect.mapError(fileError(dir)));
			if (!exists) {
				return yield* new ConventionFileError({
					path: dir,
					detail: 'The conventions are missing; ship was packaged without them'
				});
			}
			const names = yield* fs.readDirectory(dir).pipe(Effect.mapError(fileError(dir)));
			return yield* Effect.forEach(
				names
					.filter((name) => name.endsWith('.md') && !name.endsWith('.details.md'))
					.filter((name) => name !== 'README.md')
					.toSorted(),
				(name) =>
					Effect.gen(function* () {
						const base = `${dir}/${name}`;
						const text = yield* fs
							.readFileString(base)
							.pipe(Effect.mapError(fileError(base)));
						const frontmatter = yield* parseConventionMarkdown(base, text);
						const details = `${dir}/${frontmatter.name}.details.md`;
						const hasDetails = names.includes(`${frontmatter.name}.details.md`);
						return {
							...frontmatter,
							base,
							details: hasDetails ? details : null
						} satisfies Convention;
					})
			);
		});
		const topics = yield* readTopics;

		const stack = Effect.fn('Conventions.stack')(function* (repo: GitRepo) {
			const [root, files] = yield* Effect.all([
				git.repoRoot(repo),
				git.trackedFiles(repo, ['package.json', 'tsconfig.json'])
			]);
			const names = new Set<string>();
			for (const path of files) {
				if (path === 'tsconfig.json' || path.endsWith('/tsconfig.json')) {
					names.add('typescript');
					continue;
				}
				// A tracked file can be deleted in the working tree; it then adds nothing.
				const text = yield* fs
					.readFileString(`${root}/${path}`)
					.pipe(Effect.orElseSucceed(() => ''));
				for (const name of packageDependencies(text)) names.add(name);
			}
			return names;
		});

		const scope = Effect.fn('Conventions.scope')(function* (input: {
			readonly repo: GitRepo;
			readonly disable: ReadonlyArray<string>;
			readonly changes?: ReviewChanges;
		}) {
			const repoStack = yield* stack(input.repo);
			return {
				dir,
				topics: selectConventions({
					topics,
					stack: repoStack,
					disable: input.disable,
					...(input.changes === undefined ? {} : { changes: input.changes })
				})
			} satisfies ConventionScope;
		});

		return Conventions.of({ dir, topics, stack, scope });
	});

export class Conventions extends Context.Service<Conventions, ConventionsShape>()(
	'@ship/core/Conventions'
) {
	/**
	 * The conventions bundled with ship. Needs `Git` and `FileSystem`; fails with
	 * `ConventionFileError` when a topic is missing or invalid, a packaging bug.
	 */
	static readonly layer = Layer.effect(this, make(BUILTIN_CONVENTIONS_DIR));
	/** Conventions from `dir` instead, for tests. */
	static readonly layerWithDir = (dir: string) => Layer.effect(this, make(dir));
}

// --- Prompts ---

/**
 * The conventions section of the implementer's prompts: the design guidance, the
 * philosophy, and the files to read by absolute path.
 */
export const implementerConventionsSection = (scope: ConventionScope): string =>
	[
		'## Conventions',
		'',
		"Research before building: before writing a workaround, a custom plugin or a helper, check the upstream project: the latest version's changelog, its issue tracker, and the library's own primitives. Report what you found, even when it's nothing.",
		'',
		"Follow John Ousterhout's _A Philosophy of Software Design_ in every change: architecture, interface design, refactors and bug fixes. The `software-design-philosophy` reference is the rubric, and `codebase-design` gives the vocabulary for one module (module, interface, seam, adapter, depth). Where the two disagree on how depth is measured, `codebase-design`'s depth-as-leverage applies.",
		'',
		'- **Consistency over personal preference**: follow these patterns even if you would do it differently.',
		'- **Readability over cleverness**: code is read more than written.',
		'- **Type safety**: let the type checker catch errors early.',
		'',
		'Before writing code, read the files below that apply to your work:',
		'',
		...implementerConventionFiles(scope).map((file) => `- ${file}`),
		'',
		REPO_RULES_WIN
	].join('\n');
