import { Context, Effect, FileSystem, Layer, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { GitSha, type Env, type ProjectKey } from './primitives.ts';
import { exec, type ProcessOutput } from './process.ts';
import { projectKeyOf } from './project-key.ts';

// --- Public types ---

/** Where git runs: a directory inside the repo and the caller's environment. */
export interface GitRepo {
	readonly cwd: string;
	readonly env: Env;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

/** A changed file, repo-relative. `oldPath` is set for renames and copies. */
export interface ChangedFile {
	readonly path: string;
	readonly status: FileStatus;
	readonly oldPath?: string;
}

export interface Commit {
	readonly sha: GitSha;
	readonly subject: string;
}

/** `from..to`. */
export interface CommitRange {
	readonly from: GitSha;
	readonly to: GitSha;
}

/** A git command failed. `exitCode` is `null` when git could not be started at all. */
export class GitError extends Schema.TaggedError<GitError>()('GitError', {
	args: Schema.Array(Schema.String),
	cwd: Schema.String,
	exitCode: Schema.NullOr(Schema.Int),
	stderr: Schema.String
}) {
	override get message(): string {
		const status = this.exitCode === null ? 'could not run' : `exited with ${this.exitCode}`;
		return `git ${this.args.join(' ')} ${status} in ${this.cwd}: ${this.stderr.trim()}`;
	}
}

export interface GitShape {
	/** Absolute path of the repo's top-level directory. */
	readonly repoRoot: (repo: GitRepo) => Effect.Effect<string, GitError>;
	/** The `origin` remote's URL, or `null` when there is no `origin`. */
	readonly originUrl: (repo: GitRepo) => Effect.Effect<string | null, GitError>;
	/** The normalized `origin` URL, or the repo root when there is no `origin`. */
	readonly projectKey: (repo: GitRepo) => Effect.Effect<ProjectKey, GitError>;
	/**
	 * The default branch's name: the target of `origin/HEAD`, else `main` or `master`,
	 * whichever exists locally or on `origin`.
	 */
	readonly defaultBranch: (repo: GitRepo) => Effect.Effect<string, GitError>;
	/** The checked-out branch, or `null` on a detached HEAD. */
	readonly currentBranch: (repo: GitRepo) => Effect.Effect<string | null, GitError>;
	readonly headSha: (repo: GitRepo) => Effect.Effect<GitSha, GitError>;
	/** `merge-base HEAD <default>`, preferring `origin/<default>` over the local branch. */
	readonly baseSha: (repo: GitRepo) => Effect.Effect<GitSha, GitError>;
	/** No staged, unstaged or untracked (and not ignored) changes. */
	readonly isClean: (repo: GitRepo) => Effect.Effect<boolean, GitError>;
	/** The unified diff of `from..to`. */
	readonly diff: (repo: GitRepo, range: CommitRange) => Effect.Effect<string, GitError>;
	/** Commits in `from..to`, oldest first. */
	readonly commits: (
		repo: GitRepo,
		range: CommitRange
	) => Effect.Effect<ReadonlyArray<Commit>, GitError>;
	/**
	 * Files changed between `from` and `to`, with renames detected. Without `to`, between
	 * `from` and the working tree, untracked files included as `added`.
	 */
	readonly changedFiles: (
		repo: GitRepo,
		range: { readonly from: GitSha; readonly to?: GitSha }
	) => Effect.Effect<ReadonlyArray<ChangedFile>, GitError>;
	/** Repo-relative paths of the tracked files named one of `names`, at any depth. */
	readonly trackedFiles: (
		repo: GitRepo,
		names: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<string>, GitError>;
	/** Lines added in `from..to`, by repo-relative path. Files with no added line are absent. */
	readonly addedLines: (
		repo: GitRepo,
		range: CommitRange
	) => Effect.Effect<Readonly<Record<string, ReadonlyArray<string>>>, GitError>;
	/**
	 * Stages every change (ignored and excluded files stay out) and commits it, skipping
	 * hooks. Returns the new commit, or `null` when there was nothing to commit.
	 */
	readonly commit: (repo: GitRepo, message: string) => Effect.Effect<GitSha | null, GitError>;
	/**
	 * Replaces the commits in `base..HEAD` with one commit with `message`, skipping hooks.
	 * Safe to repeat: a single commit that already has `message` is kept as is, as is a
	 * HEAD with no commits since `base`. Returns HEAD.
	 */
	readonly squash: (
		repo: GitRepo,
		options: { readonly base: GitSha; readonly message: string }
	) => Effect.Effect<GitSha, GitError>;
	/** `git push -u origin <branch>`. */
	readonly push: (repo: GitRepo, branch: string) => Effect.Effect<void, GitError>;
	/**
	 * Adds `path` (absolute) to `.git/info/exclude` so it is never committed. Returns `false`
	 * when it was already listed or lies outside the repo.
	 */
	readonly excludePath: (repo: GitRepo, path: string) => Effect.Effect<boolean, GitError>;
	/** Fetches `ref` from `origin`, without tags, and returns the commit it points to. */
	readonly fetchRef: (repo: GitRepo, ref: string) => Effect.Effect<GitSha, GitError>;
	/** The best common ancestor of `a` and `b`. */
	readonly mergeBase: (repo: GitRepo, a: GitSha, b: GitSha) => Effect.Effect<GitSha, GitError>;
}

// --- Parsing ---

const STATUS_BY_LETTER: Readonly<Record<string, FileStatus>> = {
	A: 'added',
	M: 'modified',
	D: 'deleted',
	R: 'renamed',
	C: 'copied',
	T: 'type-changed',
	U: 'modified'
};

/** Parses `git diff --name-status -z` output. */
export const parseNameStatus = (output: string): ReadonlyArray<ChangedFile> => {
	const fields = output.split('\0');
	const files: Array<ChangedFile> = [];
	let index = 0;
	while (index < fields.length) {
		const letter = fields[index]?.[0];
		index += 1;
		if (letter === undefined) continue;
		const status = STATUS_BY_LETTER[letter] ?? 'modified';
		if (status === 'renamed' || status === 'copied') {
			const oldPath = fields[index] ?? '';
			const path = fields[index + 1] ?? '';
			index += 2;
			files.push({ path, status, oldPath });
		} else {
			files.push({ path: fields[index] ?? '', status });
			index += 1;
		}
	}
	return files;
};

const C_ESCAPES: Readonly<Record<string, number>> = {
	a: 7,
	b: 8,
	t: 9,
	n: 10,
	v: 11,
	f: 12,
	r: 13,
	'"': 34,
	'\\': 92
};

/** Undoes git's C-style quoting of unusual paths in diff headers, e.g. `"caf\303\251"`. */
export const unquoteGitPath = (path: string): string => {
	if (!path.startsWith('"') || !path.endsWith('"')) return path;
	const bytes: Array<number> = [];
	const body = path.slice(1, -1);
	for (let index = 0; index < body.length; index += 1) {
		const char = body[index] ?? '';
		if (char !== '\\') {
			bytes.push(...new TextEncoder().encode(char));
			continue;
		}
		const next = body[index + 1] ?? '';
		const octal = /^[0-7]{3}/u.exec(body.slice(index + 1));
		if (octal !== null) {
			bytes.push(Number.parseInt(octal[0], 8));
			index += 3;
		} else {
			bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
			index += 1;
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
};

/**
 * The new-side path of a diff's `+++ ` header line, or null for a deleted file. Git quotes
 * unusual paths and ends a path that contains a space with a tab.
 */
export const diffTargetPath = (header: string): string | null => {
	const target = unquoteGitPath(header.slice('+++ '.length).replace(/\t$/u, ''));
	return target === '/dev/null' ? null : target.replace(/^b\//u, '');
};

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u;

/** Parses `git diff -U0 --src-prefix=a/ --dst-prefix=b/` output into added lines per file. */
export const parseAddedLines = (diff: string): Record<string, ReadonlyArray<string>> => {
	const added: Record<string, Array<string>> = {};
	let file: string | null = null;
	let oldLeft = 0;
	let newLeft = 0;
	for (const line of diff.split('\n')) {
		if (oldLeft > 0 || newLeft > 0) {
			if (line.startsWith('+')) {
				newLeft -= 1;
				if (file !== null) (added[file] ??= []).push(line.slice(1));
			} else if (line.startsWith('-')) {
				oldLeft -= 1;
			}
			continue;
		}
		if (line.startsWith('+++ ')) {
			file = diffTargetPath(line);
			continue;
		}
		const hunk = HUNK_HEADER.exec(line);
		if (hunk !== null) {
			oldLeft = Number(hunk[1] ?? '1');
			newLeft = Number(hunk[2] ?? '1');
		}
	}
	return added;
};

/** Escapes gitignore pattern characters so `path` matches only itself. */
const escapeIgnorePattern = (path: string): string => path.replace(/[\\*?[\]]/gu, '\\$&');

// --- Implementation ---

const decodeSha = Schema.decodeUnknownEffect(GitSha);

const make = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	/** Runs git and returns its output when the exit code is one of `okCodes`. */
	const runWith = (repo: GitRepo, args: ReadonlyArray<string>, okCodes: ReadonlyArray<number>) =>
		exec(
			ChildProcess.make('git', args, {
				cwd: repo.cwd,
				env: { ...repo.env, GIT_TERMINAL_PROMPT: '0' },
				extendEnv: false,
				stdin: 'ignore'
			})
		).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			Effect.mapError(
				(error) =>
					new GitError({ args, cwd: repo.cwd, exitCode: null, stderr: error.message })
			),
			Effect.flatMap((output: ProcessOutput) =>
				okCodes.includes(output.exitCode)
					? Effect.succeed(output)
					: Effect.fail(
							new GitError({
								args,
								cwd: repo.cwd,
								exitCode: output.exitCode,
								stderr: output.stderr
							})
						)
			)
		);

	const run = (repo: GitRepo, args: ReadonlyArray<string>) =>
		runWith(repo, args, [0]).pipe(Effect.map((output) => output.stdout));

	const runLine = (repo: GitRepo, args: ReadonlyArray<string>) =>
		run(repo, args).pipe(Effect.map((stdout) => stdout.trim()));

	/** Whether the command exits 0, for queries that answer with exit code 1. */
	const succeeds = (repo: GitRepo, args: ReadonlyArray<string>) =>
		runWith(repo, args, [0, 1]).pipe(Effect.map((output) => output.exitCode === 0));

	const toSha = (repo: GitRepo, args: ReadonlyArray<string>, value: string) =>
		decodeSha(value).pipe(
			Effect.mapError(
				() =>
					new GitError({
						args,
						cwd: repo.cwd,
						exitCode: 0,
						stderr: `Expected a commit sha, got "${value}"`
					})
			)
		);

	const revParse = (repo: GitRepo, rev: string) => {
		const args = ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`];
		return runLine(repo, args).pipe(Effect.flatMap((value) => toSha(repo, args, value)));
	};

	const refExists = (repo: GitRepo, ref: string) =>
		succeeds(repo, ['show-ref', '--verify', '--quiet', ref]);

	const repoRoot = Effect.fn('Git.repoRoot')(function* (repo: GitRepo) {
		return yield* runLine(repo, ['rev-parse', '--show-toplevel']);
	});

	const originUrl = Effect.fn('Git.originUrl')(function* (repo: GitRepo) {
		const output = yield* runWith(repo, ['remote', 'get-url', 'origin'], [0, 2]);
		const url = output.stdout.trim();
		return output.exitCode === 0 && url !== '' ? url : null;
	});

	const projectKey = Effect.fn('Git.projectKey')(function* (repo: GitRepo) {
		const [root, remoteUrl] = yield* Effect.all([repoRoot(repo), originUrl(repo)]);
		return projectKeyOf({ remoteUrl, repoRoot: root });
	});

	/** The default branch's name and the ref to compare against. */
	const defaultBranchRef = Effect.fnUntraced(function* (repo: GitRepo) {
		const originHead = yield* runWith(
			repo,
			['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
			[0, 1, 128]
		);
		const target = originHead.stdout.trim();
		if (originHead.exitCode === 0 && target.startsWith('refs/remotes/origin/')) {
			return { name: target.slice('refs/remotes/origin/'.length), ref: target };
		}
		for (const name of ['main', 'master']) {
			for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
				if (yield* refExists(repo, ref)) return { name, ref };
			}
		}
		return yield* new GitError({
			args: ['symbolic-ref', 'refs/remotes/origin/HEAD'],
			cwd: repo.cwd,
			exitCode: originHead.exitCode,
			stderr: 'No default branch: origin/HEAD is not set and neither main nor master exists'
		});
	});

	const defaultBranch = Effect.fn('Git.defaultBranch')(function* (repo: GitRepo) {
		return (yield* defaultBranchRef(repo)).name;
	});

	const currentBranch = Effect.fn('Git.currentBranch')(function* (repo: GitRepo) {
		const output = yield* runWith(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]);
		return output.exitCode === 0 ? output.stdout.trim() : null;
	});

	const headSha = Effect.fn('Git.headSha')(function* (repo: GitRepo) {
		return yield* revParse(repo, 'HEAD');
	});

	const baseSha = Effect.fn('Git.baseSha')(function* (repo: GitRepo) {
		const { ref } = yield* defaultBranchRef(repo);
		const args = ['merge-base', 'HEAD', ref];
		return yield* toSha(repo, args, yield* runLine(repo, args));
	});

	const isClean = Effect.fn('Git.isClean')(function* (repo: GitRepo) {
		return (yield* run(repo, ['status', '--porcelain', '-z'])) === '';
	});

	const diffArgs = ['--no-color', '--no-ext-diff', '--no-textconv', '-M'];

	const diff = Effect.fn('Git.diff')(function* (repo: GitRepo, range: CommitRange) {
		return yield* run(repo, [
			'diff',
			...diffArgs,
			'--src-prefix=a/',
			'--dst-prefix=b/',
			range.from,
			range.to,
			'--'
		]);
	});

	const commits = Effect.fn('Git.commits')(function* (repo: GitRepo, range: CommitRange) {
		const output = yield* run(repo, [
			'log',
			'--reverse',
			'-z',
			'--format=%H %s',
			`${range.from}..${range.to}`,
			'--'
		]);
		const entries = output.split('\0').filter((entry) => entry !== '');
		return yield* Effect.forEach(entries, (entry) => {
			const space = entry.indexOf(' ');
			const sha = space === -1 ? entry : entry.slice(0, space);
			const subject = space === -1 ? '' : entry.slice(space + 1);
			return toSha(repo, ['log'], sha.trim()).pipe(Effect.map((sha) => ({ sha, subject })));
		});
	});

	const changedFiles = Effect.fn('Git.changedFiles')(function* (
		repo: GitRepo,
		range: { readonly from: GitSha; readonly to?: GitSha }
	) {
		const tracked = parseNameStatus(
			yield* run(repo, [
				'diff',
				'--name-status',
				'-z',
				...diffArgs,
				range.from,
				...(range.to === undefined ? [] : [range.to]),
				'--'
			])
		);
		if (range.to !== undefined) return tracked;
		const untracked = (yield* run(repo, ['ls-files', '--others', '--exclude-standard', '-z']))
			.split('\0')
			.filter((path) => path !== '')
			.map((path): ChangedFile => ({ path, status: 'added' }));
		return [...tracked, ...untracked];
	});

	const trackedFiles = Effect.fn('Git.trackedFiles')(function* (
		repo: GitRepo,
		names: ReadonlyArray<string>
	) {
		if (names.length === 0) return [];
		const pathspecs = names.map((name) => `:(top,glob)**/${name}`);
		return (yield* run(repo, ['ls-files', '-z', '--full-name', '--', ...pathspecs]))
			.split('\0')
			.filter((path) => path !== '');
	});

	const addedLines = Effect.fn('Git.addedLines')(function* (repo: GitRepo, range: CommitRange) {
		return parseAddedLines(
			yield* run(repo, [
				'diff',
				...diffArgs,
				'-U0',
				'--src-prefix=a/',
				'--dst-prefix=b/',
				range.from,
				range.to,
				'--'
			])
		);
	});

	const commitStaged = (repo: GitRepo, message: string) =>
		run(repo, ['commit', '--quiet', '--no-verify', '--allow-empty-message', '-m', message]);

	const commit = Effect.fn('Git.commit')(function* (repo: GitRepo, message: string) {
		yield* run(repo, ['add', '--all']);
		const hasChanges = !(yield* succeeds(repo, ['diff', '--cached', '--quiet']));
		if (!hasChanges) return null;
		yield* commitStaged(repo, message);
		return yield* headSha(repo);
	});

	const squash = Effect.fn('Git.squash')(function* (
		repo: GitRepo,
		options: { readonly base: GitSha; readonly message: string }
	) {
		const head = yield* headSha(repo);
		const since = yield* commits(repo, { from: options.base, to: head });
		if (since.length === 0) return head;
		if (since.length === 1) {
			const fullMessage = yield* run(repo, ['log', '-1', '--format=%B', head]);
			if (fullMessage.trim() === options.message.trim()) return head;
		}
		yield* run(repo, ['reset', '--soft', options.base]);
		yield* commitStaged(repo, options.message);
		return yield* headSha(repo);
	});

	const push = Effect.fn('Git.push')(function* (repo: GitRepo, branch: string) {
		yield* run(repo, ['push', '--quiet', '--set-upstream', 'origin', branch]);
	});

	const fsError = (repo: GitRepo, args: ReadonlyArray<string>) => (error: { message: string }) =>
		new GitError({ args, cwd: repo.cwd, exitCode: null, stderr: error.message });

	const excludePath = Effect.fn('Git.excludePath')(function* (repo: GitRepo, path: string) {
		const root = yield* repoRoot(repo);
		const target = yield* fs
			.realPath(path)
			.pipe(Effect.mapError(fsError(repo, ['exclude', path])));
		if (target === root || !target.startsWith(`${root}/`)) return false;
		const isDirectory = yield* fs.stat(target).pipe(
			Effect.map((info) => info.type === 'Directory'),
			Effect.mapError(fsError(repo, ['exclude', path]))
		);
		const pattern = `/${escapeIgnorePattern(target.slice(root.length + 1))}${isDirectory ? '/' : ''}`;

		const excludeFile = yield* runLine(repo, [
			'rev-parse',
			'--path-format=absolute',
			'--git-path',
			'info/exclude'
		]);
		const toGitError = fsError(repo, ['exclude', excludeFile]);
		const current = yield* fs.readFileString(excludeFile).pipe(
			Effect.catchTag('PlatformError', (error) =>
				error.reason._tag === 'NotFound' ? Effect.succeed('') : Effect.fail(error)
			),
			Effect.mapError(toGitError)
		);
		if (current.split('\n').some((line) => line.trim() === pattern)) return false;
		const separator = current === '' || current.endsWith('\n') ? '' : '\n';
		yield* fs
			.makeDirectory(excludeFile.slice(0, excludeFile.lastIndexOf('/')), { recursive: true })
			.pipe(Effect.mapError(toGitError));
		yield* fs
			.writeFileString(excludeFile, `${current}${separator}${pattern}\n`)
			.pipe(Effect.mapError(toGitError));
		return true;
	});

	const fetchRef = Effect.fn('Git.fetchRef')(function* (repo: GitRepo, ref: string) {
		yield* run(repo, ['fetch', '--quiet', '--no-tags', '--end-of-options', 'origin', ref]);
		return yield* revParse(repo, 'FETCH_HEAD');
	});

	const mergeBase = Effect.fn('Git.mergeBase')(function* (repo: GitRepo, a: GitSha, b: GitSha) {
		const args = ['merge-base', a, b];
		return yield* toSha(repo, args, yield* runLine(repo, args));
	});

	return Git.of({
		fetchRef,
		mergeBase,
		repoRoot,
		originUrl,
		projectKey,
		defaultBranch,
		currentBranch,
		headSha,
		baseSha,
		isClean,
		diff,
		commits,
		changedFiles,
		trackedFiles,
		addedLines,
		commit,
		squash,
		push,
		excludePath
	});
});

/** Runs real `git` in the caller's repo, with the caller's env. */
export class Git extends Context.Service<Git, GitShape>()('@ship/core/Git') {
	static readonly layer = Layer.effect(this, make);
}
