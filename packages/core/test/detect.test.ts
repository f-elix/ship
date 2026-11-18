import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { fileURLToPath } from 'node:url';
import {
	configParseOptions,
	detectProjectConfig,
	justRecipes,
	makeTargets,
	PROJECT_SCHEMA_URL,
	ProjectConfig,
	projectFilesAt
} from '../src/index.ts';
import { tempDir } from './temp-repo.ts';

const fixture = (name: string) =>
	fileURLToPath(new URL(`fixtures/detect/${name}`, import.meta.url));

/** Detects in `dir` and checks the draft is a valid project config. */
const detectIn = (dir: string) =>
	Effect.gen(function* () {
		const detection = yield* detectProjectConfig(yield* projectFilesAt(dir));
		yield* Schema.decodeUnknownEffect(ProjectConfig, configParseOptions)(detection.config);
		expect(detection.config.$schema).toBe(PROJECT_SCHEMA_URL);
		return detection;
	}).pipe(Effect.provide(NodeServices.layer));

describe('detectProjectConfig', () => {
	it.effect('drafts granular checks for a pnpm monorepo, falling back to package scripts', () =>
		Effect.gen(function* () {
			const { config, notes } = yield* detectIn(fixture('pnpm-monorepo'));
			expect(config.checks).toEqual([
				{
					name: 'format',
					run: 'pnpm run format:check',
					fix: 'pnpm run format',
					lock: 'cpu'
				},
				{ name: 'lint', run: 'pnpm run lint', fix: 'pnpm run lint:fix', lock: 'cpu' },
				{ name: 'typecheck', run: 'pnpm -r --if-present run typecheck', lock: 'cpu' },
				// The api package depends on pg.
				{ name: 'test', run: 'pnpm -r --if-present run test', lock: 'db' }
			]);
			expect(config.format).toBe('pnpm run format');
			const text = notes.join('\n');
			expect(text).toContain('Workspace with 2 packages');
			expect(text).toContain('Left out the aggregate `pnpm run check`');
			expect(text).toContain('the pg package is a dependency');
			// CI commands are hints; setup commands and commands already used are left out.
			expect(text).toContain('`pnpm -r build`, `pnpm exec playwright test`');
			expect(text).not.toContain('`pnpm install');
			expect(text).not.toContain('`pnpm run lint`,');
		})
	);

	it.effect('uses an aggregate check script when it is the only one', () =>
		Effect.gen(function* () {
			const { config, notes } = yield* detectIn(fixture('npm-check-only'));
			// The `npm init` placeholder test script is no test.
			expect(config.checks).toEqual([{ name: 'check', run: 'npm run check', lock: 'cpu' }]);
			expect(config.format).toBeUndefined();
			expect(notes.join('\n')).not.toContain('assumed npm');
		})
	);

	it.effect('prefers Makefile targets over package.json scripts for the same kind', () =>
		Effect.gen(function* () {
			const { config, notes } = yield* detectIn(fixture('makefile'));
			expect(config.checks).toEqual([
				{ name: 'format', run: 'make fmt-check', fix: 'make fmt', lock: 'cpu' },
				{ name: 'lint', run: 'make lint', lock: 'cpu' },
				// Only package.json has it; the lockfile says yarn.
				{ name: 'typecheck', run: 'yarn run typecheck', lock: 'cpu' },
				// docker-compose.yml runs postgres.
				{ name: 'test', run: 'make test', lock: 'db' }
			]);
			expect(config.format).toBe('make fmt');
			const text = notes.join('\n');
			expect(text).toContain(
				'lint: used Makefile (`make lint`) over package.json (`yarn run lint`).'
			);
			expect(text).toContain('docker-compose.yml runs a database image');
		})
	);

	it.effect('drafts cargo fmt, clippy and test for a Cargo project', () =>
		Effect.gen(function* () {
			const { config } = yield* detectIn(fixture('cargo'));
			expect(config.checks).toEqual([
				{
					name: 'format',
					run: 'cargo fmt --all --check',
					fix: 'cargo fmt --all',
					lock: 'cpu'
				},
				{
					name: 'lint',
					run: 'cargo clippy --workspace --all-targets -- -D warnings',
					fix: 'cargo clippy --workspace --all-targets --fix --allow-dirty --allow-staged',
					lock: 'cpu'
				},
				{ name: 'test', run: 'cargo test --workspace', lock: 'cpu' }
			]);
			expect(config.format).toBe('cargo fmt --all');
		})
	);

	it.effect("ignores a workspace package's `npm init` placeholder test", () =>
		Effect.gen(function* () {
			const files = new Map([
				[
					'package.json',
					JSON.stringify({ packageManager: 'pnpm@10.4.0', scripts: { lint: 'oxlint' } })
				],
				['pnpm-workspace.yaml', 'packages:\n  - packages/*\n'],
				[
					'packages/a/package.json',
					JSON.stringify({
						scripts: { test: 'echo "Error: no test specified" && exit 1' }
					})
				]
			]);
			const dirs = new Map([['packages', ['a']]]);
			const { config } = yield* detectProjectConfig({
				read: (path) => Effect.succeed(files.get(path) ?? null),
				list: (dir) => Effect.succeed(dirs.get(dir) ?? [])
			});
			expect(config.checks.map((check) => check.name)).toEqual(['lint']);
		})
	);

	it.effect('drafts no checks for an empty dir, and says so', () =>
		Effect.gen(function* () {
			const { config, notes } = yield* detectIn(yield* tempDir);
			expect(config).toEqual({ $schema: PROJECT_SCHEMA_URL, checks: [] });
			expect(notes).toEqual(['No checks found; add them by hand.']);
		}).pipe(Effect.scoped)
	);
});

describe('task runner parsing', () => {
	it('reads Makefile targets, not variables, special or pattern targets', () => {
		const targets = makeTargets(
			'.PHONY: test\nCC := gcc\nX = 1\nall test: deps\n\techo hi\n%.o: %.c\nci:: lint\n'
		);
		expect([...targets].sort()).toEqual(['all', 'ci', 'test']);
	});

	it('reads justfile recipes, not settings or aliases', () => {
		const recipes = justRecipes(
			"set shell := ['bash', '-c']\nalias t := test\n\ntest filter='':\n  cargo test {{filter}}\n@lint: fmt\n  cargo clippy\n[private]\nfmt:\n  cargo fmt\n"
		);
		expect([...recipes].sort()).toEqual(['fmt', 'lint', 'test']);
	});
});
