/**
 * Fake `Git` and `Checks` layers for machine and daemon tests. `Locks` is in memory, so
 * tests use the real one.
 */
import { Context, Effect, Layer, Ref } from 'effect';
import {
	Checks,
	makeChecks,
	type ChecksShape,
	type ShellCommand,
	type ShellExecutor
} from './checks.ts';
import {
	Git,
	GitError,
	type ChangedFile,
	type Commit,
	type GitRepo,
	type GitShape
} from './git.ts';
import type { Locks } from './locks.ts';
import { GitSha, ProjectKey } from './primitives.ts';
import { projectKeyOf } from './project-key.ts';

// --- Git ---

export interface FakeCommit extends Commit {
	readonly message: string;
}

/** The fake repo. Tests read it, or change it to script what the pipeline sees. */
export interface FakeGitState {
	readonly repoRoot: string;
	readonly originUrl: string | null;
	readonly defaultBranch: string;
	readonly branch: string | null;
	readonly baseSha: GitSha;
	readonly headSha: GitSha;
	/** Commits since `baseSha`, oldest first. */
	readonly commits: ReadonlyArray<FakeCommit>;
	/** Uncommitted changes exist, so `commit` creates a commit. */
	readonly dirty: boolean;
	/** What `changedFiles` returns, for any range. */
	readonly changedFiles: ReadonlyArray<ChangedFile>;
	/** What `diff` returns, for any range. */
	readonly diff: string;
	/** What `addedLines` returns, for any range. */
	readonly addedLines: Readonly<Record<string, ReadonlyArray<string>>>;
	readonly pushes: ReadonlyArray<string>;
	readonly excluded: ReadonlyArray<string>;
	/** Worktrees currently open. */
	readonly worktrees: ReadonlyArray<string>;
	/** Methods that fail, with their error, until removed. */
	readonly failures: Partial<Record<keyof GitShape, GitError>>;
}

export interface GitFakeShape {
	readonly state: Effect.Effect<FakeGitState>;
	readonly update: (f: (state: FakeGitState) => FakeGitState) => Effect.Effect<void>;
	/** What an agent's edit looks like: the tree becomes dirty and `files` are changed. */
	readonly edit: (files: ReadonlyArray<ChangedFile>) => Effect.Effect<void>;
	/** Makes `method` fail with a `GitError` carrying `stderr`, until cleared with `update`. */
	readonly fail: (method: keyof GitShape, stderr: string) => Effect.Effect<void>;
}

export class GitFake extends Context.Service<GitFake, GitFakeShape>()('@ship/core/GitFake') {
	/** A fake `Git` plus `GitFake` to drive it; `initial` overrides the default repo. */
	static readonly layer = (initial: Partial<FakeGitState> = {}) =>
		Layer.effectContext(makeGitFake(initial));
}

/** The nth fake commit sha. */
export const fakeSha = (n: number): GitSha => GitSha.make(n.toString(16).padStart(40, '0'));

const DEFAULT_BASE = GitSha.make('ba5e'.padEnd(40, '0'));

const makeGitFake = (initial: Partial<FakeGitState>) =>
	Effect.gen(function* () {
		const state = yield* Ref.make<FakeGitState>({
			repoRoot: '/repo',
			originUrl: 'git@github.com:f-elix/example.git',
			defaultBranch: 'main',
			branch: 'feature',
			baseSha: DEFAULT_BASE,
			headSha: initial.baseSha ?? DEFAULT_BASE,
			commits: [],
			dirty: false,
			changedFiles: [],
			diff: '',
			addedLines: {},
			pushes: [],
			excluded: [],
			worktrees: [],
			failures: {},
			...initial
		});
		const counter = yield* Ref.make(0);
		const nextSha = Effect.map(
			Ref.updateAndGet(counter, (n) => n + 1),
			fakeSha
		);

		/** Fails when the test made `method` fail, then reads the state. */
		const read = (method: keyof GitShape) =>
			Effect.flatMap(Ref.get(state), (current) => {
				const failure = current.failures[method];
				return failure === undefined ? Effect.succeed(current) : Effect.fail(failure);
			});

		const git: GitShape = {
			repoRoot: () => Effect.map(read('repoRoot'), (s) => s.repoRoot),
			originUrl: () => Effect.map(read('originUrl'), (s) => s.originUrl),
			projectKey: () =>
				Effect.map(read('projectKey'), (s): ProjectKey =>
					projectKeyOf({ remoteUrl: s.originUrl, repoRoot: s.repoRoot })
				),
			defaultBranch: () => Effect.map(read('defaultBranch'), (s) => s.defaultBranch),
			currentBranch: () => Effect.map(read('currentBranch'), (s) => s.branch),
			headSha: () => Effect.map(read('headSha'), (s) => s.headSha),
			baseSha: () => Effect.map(read('baseSha'), (s) => s.baseSha),
			isClean: () => Effect.map(read('isClean'), (s) => !s.dirty),
			diff: () => Effect.map(read('diff'), (s) => s.diff),
			commits: () => Effect.map(read('commits'), (s) => s.commits),
			changedFiles: () => Effect.map(read('changedFiles'), (s) => s.changedFiles),
			addedLines: () => Effect.map(read('addedLines'), (s) => s.addedLines),
			commit: (_repo: GitRepo, message: string) =>
				Effect.gen(function* () {
					const current = yield* read('commit');
					if (!current.dirty) return null;
					const sha = yield* nextSha;
					yield* Ref.set(state, {
						...current,
						dirty: false,
						headSha: sha,
						commits: [
							...current.commits,
							{ sha, subject: message.split('\n')[0] ?? '', message }
						]
					});
					return sha;
				}),
			squash: (_repo, { message }) =>
				Effect.gen(function* () {
					const current = yield* read('squash');
					const [only, ...rest] = current.commits;
					if (only === undefined || (rest.length === 0 && only.message === message)) {
						return current.headSha;
					}
					const sha = yield* nextSha;
					yield* Ref.set(state, {
						...current,
						headSha: sha,
						commits: [{ sha, subject: message.split('\n')[0] ?? '', message }]
					});
					return sha;
				}),
			push: (_repo, branch) =>
				Effect.flatMap(read('push'), (current) =>
					Ref.set(state, { ...current, pushes: [...current.pushes, branch] })
				),
			excludePath: (_repo, path) =>
				Effect.gen(function* () {
					const current = yield* read('excludePath');
					if (current.excluded.includes(path)) return false;
					yield* Ref.set(state, { ...current, excluded: [...current.excluded, path] });
					return true;
				}),
			worktree: (_repo, { path }) =>
				Effect.acquireRelease(
					Effect.flatMap(read('worktree'), (current) =>
						Effect.as(
							Ref.set(state, { ...current, worktrees: [...current.worktrees, path] }),
							path
						)
					),
					() =>
						Ref.update(state, (current) => ({
							...current,
							worktrees: current.worktrees.filter((open) => open !== path)
						}))
				)
		};

		const fake: GitFakeShape = {
			state: Ref.get(state),
			update: (f) => Ref.update(state, f),
			edit: (files) =>
				Ref.update(state, (current) => ({
					...current,
					dirty: true,
					changedFiles: [
						...current.changedFiles.filter(
							(file) => !files.some((changed) => changed.path === file.path)
						),
						...files
					]
				})),
			fail: (method, stderr) =>
				Ref.update(state, (current) => ({
					...current,
					failures: {
						...current.failures,
						[method]: new GitError({
							args: [method],
							cwd: current.repoRoot,
							exitCode: 1,
							stderr
						})
					}
				}))
		};

		return Context.empty().pipe(Context.add(Git, Git.of(git)), Context.add(GitFake, fake));
	});

// --- Checks ---

export interface ChecksFakeShape {
	/** Every command the fake was asked to run, in order. */
	readonly calls: Effect.Effect<ReadonlyArray<ShellCommand>>;
	/** Replaces how commands answer. By default every command exits 0 with no output. */
	readonly respond: (executor: ShellExecutor) => Effect.Effect<void>;
}

export class ChecksFake extends Context.Service<ChecksFake, ChecksFakeShape>()(
	'@ship/core/ChecksFake'
) {
	/**
	 * The real checks runner (events, `{files}`, fix-first, locks) over scripted commands
	 * instead of shells. Needs `Locks`.
	 */
	static readonly layer: Layer.Layer<Checks | ChecksFake, never, Locks> = Layer.effectContext(
		Effect.gen(function* () {
			const calls = yield* Ref.make<ReadonlyArray<ShellCommand>>([]);
			const executor = yield* Ref.make<ShellExecutor>(() =>
				Effect.succeed({ exitCode: 0, outputTail: '' })
			);
			const checks: ChecksShape = yield* makeChecks((command) =>
				Effect.andThen(
					Ref.update(calls, (all) => [...all, command]),
					Effect.flatMap(Ref.get(executor), (execute) => execute(command))
				)
			);
			const fake: ChecksFakeShape = {
				calls: Ref.get(calls),
				respond: (execute) => Ref.set(executor, execute)
			};
			return Context.empty().pipe(Context.add(Checks, checks), Context.add(ChecksFake, fake));
		})
	);
}

/**
 * A responder that answers each check's `run` command with the next exit code listed for
 * it, then 0 once the list is used up. Fix and format commands exit 0. A failing exit code
 * comes with the output `<check> failed`.
 */
export const exitCodesByCheck = (
	codes: Readonly<Record<string, ReadonlyArray<number>>>
): Effect.Effect<ShellExecutor> =>
	Effect.sync(() => {
		const used = new Map<string, number>();
		return (command: ShellCommand) =>
			Effect.sync(() => {
				if (command.kind !== 'run' || command.check === null) {
					return { exitCode: 0, outputTail: '' };
				}
				const index = used.get(command.check) ?? 0;
				used.set(command.check, index + 1);
				const exitCode = codes[command.check]?.[index] ?? 0;
				return { exitCode, outputTail: exitCode === 0 ? '' : `${command.check} failed` };
			});
	});
