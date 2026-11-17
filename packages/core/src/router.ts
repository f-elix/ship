import { matchesGlob } from 'node:path';
import type { ChangedFile } from './git.ts';
import type { FileKind, ReviewerDef, ReviewerTriggers } from './reviewer.ts';

/** What the router looks at: the changed files and the lines added, from `Git`. */
export interface ReviewChanges {
	readonly files: ReadonlyArray<ChangedFile>;
	/** Added lines by repo-relative path, as `Git.addedLines` returns them. */
	readonly addedLines: Readonly<Record<string, ReadonlyArray<string>>>;
}

/** A reviewer the router picked and why, e.g. `path src/auth/**` or `kind source`. */
export interface RoutedReviewer {
	readonly reviewer: ReviewerDef;
	readonly reasons: ReadonlyArray<string>;
}

// --- File kinds ---

const DEPS_FILES = new Set([
	'package.json',
	'package-lock.json',
	'npm-shrinkwrap.json',
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'yarn.lock',
	'bun.lock',
	'bun.lockb',
	'deno.lock',
	'Cargo.toml',
	'Cargo.lock',
	'go.mod',
	'go.sum',
	'Gemfile',
	'Gemfile.lock',
	'Pipfile',
	'Pipfile.lock',
	'poetry.lock',
	'uv.lock',
	'pyproject.toml',
	'composer.json',
	'composer.lock',
	'mix.exs',
	'mix.lock',
	'Package.swift',
	'Package.resolved',
	'build.gradle',
	'build.gradle.kts',
	'pom.xml'
]);

const SOURCE_EXTENSIONS = new Set([
	'ts',
	'mts',
	'cts',
	'tsx',
	'js',
	'mjs',
	'cjs',
	'jsx',
	'vue',
	'svelte',
	'astro',
	'py',
	'go',
	'rs',
	'java',
	'kt',
	'kts',
	'scala',
	'rb',
	'php',
	'c',
	'h',
	'cc',
	'cpp',
	'hpp',
	'cs',
	'fs',
	'swift',
	'm',
	'mm',
	'ex',
	'exs',
	'erl',
	'clj',
	'hs',
	'ml',
	'lua',
	'dart',
	'zig',
	'sh',
	'bash',
	'zsh',
	'sql'
]);

const UI_EXTENSIONS = new Set([
	'tsx',
	'jsx',
	'vue',
	'svelte',
	'astro',
	'html',
	'htm',
	'css',
	'scss',
	'sass',
	'less',
	'styl'
]);

const DOCS_EXTENSIONS = new Set(['md', 'mdx', 'markdown', 'rst', 'adoc', 'txt']);

const CONFIG_EXTENSIONS = new Set([
	'json',
	'jsonc',
	'json5',
	'yml',
	'yaml',
	'toml',
	'ini',
	'cfg',
	'conf'
]);

const CONFIG_FILES = new Set(['Dockerfile', 'Makefile', 'justfile', 'Justfile', 'Procfile']);

const TEST_DIR = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e)\//u;
const TEST_FILE =
	/(?:\.(?:test|spec|e2e)\.[^./]+$|_test\.(?:go|py|rb|exs)$|(?:^|\/)test_[^/]+\.py$|Tests?\.(?:java|kt|cs|swift)$)/u;
const TOOL_CONFIG_FILE = /\.config\.[cm]?[jt]s$|(?:^|\/)\.[^/]+rc\.[cm]?[jt]s$/u;
const DOCS_DIR = /(?:^|\/)docs?\//u;

/**
 * The kinds of a changed file, from its path alone. A file can have several kinds (a
 * `.tsx` component is `ui` and `source`) or none (an image). Tests and tool configs written
 * in a source language are `test` or `config`, not `source`.
 */
export const classifyFile = (path: string): ReadonlyArray<FileKind> => {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
	if (DEPS_FILES.has(name) || /^requirements[^/]*\.txt$/u.test(name)) return ['deps'];
	if (TEST_DIR.test(path) || TEST_FILE.test(path)) return ['test'];
	if (DOCS_EXTENSIONS.has(extension) || name === 'LICENSE') return ['docs'];
	if (TOOL_CONFIG_FILE.test(path)) return ['config'];
	if (
		CONFIG_EXTENSIONS.has(extension) ||
		CONFIG_FILES.has(name) ||
		name.startsWith('.env') ||
		path.startsWith('.github/') ||
		(name.startsWith('.') && extension === '')
	) {
		return ['config'];
	}
	const kinds: Array<FileKind> = [];
	if (UI_EXTENSIONS.has(extension)) kinds.push('ui');
	if (SOURCE_EXTENSIONS.has(extension)) kinds.push('source');
	if (kinds.length === 0 && DOCS_DIR.test(path)) kinds.push('docs');
	return kinds;
};

// --- Deterministic routing ---

/** Paths a change touches: the path, plus the old path of a rename or copy. */
const touchedPaths = (files: ReadonlyArray<ChangedFile>): ReadonlyArray<string> =>
	files.flatMap((file) => (file.oldPath === undefined ? [file.path] : [file.path, file.oldPath]));

/**
 * Why `triggers` match `changes`, one reason per matching trigger; empty when none match.
 * Globs use `path.matchesGlob`, where `*` and `**` skip dot-directories such as
 * `.github/`, so those need an explicit pattern (`.github/**`).
 */
export const matchTriggers = (
	triggers: ReviewerTriggers,
	changes: ReviewChanges
): ReadonlyArray<string> => {
	const reasons: Array<string> = [];
	if (triggers.always) reasons.push('always');
	const paths = touchedPaths(changes.files);
	for (const glob of triggers.paths) {
		if (paths.some((path) => matchesGlob(path, glob))) reasons.push(`path ${glob}`);
	}
	const lines = Object.values(changes.addedLines).flat();
	for (const pattern of triggers.addedLines) {
		const regexp = new RegExp(pattern, 'u');
		if (lines.some((line) => regexp.test(line))) reasons.push(`added line /${pattern}/`);
	}
	if (triggers.fileKinds.length > 0) {
		const kinds = new Set(paths.flatMap(classifyFile));
		for (const kind of triggers.fileKinds) {
			if (kinds.has(kind)) reasons.push(`kind ${kind}`);
		}
	}
	return reasons;
};

/** The reviewers whose triggers match `changes`, in the order given. */
export const routeDeterministic = (
	reviewers: ReadonlyArray<ReviewerDef>,
	changes: ReviewChanges
): ReadonlyArray<RoutedReviewer> =>
	reviewers.flatMap((reviewer) => {
		const reasons = matchTriggers(reviewer.triggers, changes);
		return reasons.length === 0 ? [] : [{ reviewer, reasons }];
	});
