import { Effect, FileSystem, Predicate, type PlatformError } from 'effect';
import { join } from 'node:path';
import type { Check, ProjectConfig } from './config.ts';
import { PROJECT_SCHEMA_URL } from './json-schema.ts';

/**
 * Read access to a project's files, by path relative to the project dir. Detection only
 * reads through this, so tests can point it at fixture dirs.
 */
export interface ProjectFiles {
	/** The file's text, or `null` when it does not exist. */
	readonly read: (path: string) => Effect.Effect<string | null, PlatformError.PlatformError>;
	/** The names of a directory's entries, or none when it does not exist. */
	readonly list: (
		dir: string
	) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError>;
}

/** A draft project config, as JSON, and what detection wants the user to know about it. */
export interface Detection {
	readonly config: typeof ProjectConfig.Encoded;
	/** Choices made, alternatives dropped and hints, one sentence each. */
	readonly notes: ReadonlyArray<string>;
}

/** The files under `root`, read with `FileSystem`. */
export const projectFilesAt = (root: string) =>
	Effect.map(FileSystem.FileSystem, (fs): ProjectFiles => {
		const orWhenMissing =
			<A>(fallback: A) =>
			(error: PlatformError.PlatformError) =>
				// BadResource: a path through a file, e.g. `packages/README.md/package.json`.
				error.reason._tag === 'NotFound' || error.reason._tag === 'BadResource'
					? Effect.succeed(fallback)
					: Effect.fail(error);
		return {
			read: (path) =>
				fs.readFileString(join(root, path)).pipe(
					Effect.map((text): string | null => text),
					Effect.catchTag('PlatformError', orWhenMissing(null))
				),
			list: (dir) =>
				fs.readDirectory(join(root, dir)).pipe(
					Effect.map((names): ReadonlyArray<string> => names),
					Effect.catchTag('PlatformError', orWhenMissing([]))
				)
		};
	});

/** The YAML parser, loaded on first use so CLI commands other than `init` never load it. */
const loadYaml = Effect.promise(() => import('yaml')).pipe(Effect.map((yaml) => yaml.parse));

// --- Candidates ---

/**
 * What a check is for. A draft has at most one check per kind, named after it, in this
 * order: cheap checks first. `check` is an aggregate script or target, used only when no
 * granular kind was found.
 */
const KINDS = ['format', 'lint', 'typecheck', 'test', 'check'] as const;
type Kind = (typeof KINDS)[number];

interface Candidate {
	readonly run: string;
	readonly fix?: string;
}

/** What one source (a package.json, a Makefile, ...) offers. */
type Candidates = { [K in Kind]?: Candidate };

interface SourceFindings {
	readonly source: string;
	readonly checks: Candidates;
	/** A command that formats files in place, for the project's `format`. */
	readonly format?: string;
	readonly notes: ReadonlyArray<string>;
}

/** Script or target names per kind, most specific first. */
interface NameRules {
	readonly formatCheck: ReadonlyArray<string>;
	readonly formatWrite: ReadonlyArray<string>;
	readonly lint: ReadonlyArray<string>;
	readonly lintFix: ReadonlyArray<string>;
	readonly typecheck: ReadonlyArray<string>;
	readonly test: ReadonlyArray<string>;
	readonly check: ReadonlyArray<string>;
}

const SCRIPT_NAMES: NameRules = {
	formatCheck: ['format:check', 'check:format', 'fmt:check', 'prettier:check'],
	formatWrite: ['format', 'fmt'],
	lint: ['lint'],
	lintFix: ['lint:fix', 'fix:lint'],
	typecheck: ['typecheck', 'type-check', 'check:types', 'types', 'tsc'],
	test: ['test'],
	check: ['check']
};

const TARGET_NAMES: NameRules = {
	formatCheck: ['fmt-check', 'format-check', 'check-fmt', 'check-format', 'fmt_check'],
	formatWrite: ['fmt', 'format'],
	lint: ['lint'],
	lintFix: ['lint-fix', 'lint_fix', 'fix'],
	typecheck: ['typecheck', 'type-check', 'types'],
	test: ['test'],
	check: ['check']
};

/** A format script that only checks, such as `prettier --check .`. */
const CHECKS_ONLY = /(?:^|\s)(?:--check|--list-different|-l)(?:\s|$)/u;

/**
 * Maps the names a source defines to candidates. `command` turns a name into the shell
 * command that runs it; `body` is what the name runs, when known, to tell a format script
 * that only checks from one that writes.
 */
const matchNames = (
	names: ReadonlySet<string>,
	rules: NameRules,
	command: (name: string) => string,
	body: (name: string) => string | undefined = () => undefined
): Pick<SourceFindings, 'checks' | 'format'> => {
	const first = (list: ReadonlyArray<string>) => list.find((name) => names.has(name));
	const checks: Candidates = {};
	const withFix = (run: string, fix: string | undefined): Candidate =>
		fix === undefined ? { run } : { run, fix };

	const writers = rules.formatWrite.filter((name) => names.has(name));
	const writer = writers.find((name) => !CHECKS_ONLY.test(body(name) ?? ''));
	const formatCheck =
		first(rules.formatCheck) ?? writers.find((name) => CHECKS_ONLY.test(body(name) ?? ''));
	if (formatCheck !== undefined) {
		checks.format = withFix(
			command(formatCheck),
			writer === undefined ? undefined : command(writer)
		);
	}
	const lint = first(rules.lint);
	if (lint !== undefined) {
		const fix = first(rules.lintFix);
		checks.lint = withFix(command(lint), fix === undefined ? undefined : command(fix));
	}
	const typecheck = first(rules.typecheck);
	if (typecheck !== undefined) checks.typecheck = { run: command(typecheck) };
	const test = first(rules.test);
	if (test !== undefined) checks.test = { run: command(test) };
	const check = first(rules.check);
	if (check !== undefined) checks.check = { run: command(check) };

	return writer === undefined ? { checks } : { checks, format: command(writer) };
};

// --- package.json ---

const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const;
type PackageManager = (typeof PACKAGE_MANAGERS)[number];

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
	['pnpm-lock.yaml', 'pnpm'],
	['bun.lock', 'bun'],
	['bun.lockb', 'bun'],
	['yarn.lock', 'yarn'],
	['package-lock.json', 'npm'],
	['npm-shrinkwrap.json', 'npm']
];

interface PackageJson {
	readonly scripts: Readonly<Record<string, string>>;
	readonly dependencies: ReadonlyArray<string>;
	readonly packageManager?: string;
	readonly workspaces: ReadonlyArray<string>;
}

const stringArray = (value: unknown): ReadonlyArray<string> =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const parsePackageJson = (text: string): PackageJson | null => {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Predicate.isObject(json)) return null;
	const scripts: Record<string, string> = {};
	if (Predicate.isObject(json['scripts'])) {
		for (const [name, script] of Object.entries(json['scripts'])) {
			if (typeof script === 'string') scripts[name] = script;
		}
	}
	const dependencies = ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap(
		(field) => {
			const deps = json[field];
			return Predicate.isObject(deps) ? Object.keys(deps) : [];
		}
	);
	const workspaces = json['workspaces'];
	return {
		scripts,
		dependencies,
		workspaces: Predicate.isObject(workspaces)
			? stringArray(workspaces['packages'])
			: stringArray(workspaces),
		...(typeof json['packageManager'] === 'string'
			? { packageManager: json['packageManager'] }
			: {})
	};
};

/** `npm init` writes this as the `test` script; it is no test. */
const PLACEHOLDER_TEST = /no test specified/u;

/**
 * Expands workspace globs to package dirs. Only the common forms are understood: a literal
 * dir and a trailing `/*` or `/**` (both read as one level). Negations are ignored.
 */
const expandWorkspaces = (files: ProjectFiles, patterns: ReadonlyArray<string>) =>
	Effect.map(
		Effect.forEach(patterns, (pattern) => {
			if (pattern.startsWith('!')) return Effect.succeed([]);
			const clean = pattern.replace(/^\.\//u, '').replace(/\/+$/u, '');
			const wildcard = /^(.*?)\/\*\*?$/u.exec(clean);
			if (wildcard === null) return Effect.succeed(clean.includes('*') ? [] : [clean]);
			const parent = wildcard[1] ?? '';
			return Effect.map(files.list(parent), (names) =>
				names.filter((name) => !name.startsWith('.')).map((name) => `${parent}/${name}`)
			);
		}),
		(dirs) => [...new Set(dirs.flat())]
	);

const workspacePatterns = (files: ProjectFiles, pkg: PackageJson) =>
	Effect.gen(function* () {
		const text = yield* files.read('pnpm-workspace.yaml');
		if (text === null) return pkg.workspaces;
		const parseYaml = yield* loadYaml;
		try {
			const parsed: unknown = parseYaml(text);
			return Predicate.isObject(parsed) ? stringArray(parsed['packages']) : [];
		} catch {
			return [];
		}
	});

/** How to run a script in every workspace package that has it, per package manager. */
const RECURSIVE: Partial<Record<PackageManager, (script: string) => string>> = {
	pnpm: (script) => `pnpm -r --if-present run ${script}`,
	npm: (script) => `npm run ${script} --workspaces --if-present`
};

interface NodeFindings extends SourceFindings {
	readonly dependencies: ReadonlyArray<string>;
}

const detectNode = (files: ProjectFiles) =>
	Effect.gen(function* () {
		const text = yield* files.read('package.json');
		if (text === null) return null;
		const pkg = parsePackageJson(text);
		if (pkg === null) {
			return {
				source: 'package.json',
				checks: {},
				notes: ['package.json is not a JSON object; skipped it.'],
				dependencies: []
			} satisfies NodeFindings;
		}
		const notes: Array<string> = [];

		let pm = PACKAGE_MANAGERS.find((name) => pkg.packageManager?.startsWith(`${name}@`));
		if (pm === undefined) {
			for (const [lockfile, manager] of LOCKFILES) {
				if ((yield* files.read(lockfile)) !== null) {
					pm = manager;
					break;
				}
			}
		}
		if (pm === undefined) {
			pm = 'npm';
			notes.push('No packageManager field or lockfile; assumed npm.');
		}
		const manager = pm;

		const realScripts = (all: Readonly<Record<string, string>>) =>
			Object.entries(all).filter(
				([name, script]) => !(name === 'test' && PLACEHOLDER_TEST.test(script))
			);
		const scripts = new Map(realScripts(pkg.scripts));
		const found = matchNames(
			new Set(scripts.keys()),
			SCRIPT_NAMES,
			(name) => `${manager} run ${name}`,
			(name) => scripts.get(name)
		);
		const checks = { ...found.checks };

		// Scripts only workspace packages define run in each package that has them.
		const memberDirs = yield* expandWorkspaces(files, yield* workspacePatterns(files, pkg));
		const members = (yield* Effect.forEach(memberDirs, (dir) =>
			Effect.map(files.read(`${dir}/package.json`), (member) =>
				member === null ? null : parsePackageJson(member)
			)
		)).filter((member) => member !== null);
		if (members.length > 0) {
			notes.push(
				`Workspace with ${members.length} packages: checks use the root scripts, falling back to each package's own.`
			);
			const memberScripts = new Set(
				members.flatMap((member) => realScripts(member.scripts).map(([name]) => name))
			);
			const recursive = RECURSIVE[manager];
			const fromMembers = matchNames(
				memberScripts,
				SCRIPT_NAMES,
				recursive ?? ((name) => name)
			).checks;
			for (const kind of KINDS) {
				const candidate = fromMembers[kind];
				if (candidate === undefined || checks[kind] !== undefined || kind === 'check') {
					continue;
				}
				if (recursive === undefined) {
					notes.push(
						`Workspace packages have a ${kind} script but the root has none; add a root script for ${manager}.`
					);
				} else {
					checks[kind] = candidate;
					notes.push(`${kind} runs each workspace package's script: ${candidate.run}.`);
				}
			}
		}

		if (found.format !== undefined && !found.format.includes('{files}')) {
			notes.push(
				`format runs \`${found.format}\` on the whole tree after each agent step; a command taking \`{files}\` (e.g. \`prettier --write --ignore-unknown {files}\`) only touches changed files.`
			);
		}

		return {
			source: 'package.json',
			checks,
			...(found.format === undefined ? {} : { format: found.format }),
			notes,
			dependencies: [...pkg.dependencies, ...members.flatMap((member) => member.dependencies)]
		} satisfies NodeFindings;
	});

// --- Makefile and justfile ---

// The usual spelling first: on a case-insensitive file system every name matches.
const MAKEFILES = ['Makefile', 'GNUmakefile', 'makefile'];
const JUSTFILES = ['justfile', 'Justfile', '.justfile'];

/** Explicit target names: `name:` or `a b:`, but not `VAR := x`, `.PHONY:` or `%.o:`. */
export const makeTargets = (text: string): ReadonlySet<string> => {
	const targets = new Set<string>();
	for (const line of text.split('\n')) {
		const match = /^([^\s:#=][^:#=]*?)\s*::?(?!=)/u.exec(line);
		if (match === null) continue;
		for (const name of (match[1] ?? '').split(/\s+/u)) {
			if (/^[A-Za-z0-9][\w.-]*$/u.test(name)) targets.add(name);
		}
	}
	return targets;
};

/** Recipe names: `name:`, `name arg='x':`, `@name:`, but not `set x := y` or `alias`. */
export const justRecipes = (text: string): ReadonlySet<string> => {
	const recipes = new Set<string>();
	for (const line of text.split('\n')) {
		const match = /^@?([A-Za-z_][\w-]*)(?:\s+[^:]*)?:(?!=)/u.exec(line);
		if (match?.[1] !== undefined) recipes.add(match[1]);
	}
	return recipes;
};

const firstFile = (files: ProjectFiles, names: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		for (const name of names) {
			const text = yield* files.read(name);
			if (text !== null) return { name, text };
		}
		return null;
	});

const detectTaskRunner = (
	files: ProjectFiles,
	names: ReadonlyArray<string>,
	parse: (text: string) => ReadonlySet<string>,
	tool: string
) =>
	Effect.gen(function* () {
		const file = yield* firstFile(files, names);
		if (file === null) return null;
		const found = matchNames(parse(file.text), TARGET_NAMES, (name) => `${tool} ${name}`);
		return { source: file.name, ...found, notes: [] } satisfies SourceFindings;
	});

// --- Cargo.toml ---

const detectCargo = (files: ProjectFiles) =>
	Effect.gen(function* () {
		const text = yield* files.read('Cargo.toml');
		if (text === null) return null;
		return {
			source: 'Cargo.toml',
			checks: {
				format: { run: 'cargo fmt --all --check', fix: 'cargo fmt --all' },
				lint: {
					run: 'cargo clippy --workspace --all-targets -- -D warnings',
					fix: 'cargo clippy --workspace --all-targets --fix --allow-dirty --allow-staged'
				},
				test: { run: 'cargo test --workspace' }
			},
			format: 'cargo fmt --all',
			notes: []
		} satisfies SourceFindings;
	});

// --- Database heuristic ---

/** Packages for databases that tests usually share: a server, not a file like SQLite. */
const DB_PACKAGES = new Set([
	'pg',
	'postgres',
	'mysql',
	'mysql2',
	'mongodb',
	'mongoose',
	'@prisma/client',
	'prisma',
	'typeorm',
	'sequelize',
	'knex'
]);
const DB_CRATES =
	/^\s*(?:sqlx|diesel|postgres|tokio-postgres|sea-orm|mongodb)\s*=|^\[(?:dev-)?dependencies\.(?:sqlx|diesel|postgres|tokio-postgres|sea-orm|mongodb)\]/mu;
const DB_IMAGES = /image:\s*['"]?(?:[\w.-]+\/)?(?:postgres|postgis|mysql|mariadb|mongo)\b/u;
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/** Why tests seem to use a shared database, or `null`. A cheap guess, not an analysis. */
const databaseHint = (files: ProjectFiles, dependencies: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const dep = dependencies.find((name) => DB_PACKAGES.has(name));
		if (dep !== undefined) return `the ${dep} package is a dependency`;
		const cargo = yield* files.read('Cargo.toml');
		const crate = cargo === null ? null : DB_CRATES.exec(cargo);
		if (crate !== null) return 'Cargo.toml depends on a database crate';
		const compose = yield* firstFile(files, COMPOSE_FILES);
		if (compose !== null && DB_IMAGES.test(compose.text)) {
			return `${compose.name} runs a database image`;
		}
		return null;
	});

// --- CI workflows ---

const SETUP_COMMAND =
	/^(?:npm (?:ci|install|i)\b|pnpm (?:install|i)\b|yarn(?: install)?$|bun install\b|corepack\b|npx playwright install\b|rustup\b|echo\b|cd\b)/u;

/** The `run:` commands of a workflow's steps, one per line, setup commands left out. */
const workflowCommands = (
	text: string,
	parseYaml: (text: string) => unknown
): ReadonlyArray<string> | null => {
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch {
		return null;
	}
	if (!Predicate.isObject(parsed) || !Predicate.isObject(parsed['jobs'])) return [];
	const commands: Array<string> = [];
	for (const job of Object.values(parsed['jobs'])) {
		if (!Predicate.isObject(job) || !Array.isArray(job['steps'])) continue;
		for (const step of job['steps']) {
			if (!Predicate.isObject(step) || typeof step['run'] !== 'string') continue;
			for (const line of step['run'].split('\n')) {
				const command = line.trim();
				if (command !== '' && !command.startsWith('#') && !SETUP_COMMAND.test(command)) {
					commands.push(command);
				}
			}
		}
	}
	return commands;
};

const MAX_CI_HINTS = 15;

const ciHints = (files: ProjectFiles, covered: ReadonlySet<string>) =>
	Effect.gen(function* () {
		const dir = '.github/workflows';
		const notes: Array<string> = [];
		const commands = new Set<string>();
		for (const name of [...(yield* files.list(dir))].sort()) {
			if (!/\.ya?ml$/u.test(name)) continue;
			const text = yield* files.read(`${dir}/${name}`);
			if (text === null) continue;
			const found = workflowCommands(text, yield* loadYaml);
			if (found === null) {
				notes.push(`${dir}/${name} is not valid YAML; skipped it.`);
				continue;
			}
			for (const command of found) if (!covered.has(command)) commands.add(command);
		}
		if (commands.size > 0) {
			const listed = [...commands].slice(0, MAX_CI_HINTS);
			const more = commands.size - listed.length;
			notes.push(
				`CI also runs (hints only, not added): ${listed.map((command) => `\`${command}\``).join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
			);
		}
		return notes;
	});

// --- Detection ---

/**
 * Drafts a project config from the files of a project: `package.json` scripts, `Makefile`
 * and `justfile` targets, `Cargo.toml`, and `.github/workflows` as hints only.
 *
 * Rules:
 * - One check per kind (format, lint, typecheck, test). When several sources offer a kind,
 *   the first in this order wins: justfile, Makefile, package.json, Cargo.toml. A task
 *   runner at the root is the project's chosen entry point and often wraps the others.
 * - An aggregate `check` script or target is used only when no granular check was found,
 *   since granular checks show which one failed and let each have its own fix and lock.
 * - Scripts run with the package manager from `packageManager`, else the lockfile, else npm.
 *   In a workspace, a script only its packages define runs in each package that has it.
 * - Checks lock `cpu`; `test` locks `db` when tests seem to use a shared database.
 */
export const detectProjectConfig = Effect.fn('detectProjectConfig')(function* (
	files: ProjectFiles
) {
	const node = yield* detectNode(files);
	const sources: ReadonlyArray<SourceFindings> = [
		yield* detectTaskRunner(files, JUSTFILES, justRecipes, 'just'),
		yield* detectTaskRunner(files, MAKEFILES, makeTargets, 'make'),
		node,
		yield* detectCargo(files)
	].filter((source) => source !== null);
	const notes = sources.flatMap((source) => source.notes);

	const chosen = new Map<Kind, Candidate & { readonly source: string }>();
	for (const kind of KINDS) {
		const offers = sources.flatMap((source) => {
			const candidate = source.checks[kind];
			return candidate === undefined ? [] : [{ ...candidate, source: source.source }];
		});
		const [winner, ...others] = offers;
		if (winner === undefined) continue;
		chosen.set(kind, winner);
		for (const other of others) {
			notes.push(
				`${kind}: used ${winner.source} (\`${winner.run}\`) over ${other.source} (\`${other.run}\`).`
			);
		}
	}
	const aggregate = chosen.get('check');
	if (aggregate !== undefined && chosen.size > 1) {
		chosen.delete('check');
		notes.push(
			`Left out the aggregate \`${aggregate.run}\` in favour of the granular checks; use it instead if it runs more than they do.`
		);
	}

	const lockHint = chosen.has('test')
		? yield* databaseHint(files, node?.dependencies ?? [])
		: null;
	if (lockHint !== null) {
		notes.push(
			`test locks \`db\` because ${lockHint}: add \`"locks": { "db": 1 }\` to ship's global config (\`config.json\` in ship's home), then run \`ship daemon restart\`; or set its lock to \`cpu\` if tests do not share a database.`
		);
	}

	const checks: Array<typeof Check.Encoded> = [];
	for (const [kind, candidate] of chosen) {
		const lock = kind === 'test' && lockHint !== null ? 'db' : 'cpu';
		checks.push(
			candidate.fix === undefined
				? { name: kind, run: candidate.run, lock }
				: { name: kind, run: candidate.run, fix: candidate.fix, lock }
		);
	}
	const format = sources.find((source) => source.format !== undefined)?.format;

	if (checks.length === 0) {
		notes.push('No checks found; add them by hand.');
	}
	notes.push(...(yield* ciHints(files, new Set(checks.map((check) => check.run)))));

	return {
		config: {
			$schema: PROJECT_SCHEMA_URL,
			checks,
			...(format === undefined ? {} : { format })
		},
		notes
	} satisfies Detection;
});
