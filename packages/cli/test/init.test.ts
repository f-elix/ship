import { describe, expect, it } from '@effect/vitest';
import { PROJECT_SCHEMA_URL, projectKeyOf, shipPaths } from '@ship/core';
import { daemon, fakes, fixture, tempDir, type Fixture } from '@ship/daemon/testing';
import { Effect } from 'effect';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli } from './support.ts';

const TIMEOUT = 60_000;

/** `ship init <args>` from the fixture's repo. Without a daemon, any daemon call fails the test. */
const init = (fx: Fixture, args: ReadonlyArray<string>) =>
	cli(['init', ...args], { home: fx.home, cwd: fx.work, env: fx.env });

/** Where the fixture repo's project config lives. */
const configPath = (fx: Fixture) =>
	shipPaths(fx.home).projectConfig(
		projectKeyOf({ remoteUrl: join(fx.dir, 'origin.git'), repoRoot: fx.work })
	);

/** Writes `config` as JSON to a draft file outside the repo and returns its path. */
const draft = (fx: Fixture, config: unknown) => {
	const path = join(fx.dir, 'draft.json');
	writeFileSync(path, typeof config === 'string' ? config : JSON.stringify(config));
	return path;
};

/** A fixture without a project config, as before `ship init`. */
const freshFixture = Effect.map(fixture, (fx) => {
	rmSync(configPath(fx));
	return fx;
});

describe('ship init', () => {
	it.live('rejects --detect with --write, and neither', () =>
		Effect.gen(function* () {
			const fx = yield* freshFixture;
			for (const args of [[], ['--detect', '--write', 'x.json']]) {
				const result = yield* init(fx, args);
				expect(result.code).toBe(1);
				expect(result.stderr).toBe('ship: pass either --detect or --write <file>');
			}
		}).pipe(Effect.scoped)
	);

	it.live('--detect prints the draft on stdout, and the key and notes on stderr', () =>
		Effect.gen(function* () {
			const fx = yield* freshFixture;
			fx.write('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
			fx.write('package-lock.json', '{}');

			const result = yield* init(fx, ['--detect']);

			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				$schema: PROJECT_SCHEMA_URL,
				checks: [{ name: 'test', run: 'npm run test', lock: 'cpu' }]
			});
			expect(result.stderr).toContain(`saves to ${configPath(fx)}`);
			expect(existsSync(configPath(fx))).toBe(false);
		}).pipe(Effect.scoped)
	);

	it.live('--detect outside a git repo still drafts, and warns', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const result = yield* cli(['init', '--detect'], { home: join(dir, 'home'), cwd: dir });
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({ checks: [] });
			expect(result.stderr).toContain(`note: cannot find the git repo of ${dir} (`);
			expect(result.stderr).toContain('not a git repository');
		}).pipe(Effect.scoped)
	);

	it.live('--write reports every validation error and saves nothing', () =>
		Effect.gen(function* () {
			const fx = yield* freshFixture;

			const invalid = yield* init(fx, [
				'--write',
				draft(fx, { checks: [{ name: 'test' }], bogus: true })
			]);
			expect(invalid.code).toBe(1);
			expect(invalid.stderr).toContain('draft.json is not a valid project config:');
			expect(invalid.stderr).toContain('at ["bogus"]');
			expect(invalid.stderr).toContain('at ["checks"][0]["run"]');

			const notJson = yield* init(fx, ['--write', draft(fx, '{ checks: [')]);
			expect(notJson.code).toBe(1);
			expect(notJson.stderr).toContain('Invalid JSON');

			const missing = yield* init(fx, ['--write', 'nowhere.json']);
			expect(missing.code).toBe(1);
			expect(missing.stderr).toContain(`cannot read ${join(fx.work, 'nowhere.json')}`);

			// The fixture's global config has only `cpu` permits.
			const unknownLock = yield* init(fx, [
				'--write',
				draft(fx, { checks: [{ name: 'test', run: 'true', lock: 'db' }] })
			]);
			expect(unknownLock.code).toBe(1);
			expect(unknownLock.stderr).toContain('test (db)');
			expect(unknownLock.stderr).toContain('"locks": {"db":1}');

			writeFileSync(shipPaths(fx.home).globalConfig, '{"locks": {"db": "one"}}');
			const badGlobal = yield* init(fx, ['--write', draft(fx, { checks: [] })]);
			expect(badGlobal.code).toBe(1);
			expect(badGlobal.stderr).toContain(
				`${shipPaths(fx.home).globalConfig} is not a valid global config:`
			);

			expect(existsSync(configPath(fx))).toBe(false);
		}).pipe(Effect.scoped)
	);

	it.live('--write refuses to replace a config unless --force, and sets $schema', () =>
		Effect.gen(function* () {
			const fx = yield* fixture;
			const before = readFileSync(configPath(fx), 'utf8');
			const file = draft(fx, { $schema: './elsewhere.json', pr: { draft: false } });

			const refused = yield* init(fx, ['--write', file]);
			expect(refused.code).toBe(1);
			expect(refused.stderr).toBe(
				`ship: ${configPath(fx)} already exists; pass --force to replace it`
			);
			expect(readFileSync(configPath(fx), 'utf8')).toBe(before);

			// No checks, so no daemon is needed.
			const forced = yield* init(fx, ['--write', file, '--force']);
			expect(forced.code).toBe(0);
			expect(forced.stderr).toContain('the config has no checks to run');
			const saved = readFileSync(configPath(fx), 'utf8');
			expect(saved).toBe(
				`${JSON.stringify({ $schema: PROJECT_SCHEMA_URL, pr: { draft: false } }, null, '\t')}\n`
			);
		}).pipe(Effect.scoped)
	);

	it.live(
		'--write runs every check once through the daemon and exits 1 when one fails',
		() =>
			Effect.gen(function* () {
				const fx = yield* freshFixture;
				yield* daemon(fx.home, yield* fakes);
				const config = {
					checks: [
						// Runs with the caller's env, which only the caller has.
						{ name: 'caller-env', run: 'test "$SHIP_CALLER" = yes' },
						{ name: 'broken', run: 'echo first; echo boom >&2; exit 3', fix: 'exit 9' },
						{ name: 'changed', run: 'echo {files}' }
					]
				};

				const result = yield* init(fx, ['--write', draft(fx, config)]);

				expect(result.code).toBe(1);
				expect(result.stdout).toMatch(/^passed {2}caller-env \(\d+\.\ds\)$/mu);
				expect(result.stdout).toMatch(
					/^failed {2}broken: exit code 3 \(\d+\.\ds\)\n {4}first\n {4}boom$/mu
				);
				expect(result.stdout).toContain('skipped changed: it uses {files}');
				expect(result.stderr).toContain('ship: running broken: echo first;');
				expect(result.stderr).toContain('1 of 2 checks failed. The config is saved');
				// The fix command is not run: checks run as at a run's baseline.
				expect(result.stderr).not.toContain('exit 9');
				expect(JSON.parse(readFileSync(configPath(fx), 'utf8'))).toEqual({
					$schema: PROJECT_SCHEMA_URL,
					...config
				});
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'--write still reports the checks when one times out and stops the pass',
		() =>
			Effect.gen(function* () {
				const fx = yield* freshFixture;
				yield* daemon(fx.home, yield* fakes);

				const result = yield* init(fx, [
					'--write',
					draft(fx, {
						timeouts: { baseline: '1 second' },
						checks: [
							{ name: 'ok', run: 'true' },
							{ name: 'slow', run: 'sleep 10' },
							{ name: 'after', run: 'true' }
						]
					})
				]);

				expect(result.code).toBe(1);
				expect(result.stdout).toMatch(/^passed {2}ok /mu);
				expect(result.stdout).toMatch(/^stopped slow: .*timed out/mu);
				expect(result.stdout).toContain('not run after');
				expect(result.stderr).toContain('the checks stopped:');
				expect(result.stderr).toContain('The config is saved');
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'--write saves the config but cannot run checks whose lock the daemon has no permits for',
		() =>
			Effect.gen(function* () {
				const fx = yield* freshFixture;
				yield* daemon(fx.home, yield* fakes);
				// Added after the daemon started, which reads permits once.
				writeFileSync(
					shipPaths(fx.home).globalConfig,
					JSON.stringify({ locks: { cpu: 2, db: 1 } })
				);

				const result = yield* init(fx, [
					'--write',
					draft(fx, { checks: [{ name: 'test', run: 'true', lock: 'db' }] })
				]);

				expect(result.code).toBe(1);
				expect(result.stderr).toContain('cannot run the checks (invalid-config)');
				expect(result.stderr).toContain('ship daemon restart');
				expect(result.stderr).toContain('The config is saved');
				expect(existsSync(configPath(fx))).toBe(true);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'--write exits 0 when every check passes',
		() =>
			Effect.gen(function* () {
				const fx = yield* freshFixture;
				yield* daemon(fx.home, yield* fakes);

				const result = yield* init(fx, [
					'--write',
					draft(fx, { checks: [{ name: 'ok', run: 'true' }] })
				]);

				expect(result.code).toBe(0);
				expect(result.stdout).toMatch(/^passed {2}ok /u);
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});
