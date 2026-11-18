import { describe, expect, it } from '@effect/vitest';
import { configJsonSchemaFiles } from '@ship/core';
import { readFileSync } from 'node:fs';

const schemasDir = new URL('../schemas/', import.meta.url);

describe('config JSON Schemas', () => {
	it.each(Object.entries(configJsonSchemaFiles()))(
		'%s is up to date (run `pnpm gen:schemas`)',
		(name, generated) => {
			expect(readFileSync(new URL(name, schemasDir), 'utf8')).toBe(generated);
		}
	);

	it('describes defaults and rejects unknown keys', () => {
		const schema = JSON.parse(configJsonSchemaFiles()['config.schema.json']);
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties.caps.properties.checkFixAttempts).toMatchObject({
			type: 'integer',
			minimum: 0,
			default: 3
		});
		expect(schema.properties.timeouts.properties.implement).toMatchObject({
			type: 'string',
			default: '1 hour'
		});
	});
});
