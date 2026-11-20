import { describe, expect, it } from '@effect/vitest';
import { BUILTIN_CONVENTIONS_DIR } from '@ship/core';
import { fixture, tempDir, type Fixture } from '@ship/daemon/testing';
import { Effect } from 'effect';
import { join } from 'node:path';
import { cli } from './support.ts';

const TIMEOUT = 60_000;

/** `ship conventions <args>` from the fixture's repo. Without a daemon, any daemon call fails the test. */
const conventions = (fx: Fixture, args: ReadonlyArray<string> = []) =>
	cli(['conventions', ...args], { home: fx.home, cwd: fx.work, env: fx.env });

/** The paths of the files a run of the command printed, in order. */
const printedFiles = (stdout: string) =>
	[...stdout.matchAll(/^<file path="([^"]+)">$/gmu)].map((match) => match[1]);

describe('ship conventions', () => {
	it.live(
		'prints the design conventions for the stack and lists the other topics',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				fx.write('tsconfig.json', '{}');
				fx.write('package.json', JSON.stringify({ dependencies: { effect: '4.1.4' } }));
				fx.git('add', 'tsconfig.json', 'package.json');

				const result = yield* conventions(fx);

				expect(result.code).toBe(0);
				expect(printedFiles(result.stdout)).toEqual([
					`${BUILTIN_CONVENTIONS_DIR}/references/software-design-philosophy/SKILL.md`,
					`${BUILTIN_CONVENTIONS_DIR}/references/codebase-design/SKILL.md`,
					`${BUILTIN_CONVENTIONS_DIR}/file-organization.md`
				]);
				expect(result.stdout).toContain('# Codebase Design');
				expect(result.stdout).toContain('- effect: ');
				expect(result.stdout).toContain('- typescript: ');
				expect(result.stdout).not.toContain('- file-organization: ');
				expect(result.stdout).not.toContain('- svelte-components: ');
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'prints no stack-bound design topic and no list for a repo without a stack',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const result = yield* conventions(fx);
				expect(result.code).toBe(0);
				expect(printedFiles(result.stdout)).toHaveLength(2);
				expect(result.stdout).not.toContain('Other conventions');
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'prints one topic with its details, whatever the stack, or a reference',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const topic = yield* conventions(fx, ['svelte-components']);
				expect(topic.code).toBe(0);
				expect(printedFiles(topic.stdout)).toEqual([
					`${BUILTIN_CONVENTIONS_DIR}/svelte-components.md`,
					`${BUILTIN_CONVENTIONS_DIR}/svelte-components.details.md`
				]);

				const reference = yield* conventions(fx, ['references/testing']);
				expect(printedFiles(reference.stdout)).toEqual([
					`${BUILTIN_CONVENTIONS_DIR}/references/testing/SKILL.md`
				]);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'rejects an unknown topic or reference, naming the topics',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				for (const name of ['nope', 'references/nope']) {
					const result = yield* conventions(fx, [name]);
					expect(result.code).toBe(1);
					expect(result.stderr).toMatch(
						new RegExp(
							`^ship: no convention named "${name}"; the topics are comments, effect, `,
							'u'
						)
					);
				}
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live('fails outside a git repo', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const result = yield* cli(['conventions'], { home: join(dir, 'home'), cwd: dir });
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`ship: cannot find the git repo of ${dir} (`);
		}).pipe(Effect.scoped)
	);
});
