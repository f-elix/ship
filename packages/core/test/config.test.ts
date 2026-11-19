import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect, Schema } from 'effect';
import {
	checksWithUnknownLock,
	configParseOptions,
	decodeProjectConfig,
	GlobalConfig,
	ProjectConfig,
	resolveConfig,
	ResolvedConfig
} from '../src/index.ts';
import { jsonRoundTrip, resolvedConfig } from './fixtures.ts';

const decodeGlobal = Schema.decodeUnknownSync(GlobalConfig, configParseOptions);
const decodeProject = Schema.decodeUnknownSync(ProjectConfig, configParseOptions);

/** Expects a `SchemaError` whose message matches. */
const rejects = (decode: (input: unknown) => unknown, input: unknown, message: RegExp) => {
	const error = (() => {
		try {
			decode(input);
		} catch (thrown) {
			return thrown;
		}
		return undefined;
	})();
	expect(Schema.isSchemaError(error)).toBe(true);
	expect(String(error)).toMatch(message);
};

describe('GlobalConfig', () => {
	it('decodes {} to a complete config', () => {
		const config = decodeGlobal({});
		expect(config.locks).toEqual({ cpu: 2 });
		expect(config.models).toEqual({
			implement: 'opus',
			fix: 'opus',
			review: 'sonnet',
			verify: 'sonnet',
			pr: 'haiku'
		});
		expect(config.caps).toEqual({ checkFixAttempts: 3, reviewRounds: 10 });
		expect(Duration.toMinutes(config.timeouts.implement)).toBe(60);
		expect(Duration.toMinutes(config.timeouts.review)).toBe(20);
	});

	it('fills defaults inside partially specified groups', () => {
		const config = decodeGlobal({ models: { review: 'opus' }, caps: { reviewRounds: 5 } });
		expect(config.models.review).toBe('opus');
		expect(config.models.implement).toBe('opus');
		expect(config.caps).toEqual({ checkFixAttempts: 3, reviewRounds: 5 });
	});

	it('keeps the cpu lock when other resources are declared, and lets it be overridden', () => {
		expect(decodeGlobal({ locks: { db: 1 } }).locks).toEqual({ cpu: 2, db: 1 });
		expect(decodeGlobal({ locks: { cpu: 4 } }).locks).toEqual({ cpu: 4 });
	});

	it('round-trips through JSON, writing timeouts in the largest whole unit', () => {
		const config = decodeGlobal({
			timeouts: { implement: '90 minutes', verify: '45 seconds', pr: '0.5 hours' }
		});
		const encoded = Schema.encodeSync(GlobalConfig)(config);
		expect(encoded.timeouts).toMatchObject({
			implement: '90 minutes',
			verify: '45 seconds',
			pr: '30 minutes',
			review: '20 minutes'
		});
		expect(jsonRoundTrip(GlobalConfig, config)).toEqual(config);
	});

	it('rejects invalid values', () => {
		rejects(decodeGlobal, { caps: { checkFixAttempts: -1 } }, /greater than or equal to 0/);
		rejects(decodeGlobal, { caps: { reviewRounds: 0 } }, /greater than or equal to 1/);
		rejects(decodeGlobal, { caps: { reviewRounds: 1.5 } }, /integer/);
		rejects(decodeGlobal, { locks: { cpu: 0 } }, /greater than or equal to 1/);
		rejects(decodeGlobal, { locks: { CPU: 1 } }, /at \["locks"\]\["CPU"\]/);
		rejects(decodeGlobal, { timeouts: { implement: '20' } }, /a duration such as/);
		rejects(decodeGlobal, { timeouts: { implement: '5 millis' } }, /a duration such as/);
		rejects(decodeGlobal, { timeouts: { implement: '0 minutes' } }, /a positive duration/);
		rejects(decodeGlobal, { models: { fix: '' } }, /at \["models"\]\["fix"\]/);
	});

	it('rejects unknown keys so typos do not pass silently', () => {
		rejects(decodeGlobal, { caps: { checkFixAttemps: 2 } }, /excess property/);
		expect(decodeGlobal({ $schema: './config.schema.json' }).$schema).toBe(
			'./config.schema.json'
		);
	});
});

describe('ProjectConfig', () => {
	it('decodes {} to defaults and leaves global overrides absent', () => {
		expect(decodeProject({})).toEqual({
			checks: [],
			reviewers: { disable: [], clef: true },
			pr: { draft: true, squash: true }
		});
	});

	it('defaults a check lock to cpu and round-trips through JSON', () => {
		const config = decodeProject({
			checks: [
				{ name: 'lint', run: 'oxlint {files}', fix: 'oxlint --fix {files}' },
				{ name: 'test', run: 'vitest run', lock: 'db' }
			],
			reviewers: { disable: ['ui-a11y'], clef: false },
			pr: { draft: false },
			caps: { reviewRounds: 1 },
			timeouts: { checks: '1 hour' }
		});
		expect(config.checks.map((check) => check.lock)).toEqual(['cpu', 'db']);
		expect(config.pr).toEqual({ draft: false, squash: true });
		expect(config.caps).toEqual({ reviewRounds: 1 });
		expect(config.timeouts?.checks).toEqual(Duration.hours(1));
		expect(jsonRoundTrip(ProjectConfig, config)).toEqual(config);
	});

	it('rejects invalid checks and overrides', () => {
		rejects(decodeProject, { checks: [{ name: 'lint' }] }, /\["run"\]/);
		rejects(
			decodeProject,
			{ checks: [{ name: 'lint', run: 'x', lock: 3 }] },
			/Expected string/
		);
		rejects(
			decodeProject,
			{
				checks: [
					{ name: 'a', run: 'x' },
					{ name: 'a', run: 'y' }
				]
			},
			/unique names/
		);
		rejects(decodeProject, { caps: { checkFixAttempts: -2 } }, /greater than or equal to 0/);
		rejects(decodeProject, { pr: { draft: 'yes' } }, /Expected boolean/);
		rejects(
			decodeProject,
			{ reviewers: { disable: ['Security'] } },
			/kebab-case reviewer name/
		);
	});

	it('finds checks whose lock resource has no permits', () => {
		const global = decodeGlobal({ locks: { db: 1 } });
		const project = decodeProject({
			checks: [
				{ name: 'lint', run: 'x' },
				{ name: 'e2e', run: 'y', lock: 'browser' },
				{ name: 'proto', run: 'z', lock: 'constructor' }
			]
		});
		expect(checksWithUnknownLock(global, project).map((check) => check.name)).toEqual([
			'e2e',
			'proto'
		]);
	});

	it('fails with a SchemaError in the Effect error channel', () => {
		const error = Effect.runSync(Effect.flip(decodeProjectConfig({ checks: 'lint' })));
		expect(Schema.isSchemaError(error)).toBe(true);
	});
});

describe('ResolvedConfig', () => {
	it('applies project overrides to the global config, with timeouts in milliseconds', () => {
		const global = decodeGlobal({ models: { review: 'opus' }, caps: { reviewRounds: 5 } });
		const project = decodeProject({
			checks: [{ name: 'lint', run: 'oxlint {files}' }],
			format: 'prettier --write {files}',
			models: { implement: 'sonnet' },
			caps: { checkFixAttempts: 1 },
			timeouts: { checks: '1 hour' },
			pr: { squash: false }
		});
		const resolved = resolveConfig(global, project);
		expect(resolved.models).toMatchObject({ implement: 'sonnet', review: 'opus', fix: 'opus' });
		expect(resolved.caps).toEqual({ checkFixAttempts: 1, reviewRounds: 5 });
		expect(resolved.timeouts.checks).toBe(3_600_000);
		expect(resolved.timeouts.implement).toBe(3_600_000);
		expect(resolved.timeouts.verify).toBe(900_000);
		expect(resolved.checks).toEqual([{ name: 'lint', run: 'oxlint {files}', lock: 'cpu' }]);
		expect(resolved.format).toBe('prettier --write {files}');
		expect(resolved.pr).toEqual({ draft: true, squash: false });
		expect(resolveConfig(global, decodeProject({})).format).toBeNull();
	});

	it('decodes from its plain JSON unchanged, as the store reads a snapshot', () => {
		const plain: unknown = JSON.parse(JSON.stringify(resolvedConfig));
		expect(Schema.decodeUnknownSync(ResolvedConfig)(plain)).toEqual(resolvedConfig);
	});

	it('rejects an empty format command', () => {
		rejects(decodeProject, { format: '' }, /\["format"\]/);
	});
});
