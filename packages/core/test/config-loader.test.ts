import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigLoader, ProjectKey } from '../src/index.ts';
import { tempDir } from './temp-repo.ts';

const key = ProjectKey.make('github.com/f-elix/ship');

/** A loader over a temp ship home, and a way to write files in it. */
const setup = Effect.gen(function* () {
	const home = yield* tempDir;
	const write = (path: string, content: unknown) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
	};
	const loader = yield* Effect.service(ConfigLoader).pipe(
		Effect.provide(ConfigLoader.layer(home).pipe(Layer.provide(NodeServices.layer)))
	);
	return { loader, write, paths: loader.paths };
});

describe('ConfigLoader', () => {
	it.effect('uses global defaults when config.json is absent and resolves the project', () =>
		Effect.gen(function* () {
			const { loader, write, paths } = yield* setup;
			write(paths.projectConfig(key), {
				checks: [{ name: 'test', run: 'pnpm test' }],
				format: 'pnpm prettier --write {files}',
				caps: { reviewRounds: 1 }
			});
			const config = yield* loader.load(key);
			expect(config.global.locks).toEqual({ cpu: 2 });
			expect(config.resolved.caps).toEqual({ checkFixAttempts: 3, reviewRounds: 1 });
			expect(config.resolved.format).toBe('pnpm prettier --write {files}');
			expect(config.project.checks).toHaveLength(1);
		}).pipe(Effect.scoped)
	);

	it.effect('loads the global config alone, for the daemon at startup', () =>
		Effect.gen(function* () {
			const { loader, write, paths } = yield* setup;
			expect((yield* loader.loadGlobal).locks).toEqual({ cpu: 2 });
			write(paths.globalConfig, { locks: { cpu: 4, db: 1 } });
			expect((yield* loader.loadGlobal).locks).toEqual({ cpu: 4, db: 1 });
		}).pipe(Effect.scoped)
	);

	it.effect('fails with unknown-project-config when the project has no config', () =>
		Effect.gen(function* () {
			const { loader, paths } = yield* setup;
			const error = yield* Effect.flip(loader.load(key));
			expect(error).toMatchObject({
				reason: 'unknown-project-config',
				path: paths.projectConfig(key)
			});
		}).pipe(Effect.scoped)
	);

	it.effect('loadOrDefaults reads a missing project config as {}, for ship review', () =>
		Effect.gen(function* () {
			const { loader, write, paths } = yield* setup;
			write(paths.globalConfig, { caps: { reviewRounds: 4 } });

			const config = yield* loader.loadOrDefaults(key);
			expect(config.project).toEqual({
				checks: [],
				pr: { draft: true, squash: true },
				reviewers: { disable: [] },
				clef: true,
				trustedBots: []
			});
			expect(config.resolved.caps).toEqual({ checkFixAttempts: 3, reviewRounds: 4 });
		}).pipe(Effect.scoped)
	);

	it.effect('loadOrDefaults still fails on a project config that exists but is invalid', () =>
		Effect.gen(function* () {
			const { loader, write, paths } = yield* setup;
			write(paths.projectConfig(key), { checks: [{ name: 'lint' }] });

			const error = yield* Effect.flip(loader.loadOrDefaults(key));
			expect(error).toMatchObject({
				reason: 'invalid-config',
				path: paths.projectConfig(key)
			});
			expect(error.detail).toMatch(/run/);
		}).pipe(Effect.scoped)
	);

	it.effect('fails with invalid-config on bad JSON, a schema error or an unknown lock', () =>
		Effect.gen(function* () {
			const { loader, write, paths } = yield* setup;
			write(paths.projectConfig(key), {});

			write(paths.globalConfig, '{ "locks": ');
			const badJson = yield* Effect.flip(loader.load(key));
			expect(badJson).toMatchObject({ reason: 'invalid-config', path: paths.globalConfig });
			expect(badJson.detail).toMatch(/Invalid JSON/);

			write(paths.globalConfig, { locks: { db: 1 } });
			write(paths.projectConfig(key), { checks: [{ name: 'lint' }] });
			const schema = yield* Effect.flip(loader.load(key));
			expect(schema).toMatchObject({
				reason: 'invalid-config',
				path: paths.projectConfig(key)
			});
			expect(schema.detail).toMatch(/run/);

			write(paths.projectConfig(key), {
				checks: [
					{ name: 'test', run: 'x', lock: 'db' },
					{ name: 'e2e', run: 'y', lock: 'browser' }
				]
			});
			const lock = yield* Effect.flip(loader.load(key));
			expect(lock.detail).toMatch(/e2e \(browser\)/);
			expect(lock.detail).not.toMatch(/test/);
		}).pipe(Effect.scoped)
	);
});
