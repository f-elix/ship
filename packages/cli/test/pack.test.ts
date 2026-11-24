import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, test } from 'vitest';

const cliDir = fileURLToPath(new URL('..', import.meta.url));
const briefsDir = fileURLToPath(new URL('../../core/src/briefs', import.meta.url));
const conventionsDir = fileURLToPath(new URL('../../core/src/conventions', import.meta.url));

beforeAll(() => {
	execFileSync('pnpm', ['run', '--silent', 'build'], {
		cwd: cliDir,
		stdio: ['ignore', 'ignore', 'inherit']
	});
}, 60_000);

const packedFiles = () => {
	const output = execFileSync('pnpm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
		cwd: cliDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore']
	});
	const packed = JSON.parse(output) as { files: Array<{ path: string }> };
	return new Set(packed.files.map((file) => file.path));
};

test('the package ships every built-in brief and the attribution file', () => {
	const files = packedFiles();

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

test('the package ships every convention and reference file', () => {
	const files = packedFiles();
	const sources = readdirSync(conventionsDir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => `${entry.parentPath}/${entry.name}`.slice(conventionsDir.length + 1));
	expect(sources).toContain('references/testing/SKILL.md');
	for (const path of sources) expect(files, path).toContain(`dist/conventions/${path}`);
}, 60_000);

test('the commands do not load the daemon, the Agent SDK or sqlite', () => {
	const dist = `${cliDir}/dist`;
	const main = readdirSync(dist).find((name) => /^main-.*\.mjs$/.test(name));
	if (main === undefined) return expect.fail('no main chunk in dist');
	// Static imports only: `daemon serve` loads the daemon with a dynamic import.
	const loaded = new Set<string>();
	const visit = (chunk: string) => {
		const code = readFileSync(`${dist}/${chunk}`, 'utf8');
		for (const [, specifier] of code.matchAll(/^import\s[^'"]*?["']([^"']+)["']/gm)) {
			if (specifier === undefined || loaded.has(specifier)) continue;
			loaded.add(specifier);
			if (specifier.startsWith('./')) visit(specifier.slice(2));
		}
	};
	visit(main);
	const heavy = [
		'@anthropic-ai/claude-agent-sdk',
		'@effect/sql-sqlite-node',
		'xstate',
		'@xstate/',
		'yaml'
	];
	expect(
		[...loaded].filter((specifier) => heavy.some((name) => specifier.startsWith(name)))
	).toEqual([]);
	expect(loaded).toContain('effect/cli');
}, 60_000);

test('the package ships the UI server that `ship ui` loads', () => {
	const files = packedFiles();
	expect(files).toContain('dist/ui/handler.js');
	expect([...files].some((path) => path.startsWith('dist/ui/client/_app/immutable/'))).toBe(true);
}, 60_000);
