import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { ReviewerDef, ReviewerFrontmatter } from '../src/index.ts';
import { jsonRoundTrip } from './fixtures.ts';

const decodeFrontmatter = Schema.decodeUnknownSync(ReviewerFrontmatter);

describe('ReviewerFrontmatter', () => {
	it('defaults to no deterministic triggers', () => {
		expect(decodeFrontmatter({ name: 'design' })).toEqual({
			name: 'design',
			triggers: { always: false, paths: [], addedLines: [], fileKinds: [] }
		});
	});

	it('rejects invalid names, file kinds and patterns', () => {
		expect(() => decodeFrontmatter({ name: 'Error Handling' })).toThrow(/kebab-case/);
		expect(() =>
			decodeFrontmatter({ name: 'deps', triggers: { fileKinds: ['lockfile'] } })
		).toThrow(/\["triggers"\]\["fileKinds"\]\[0\]/);
		expect(() =>
			decodeFrontmatter({ name: 'security', triggers: { addedLines: ['(eval'] } })
		).toThrow(/valid regular expression/);
	});
});

describe('ReviewerDef', () => {
	it('round-trips through JSON', () => {
		const reviewer = Schema.decodeUnknownSync(ReviewerDef)({
			name: 'security',
			triggers: { paths: ['**/auth/**'], addedLines: ['\\beval\\('], fileKinds: ['deps'] },
			model: 'opus',
			brief: 'Look for injection and secrets.'
		});
		expect(jsonRoundTrip(ReviewerDef, reviewer)).toEqual(reviewer);
	});
});
