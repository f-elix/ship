import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
	BUILTIN_BRIEFS_DIR,
	BUILTIN_CONVENTIONS_DIR,
	Conventions,
	IMPLEMENTER_REFERENCES,
	implementerConventionFiles,
	implementerConventionsSection,
	packageDependencies,
	parseConventionMarkdown,
	REPO_RULES_WIN,
	reviewerConventionFiles,
	reviewerPrompt,
	ReviewerTriggers,
	selectConventions,
	splitFrontmatter,
	type Convention,
	type ConventionScope,
	type ReviewChanges,
	type ReviewerDef,
	type ReviewSubject
} from '../src/index.ts';
import { fakeSha, GitFake } from '../src/testing.ts';
import { GitLive, tempRepo } from './temp-repo.ts';

const DIR = BUILTIN_CONVENTIONS_DIR;

const bundled = Effect.gen(function* () {
	return (yield* Conventions).topics;
}).pipe(
	Effect.provide(
		Conventions.layer.pipe(Layer.provide(GitFake.layer()), Layer.provide(NodeServices.layer))
	)
);

const topics: ReadonlyArray<Convention> = await Effect.runPromise(bundled);

const bundledFiles = (
	readdirSync(DIR, { recursive: true, withFileTypes: true }) as Array<{
		isFile: () => boolean;
		parentPath: string;
		name: string;
	}>
)
	.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
	.map((entry) => join(entry.parentPath, entry.name));

describe('bundled conventions', () => {
	it("resolves every entry in a built-in brief's conventions list", () => {
		const briefsDir = join(BUILTIN_BRIEFS_DIR, 'reviewers');
		for (const file of readdirSync(briefsDir).filter((name) => name.endsWith('.md'))) {
			const parts = splitFrontmatter(readFileSync(join(briefsDir, file), 'utf8'));
			const list = (parseYaml(parts?.frontmatter ?? '') as { conventions?: unknown })
				.conventions;
			if (list === undefined || list === '*') continue;
			for (const entry of list as ReadonlyArray<string>) {
				const exists = entry.startsWith('references/')
					? existsSync(join(DIR, entry, 'SKILL.md'))
					: topics.some((topic) => topic.name === entry);
				expect(exists, `${file}: ${entry}`).toBe(true);
			}
		}
	});

	it('parses every topic with the stack the spec gives it', () => {
		expect(Object.fromEntries(topics.map((topic) => [topic.name, topic.stack]))).toEqual({
			comments: ['typescript'],
			effect: ['effect'],
			'error-handling': ['effect'],
			'file-organization': ['typescript'],
			styling: ['tailwindcss'],
			'svelte-components': ['svelte'],
			'test-cases': ['typescript'],
			testing: ['typescript'],
			typescript: ['typescript']
		});
		for (const topic of topics) {
			expect(topic.description, topic.name).not.toBe('');
			expect(topic.base).toBe(`${DIR}/${topic.name}.md`);
		}
	});

	it('pairs a details file with its base file by name', () => {
		expect(
			topics.filter((topic) => topic.details !== null).map((topic) => topic.details)
		).toEqual([
			`${DIR}/comments.details.md`,
			`${DIR}/effect.details.md`,
			`${DIR}/error-handling.details.md`,
			`${DIR}/styling.details.md`,
			`${DIR}/svelte-components.details.md`,
			`${DIR}/typescript.details.md`
		]);
	});

	it('ships every implementer reference', () => {
		for (const name of IMPLEMENTER_REFERENCES) {
			expect(existsSync(`${DIR}/references/${name}/SKILL.md`), name).toBe(true);
		}
	});

	it('leaves no house-rules template in any file', () => {
		expect(bundledFiles.length).toBeGreaterThan(10);
		for (const file of bundledFiles) {
			expect(readFileSync(file, 'utf8'), file).not.toMatch(/\{\{\s*(?:rel|path):/u);
		}
	});

	it('links only to files that exist', () => {
		for (const file of bundledFiles) {
			const text = readFileSync(file, 'utf8');
			for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/gu)) {
				if (target === undefined || /^[a-z]+:/u.test(target) || target.startsWith('#')) {
					continue;
				}
				const path = join(dirname(file), target.replace(/#.*$/u, ''));
				expect(existsSync(path), `${file} → ${target}`).toBe(true);
			}
		}
	});
});

describe('parseConventionMarkdown', () => {
	const parse = (text: string) =>
		Effect.runSync(Effect.flip(parseConventionMarkdown('/c/styling.md', text))).detail;

	it('rejects a name that does not match the file, and a missing stack', () => {
		expect(parse('---\nname: other\ndescription: D.\nstack: [x]\n---\nBody')).toContain(
			'does not match'
		);
		expect(parse('---\nname: styling\ndescription: D.\nstack: []\n---\nBody')).toContain(
			'stack'
		);
		expect(parse('# No frontmatter')).toContain('frontmatter');
	});
});

describe('packageDependencies', () => {
	it('reads every dependency field and ignores what is not a JSON object', () => {
		expect(
			packageDependencies(
				JSON.stringify({
					dependencies: { effect: '1' },
					devDependencies: { typescript: '1' },
					peerDependencies: { svelte: '1' },
					optionalDependencies: { tailwindcss: '1' },
					scripts: { build: 'x' }
				})
			)
		).toEqual(['effect', 'typescript', 'svelte', 'tailwindcss']);
		expect(packageDependencies('not json')).toEqual([]);
		expect(packageDependencies('[1]')).toEqual([]);
	});
});

describe('Conventions.stack', () => {
	const stackOf = (setup: (repo: Effect.Success<typeof tempRepo>) => void) =>
		Effect.gen(function* () {
			const repo = yield* tempRepo;
			setup(repo);
			const conventions = yield* Conventions;
			return [...(yield* conventions.stack(repo.repo))].toSorted();
		}).pipe(
			Effect.provide(Conventions.layer.pipe(Layer.provide([GitLive, NodeServices.layer]))),
			Effect.scoped
		);

	it.effect('reads tracked package.json files at the root and nested', () =>
		Effect.gen(function* () {
			const names = yield* stackOf((repo) => {
				repo.write('package.json', JSON.stringify({ devDependencies: { vitest: '1' } }));
				repo.write(
					'packages/app/package.json',
					JSON.stringify({ dependencies: { effect: '1', svelte: '5' } })
				);
				repo.write('packages/app/node-only/package.json', '{ invalid');
				repo.git('add', '.');
				// Untracked: not part of the repo's stack.
				repo.write(
					'scratch/package.json',
					JSON.stringify({ dependencies: { react: '1' } })
				);
			});
			expect(names).toEqual(['effect', 'svelte', 'vitest']);
		})
	);

	it.effect('counts a tracked tsconfig.json as typescript', () =>
		Effect.gen(function* () {
			const names = yield* stackOf((repo) => {
				repo.write('apps/web/tsconfig.json', '{}');
				repo.git('add', '.');
			});
			expect(names).toEqual(['typescript']);
		})
	);

	it.effect('is empty in a repo with no package.json', () =>
		Effect.gen(function* () {
			expect(yield* stackOf(() => {})).toEqual([]);
		})
	);
});

// --- Selection ---

const topic = (
	name: string,
	stack: ReadonlyArray<string>,
	triggers?: Partial<typeof ReviewerTriggers.Encoded>,
	details = false
): Convention => ({
	name,
	description: `The ${name} topic.`,
	stack,
	...(triggers === undefined
		? {}
		: { triggers: Schema.decodeUnknownSync(ReviewerTriggers)(triggers) }),
	base: `/c/${name}.md`,
	details: details ? `/c/${name}.details.md` : null
});

const sample = [
	topic('comments', ['typescript'], { fileKinds: ['source'] }, true),
	topic('effect', ['effect']),
	topic('svelte-components', ['svelte'], { paths: ['**/*.svelte'] }),
	topic('typescript', ['typescript'])
];

const changes = (...paths: ReadonlyArray<string>): ReviewChanges => ({
	files: paths.map((path) => ({ path, status: 'modified' })),
	addedLines: {}
});

const names = (selected: ReadonlyArray<Convention>) => selected.map((t) => t.name);

describe('selectConventions', () => {
	it('picks by stack only for the implementer, ignoring triggers', () => {
		expect(
			names(
				selectConventions({
					topics: sample,
					stack: new Set(['typescript', 'svelte'])
				})
			)
		).toEqual(['comments', 'svelte-components', 'typescript']);
	});

	it('keeps a topic with triggers for a change only when they match', () => {
		const select = (...paths: ReadonlyArray<string>) =>
			names(
				selectConventions({
					topics: sample,
					stack: new Set(['typescript', 'svelte']),
					changes: changes(...paths)
				})
			);
		expect(select('README.md')).toEqual(['typescript']);
		expect(select('src/a.ts')).toEqual(['comments', 'typescript']);
		expect(select('src/App.svelte')).toEqual(['comments', 'svelte-components', 'typescript']);
	});
});

const scope: ConventionScope = { dir: '/c', topics: sample.filter((t) => t.name !== 'effect') };

describe('implementerConventionFiles', () => {
	it('lists every base file, then every reference, never a details file', () => {
		expect(implementerConventionFiles(scope)).toEqual([
			'/c/comments.md',
			'/c/svelte-components.md',
			'/c/typescript.md',
			'/c/references/codebase-design/SKILL.md',
			'/c/references/testing/SKILL.md'
		]);
	});
});

describe('reviewerConventionFiles', () => {
	it('gives every applying topic for *, base then details', () => {
		expect(reviewerConventionFiles(scope, '*')).toEqual([
			'/c/comments.md',
			'/c/comments.details.md',
			'/c/svelte-components.md',
			'/c/typescript.md'
		]);
	});

	it('gives listed references always and listed topics only when they apply', () => {
		expect(
			reviewerConventionFiles(scope, ['effect', 'comments', 'references/codebase-design'])
		).toEqual([
			'/c/comments.md',
			'/c/comments.details.md',
			'/c/references/codebase-design/SKILL.md'
		]);
	});

	it('gives nothing to a reviewer with no list', () => {
		expect(reviewerConventionFiles(scope, undefined)).toEqual([]);
	});
});

// --- Prompts ---

const reviewer = (conventions?: ReviewerDef['conventions']): ReviewerDef => ({
	name: 'standards',
	triggers: Schema.decodeUnknownSync(ReviewerTriggers)({ always: true }),
	blocking: true,
	brief: 'The standards brief.',
	...(conventions === undefined ? {} : { conventions })
});

const subject: ReviewSubject = {
	diff: '',
	commits: [{ sha: fakeSha(1), subject: 'Add a' }],
	specPath: '/plans/x/spec.md',
	planPath: '/plans/x/implementation-plan.md',
	conventions: scope
};

describe('conventions in prompts', () => {
	it('lists a reviewer’s files and says how their rules count', () => {
		const prompt = reviewerPrompt(reviewer(['comments']), subject);
		expect(prompt).toContain('## Conventions');
		expect(prompt).toContain('- /c/comments.md\n- /c/comments.details.md');
		expect(prompt).toContain('counts as a written project rule');
		expect(prompt).toContain(REPO_RULES_WIN);
		expect(prompt.indexOf('## Conventions')).toBeLessThan(prompt.indexOf('## The change'));
	});

	it('leaves the section out when the reviewer gets no file', () => {
		expect(reviewerPrompt(reviewer(), subject)).not.toContain('## Conventions');
		expect(reviewerPrompt(reviewer(['effect']), subject)).not.toContain('## Conventions');
	});

	it('gives the implementer the guidance, the files and the repo-wins rule', () => {
		const section = implementerConventionsSection(scope);
		expect(section).toContain('Research before building');
		expect(section).toContain('_A Philosophy of Software Design_');
		expect(section).toContain('**Consistency over personal preference**');
		for (const file of implementerConventionFiles(scope)) {
			expect(section).toContain(`- ${file}`);
		}
		expect(section).toContain(REPO_RULES_WIN);
		expect(section).not.toContain('docs/conventions');
	});
});
