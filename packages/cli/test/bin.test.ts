import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

test('--version prints the package version', () => {
	expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })).toBe(
		`${pkg.version}\n`
	);
});
