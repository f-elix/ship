import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import {
	classifyFile,
	matchTriggers,
	ReviewerTriggers,
	routeDeterministic,
	type ChangedFile,
	type ReviewChanges,
	type ReviewerDef
} from '../src/index.ts';

const triggers = (input: Partial<typeof ReviewerTriggers.Encoded>) =>
	Schema.decodeUnknownSync(ReviewerTriggers)(input);

const changes = (
	paths: ReadonlyArray<string | ChangedFile>,
	addedLines: Record<string, ReadonlyArray<string>> = {}
): ReviewChanges => ({
	files: paths.map((path) => (typeof path === 'string' ? { path, status: 'modified' } : path)),
	addedLines
});

describe('classifyFile', () => {
	it.each([
		['src/index.ts', ['source']],
		['packages/core/src/git.ts', ['source']],
		['src/App.tsx', ['ui', 'source']],
		['src/routes/+page.svelte', ['ui', 'source']],
		['styles/main.css', ['ui']],
		['public/index.html', ['ui']],
		['src/git.test.ts', ['test']],
		['packages/core/test/fixtures.ts', ['test']],
		['src/__tests__/a.js', ['test']],
		['pkg/server_test.go', ['test']],
		['tests/test_api.py', ['test']],
		['README.md', ['docs']],
		['docs/guide.mdx', ['docs']],
		['docs/diagram.png', ['docs']],
		['LICENSE', ['docs']],
		['package.json', ['deps']],
		['packages/cli/package.json', ['deps']],
		['pnpm-lock.yaml', ['deps']],
		['Cargo.lock', ['deps']],
		['requirements-dev.txt', ['deps']],
		['tsconfig.json', ['config']],
		['.github/workflows/ci.yml', ['config']],
		['vitest.config.ts', ['config']],
		['.prettierrc.cjs', ['config']],
		['.gitignore', ['config']],
		['.env.example', ['config']],
		['Dockerfile', ['config']],
		['assets/logo.png', []]
	] as const)('%s → %j', (path, kinds) => {
		expect(classifyFile(path)).toEqual(kinds);
	});
});

describe('matchTriggers', () => {
	it('matches always, path globs, added-line patterns and file kinds', () => {
		const all = triggers({
			always: true,
			paths: ['src/auth/**', '**/*.sql'],
			addedLines: ['\\beval\\(', 'TODO'],
			fileKinds: ['deps', 'ui']
		});
		const change = changes(['src/auth/session.ts', 'package.json', 'db/schema.sql'], {
			'src/auth/session.ts': ['const x = eval(input);']
		});
		expect(matchTriggers(all, change)).toEqual([
			'always',
			'path src/auth/**',
			'path **/*.sql',
			'added line /\\beval\\(/',
			'kind deps'
		]);
	});

	it('matches nothing when no trigger applies', () => {
		const t = triggers({ paths: ['src/auth/**'], addedLines: ['eval\\('], fileKinds: ['ui'] });
		expect(matchTriggers(t, changes(['src/index.ts'], { 'src/index.ts': ['ok'] }))).toEqual([]);
		expect(matchTriggers(triggers({}), changes(['src/index.ts']))).toEqual([]);
	});

	it('ignores the added lines of docs files', () => {
		const t = triggers({ addedLines: ['secret'] });
		expect(
			matchTriggers(t, changes(['README.md'], { 'README.md': ['Keep it secret.'] }))
		).toEqual([]);
		expect(
			matchTriggers(t, changes(['src/a.ts'], { 'src/a.ts': ['const secret = 1;'] }))
		).toEqual(['added line /secret/']);
	});

	it('matches the old path of a rename and deleted files', () => {
		const t = triggers({ paths: ['src/auth/**'] });
		expect(
			matchTriggers(
				t,
				changes([
					{
						path: 'src/login/session.ts',
						status: 'renamed',
						oldPath: 'src/auth/session.ts'
					}
				])
			)
		).toEqual(['path src/auth/**']);
		expect(matchTriggers(t, changes([{ path: 'src/auth/old.ts', status: 'deleted' }]))).toEqual(
			['path src/auth/**']
		);
	});

	it('needs an explicit pattern for dot-directories', () => {
		const change = changes(['.github/workflows/ci.yml']);
		expect(matchTriggers(triggers({ paths: ['**/*.yml'] }), change)).toEqual([]);
		expect(matchTriggers(triggers({ paths: ['.github/**'] }), change)).toEqual([
			'path .github/**'
		]);
	});
});

describe('routeDeterministic', () => {
	const reviewer = (name: string, t: Partial<typeof ReviewerTriggers.Encoded>): ReviewerDef => ({
		name,
		triggers: triggers(t),
		blocking: true,
		brief: `The ${name} brief.`
	});
	const reviewers = [
		reviewer('standards', { always: true }),
		reviewer('tests', { fileKinds: ['source', 'test'] }),
		reviewer('ui-a11y', { fileKinds: ['ui'] }),
		reviewer('security', { addedLines: ['password', 'token'] }),
		reviewer('deps', { fileKinds: ['deps'] }),
		reviewer('design', {})
	];

	it.each([
		['a docs-only change', changes(['README.md']), ['standards']],
		['a source change', changes(['src/a.ts']), ['standards', 'tests']],
		['a component change', changes(['src/App.tsx']), ['standards', 'tests', 'ui-a11y']],
		[
			'a change adding a secret',
			changes(['src/a.ts'], { 'src/a.ts': ['const token = read();'] }),
			['standards', 'tests', 'security']
		],
		['a dependency bump', changes(['package.json', 'pnpm-lock.yaml']), ['standards', 'deps']]
	])('routes %s', (_label, change, expected) => {
		expect(routeDeterministic(reviewers, change).map((routed) => routed.reviewer.name)).toEqual(
			expected
		);
	});

	it('keeps the reasons for each pick', () => {
		const routed = routeDeterministic(reviewers, changes(['src/App.tsx']));
		expect(routed.find((r) => r.reviewer.name === 'tests')?.reasons).toEqual(['kind source']);
	});
});
