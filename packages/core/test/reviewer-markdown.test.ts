import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { parseReviewerMarkdown, ReviewerFileError, splitFrontmatter } from '../src/index.ts';

const parse = (text: string, path = '/reviewers/security.md') => parseReviewerMarkdown(path, text);

describe('parseReviewerMarkdown', () => {
	it.effect('parses frontmatter and body into a ReviewerDef', () =>
		Effect.gen(function* () {
			const reviewer = yield* parse(`---
name: security
model: opus
triggers:
  # comments are fine
  paths: ["src/auth/**", '**/*.sql']
  addedLines:
    - 'eval\\('
    - "password\\\\s*="
  fileKinds: [source]
---

# Security

Look for injection.
`);
			expect(reviewer).toEqual({
				name: 'security',
				model: 'opus',
				triggers: {
					always: false,
					paths: ['src/auth/**', '**/*.sql'],
					addedLines: ['eval\\(', 'password\\s*='],
					fileKinds: ['source']
				},
				brief: '# Security\n\nLook for injection.'
			});
		})
	);

	it.effect('fills defaults for a minimal reviewer', () =>
		Effect.gen(function* () {
			const reviewer = yield* parse('---\nname: security\n---\nBrief.\n');
			expect(reviewer).toEqual({
				name: 'security',
				triggers: { always: false, paths: [], addedLines: [], fileKinds: [] },
				brief: 'Brief.'
			});
		})
	);

	it.effect('accepts a byte-order mark and CRLF line endings', () =>
		Effect.gen(function* () {
			const reviewer = yield* parse('﻿---\r\nname: security\r\n---\r\nBrief.\r\n');
			expect(reviewer.brief).toBe('Brief.');
		})
	);

	it.effect.each([
		['no frontmatter', '# Security\n', 'missing a `---` frontmatter block'],
		['invalid YAML', '---\nname: [security\n---\nBrief.', 'not valid YAML'],
		['an unknown key', '---\nname: security\ntrigger: {}\n---\nBrief.', 'trigger'],
		[
			'an unknown file kind',
			'---\nname: security\ntriggers:\n  fileKinds: [code]\n---\nBrief.',
			'Expected "source" | "test"'
		],
		[
			'an invalid regex',
			"---\nname: security\ntriggers:\n  addedLines: ['(']\n---\nBrief.",
			'regular expression'
		],
		[
			'a name that is not the file name',
			'---\nname: secrets\n---\nBrief.',
			'does not match the file name'
		],
		['an empty brief', '---\nname: security\n---\n\n', 'brief'],
		['an empty frontmatter', '---\n\n---\nBrief.', 'name']
	] as const)('rejects %s', ([_label, text, detail]) =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(parse(text));
			expect(error).toBeInstanceOf(ReviewerFileError);
			expect(error.path).toBe('/reviewers/security.md');
			expect(error.detail).toContain(detail);
		})
	);
});

describe('splitFrontmatter', () => {
	it('keeps `---` lines inside the body', () => {
		expect(splitFrontmatter('---\na: 1\n---\nbody\n---\nmore')).toEqual({
			frontmatter: 'a: 1',
			body: 'body\n---\nmore'
		});
	});
});
