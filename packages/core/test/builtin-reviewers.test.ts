import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { existsSync, readFileSync } from 'node:fs';
import {
	BUILTIN_BRIEFS_DIR,
	BUILTIN_CONVENTIONS_DIR,
	Reviewers,
	routeDeterministic,
	type ReviewChanges,
	type ReviewerDef
} from '../src/index.ts';
import { AgentFake, ClefFake } from '../src/testing.ts';

const loadBuiltins = Effect.gen(function* () {
	const reviewers = yield* Reviewers;
	return yield* reviewers.load({ projectDir: '/nonexistent', disable: [] });
}).pipe(
	Effect.provide(
		Reviewers.layer.pipe(
			Layer.provide([AgentFake.layer, ClefFake.layer]),
			Layer.provide(NodeServices.layer)
		)
	)
);

const builtins: ReadonlyArray<ReviewerDef> = await Effect.runPromise(loadBuiltins);

describe('built-in reviewers', () => {
	it('every shipped brief parses and validates', () => {
		expect(builtins.map((reviewer) => reviewer.name)).toEqual([
			'comments',
			'contracts',
			'data',
			'deps',
			'design',
			'domain-language',
			'error-handling',
			'performance',
			'security',
			'spec',
			'standards',
			'tests',
			'ui-a11y'
		]);
	});

	it('gives each reviewer a description for Clef and a known model alias', () => {
		for (const reviewer of builtins) {
			expect(reviewer.description, reviewer.name).toBeDefined();
			expect([undefined, 'haiku', 'sonnet', 'opus'], reviewer.name).toContain(reviewer.model);
		}
	});

	it('gives each reviewer the conventions the spec lists for it', () => {
		expect(
			Object.fromEntries(
				builtins.flatMap((reviewer) =>
					reviewer.conventions === undefined
						? []
						: [[reviewer.name, reviewer.conventions]]
				)
			)
		).toEqual({
			comments: ['comments'],
			design: [
				'references/software-design-philosophy',
				'references/codebase-design',
				'file-organization'
			],
			'error-handling': ['error-handling'],
			standards: '*',
			tests: ['testing', 'test-cases', 'references/testing'],
			'ui-a11y': ['svelte-components', 'styling']
		});
		for (const reviewer of builtins) {
			if (reviewer.conventions === undefined || reviewer.conventions === '*') continue;
			for (const entry of reviewer.conventions) {
				const path = entry.startsWith('references/')
					? `${BUILTIN_CONVENTIONS_DIR}/${entry}/SKILL.md`
					: `${BUILTIN_CONVENTIONS_DIR}/${entry}.md`;
				expect(existsSync(path), `${reviewer.name}: ${entry}`).toBe(true);
			}
		}
	});

	it('tells the verifier that a quoted convention rule is a written project rule', () => {
		const brief = readFileSync(`${BUILTIN_BRIEFS_DIR}/verifier.md`, 'utf8');
		expect(brief).toContain("Written project rules include ship's conventions");
	});

	it('ships a verifier brief', () => {
		const brief = readFileSync(`${BUILTIN_BRIEFS_DIR}/verifier.md`, 'utf8');
		expect(brief).toContain('## Falsify each finding');
		expect(brief).toContain('## Previous findings');
	});
});

describe('routing with the built-in triggers', () => {
	const change = (files: Record<string, ReadonlyArray<string>>): ReviewChanges => ({
		files: Object.keys(files).map((path) => ({ path, status: 'modified' })),
		addedLines: files
	});
	const always = ['spec', 'standards'];
	const source = [...always, 'tests'];

	it.each([
		['a docs edit', { 'README.md': ['# Usage', 'Run it.'] }, ['comments', ...always]],
		['a plain source edit', { 'src/util.ts': ['const total = a + b;'] }, source],
		[
			'a component',
			{ 'src/App.tsx': ['return <button onClick={go}>Go</button>;'] },
			[...source, 'ui-a11y']
		],
		['a stylesheet', { 'styles/main.css': ['.a { color: red; }'] }, [...always, 'ui-a11y']],
		[
			'a dependency bump',
			{ 'package.json': ['"left-pad": "1.3.1",'], 'pnpm-lock.yaml': ['  version: 1.3.1'] },
			['deps', ...always]
		],
		[
			'a migration',
			{ 'db/migrations/002.sql': ['ALTER TABLE runs ADD COLUMN cost REAL;'] },
			['data', ...source]
		],
		[
			'a new table in a store module',
			{ 'packages/store/src/schema.ts': ['CREATE TABLE runs (id TEXT PRIMARY KEY)'] },
			['data', 'design', ...source]
		],
		[
			'a shell command',
			{ 'src/run.ts': ['const out = execSync(`git ${args}`);'] },
			['performance', 'security', ...source]
		],
		[
			'a password check',
			{ 'src/login.ts': ['if (password === stored) {'] },
			['security', ...source]
		],
		['an auth module', { 'src/auth/session.ts': ['const x = 1;'] }, ['security', ...source]],
		[
			'a new service',
			{
				'src/run-store.ts': [
					"export class RunStore extends Context.Service<RunStore>()('RunStore') {}"
				]
			},
			['design', 'domain-language', ...source]
		],
		[
			'error handling in an API route',
			{ 'src/api/save.ts': ['try {', '} catch {}'] },
			['contracts', 'error-handling', ...source]
		],
		[
			'a new exported function',
			{ 'src/save.ts': ['export async function save(run: Run) {'] },
			['design', ...source]
		],
		[
			'a new exported constant',
			{ 'src/limits.ts': ['export const MAX_RUNS = 4;'] },
			['design', ...source]
		],
		[
			'a new exported type',
			{ 'src/run.ts': ['export type RunStatus = "running" | "done";'] },
			['design', 'domain-language', ...source]
		],
		[
			'a new exported interface',
			{ 'src/run.ts': ['export interface RunSummary {'] },
			['design', 'domain-language', ...source]
		],
		[
			'a public entry point',
			{ 'src/index.ts': ["export { save } from './save.ts';"] },
			['contracts', ...source]
		],
		[
			'a glossary edit',
			{ 'CONTEXT.md': ['**Run**: one pipeline.'] },
			['comments', 'domain-language', ...always]
		],
		[
			'a code comment',
			{ 'src/a.ts': ['// Retries once; the API is flaky.'] },
			['comments', ...source]
		],
		['a CI workflow', { '.github/workflows/ci.yml': ['run: pnpm check'] }, always],
		[
			'a tagged SQL query',
			{ 'src/users.ts': ['const rows = sql`select * from users where id = ${id}`;'] },
			['data', 'security', ...source]
		],
		[
			'an ORM table',
			{ 'src/tables.ts': ["const runs = sqliteTable('runs', { id: text('id') });"] },
			['data', ...source]
		],
		[
			'an Effect child process',
			{ 'src/git.ts': ["const cmd = ChildProcess.make('git', ['status']);"] },
			['security', ...source]
		],
		[
			'a lockfile naming security packages',
			{ 'pnpm-lock.yaml': ['  cookie@0.7.2:', '  /bcrypt@5.1.1:'] },
			['deps', ...always]
		],
		['a regex exec', { 'src/parse.ts': ['const match = HUNK_HEADER.exec(line);'] }, source],
		[
			'a comment mentioning permission and cookies',
			{ 'src/a.ts': ['// Ask for permission before the session cookie expires.'] },
			['comments', ...source]
		],
		[
			'docs prose with code words',
			{ 'docs/guide.md': ['Finally, catch the secret token except when unbounded.'] },
			['comments', ...always]
		],
		[
			'an execa call',
			{ 'src/run.ts': ["await execa('git', ['push']);"] },
			['security', ...source]
		],
		[
			'a raw Prisma query',
			{ 'src/users.ts': ['await prisma.$queryRawUnsafe(query);'] },
			['security', ...source]
		],
		[
			'prose that reads like SQL',
			{ 'docs/guide.md': ['Select the file from the list, then delete from the cache.'] },
			['comments', ...always]
		],
		['a test', { 'src/a.test.ts': ['expect(add(1, 2)).toBe(3);'] }, source]
	])('routes %s', (_label, files, expected) => {
		const picked = routeDeterministic(builtins, change(files)).map(
			(routed) => routed.reviewer.name
		);
		expect(picked.toSorted()).toEqual(expected.toSorted());
	});
});
