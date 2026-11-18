import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const cliDir = fileURLToPath(new URL('..', import.meta.url));
const briefsDir = fileURLToPath(new URL('../../core/src/briefs', import.meta.url));

test('the package ships every built-in brief and the attribution file', () => {
	execFileSync('pnpm', ['run', '--silent', 'build'], {
		cwd: cliDir,
		stdio: ['ignore', 'ignore', 'inherit']
	});
	const output = execFileSync('pnpm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
		cwd: cliDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore']
	});
	const packed = JSON.parse(output) as { files: Array<{ path: string }> };
	const files = new Set(packed.files.map((file) => file.path));

	const reviewers = readdirSync(`${briefsDir}/reviewers`).filter((name) => name.endsWith('.md'));
	expect(reviewers.length).toBeGreaterThan(0);
	for (const path of [
		...reviewers.map((name) => `dist/briefs/reviewers/${name}`),
		'dist/briefs/verifier.md',
		'dist/briefs/ATTRIBUTION.md'
	]) {
		expect(files, path).toContain(path);
	}
}, 60_000);
