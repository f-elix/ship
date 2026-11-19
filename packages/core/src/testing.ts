/**
 * Fake `Git`, `Checks`, `Agent`, `Gh` and `Clef` layers for machine and daemon tests. `Locks` is
 * in memory, so tests use the real one.
 */
import { Context, Effect, Layer, Ref, Struct } from 'effect';
import {
	Agent,
	AgentOutputMismatch,
	AgentSdkError,
	AgentTimeout,
	billedTo,
	decodeOutput,
	type AgentError,
	type AgentResult,
	type AgentRunInput,
	type AgentShape,
	type OutputSchema
} from './agent.ts';
import {
	Checks,
	makeChecks,
	type ChecksShape,
	type ShellCommand,
	type ShellExecutor
} from './checks.ts';
import {
	Clef,
	CLEF_THRESHOLD,
	ClefError,
	type ClefPick,
	type ClefPickInput,
	type ClefShape
} from './clef.ts';
import { Gh, GhError, type CreatePrInput, type GhShape } from './gh.ts';
import {
	Git,
	GitError,
	type ChangedFile,
	type Commit,
	type GitRepo,
	type GitShape
} from './git.ts';
import type { Locks } from './locks.ts';
import { GitSha, ProjectKey, SessionId, type Step } from './primitives.ts';
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
	/** Every tracked file, repo-relative; `trackedFiles` filters it by name. */
	readonly trackedFiles: ReadonlyArray<string>;
	/** What `addedLines` returns, for any range. */
	readonly addedLines: Readonly<Record<string, ReadonlyArray<string>>>;
	readonly pushes: ReadonlyArray<string>;
	readonly excluded: ReadonlyArray<string>;
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
			trackedFiles: [],
			addedLines: {},
			pushes: [],
			excluded: [],
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
			trackedFiles: (_repo, names) =>
				Effect.map(read('trackedFiles'), (s) =>
					s.trackedFiles.filter((path) =>
						names.includes(path.slice(path.lastIndexOf('/') + 1))
					)
				),
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
				})
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

// --- Agent ---

/** What a scripted agent call answers. */
export interface AgentReply {
	/** The structured output in its encoded (JSON) form, decoded with the call's schema. */
	readonly output?: unknown;
	readonly text?: string;
	readonly costUsd?: number;
	readonly turns?: number;
}

/**
 * One scripted answer: a reply, an error to fail with, or a function of the call, e.g. to
 * edit the fake repo the way an implementer would, or to never finish.
 */
export type AgentScript =
	AgentReply | AgentError | ((input: AgentRunInput) => Effect.Effect<AgentReply, AgentError>);

/** Which calls a script answers: every call of `step`, or only those with `label`. */
export interface AgentScriptKey {
	readonly step: Step;
	readonly label?: string;
}

export interface AgentFakeShape {
	/**
	 * Queues answers for the calls matching `key`, used in order. A script for the call's
	 * label wins over one for its whole step. A call with nothing left to answer fails
	 * with an `AgentSdkError` whose reason is `unscripted`.
	 */
	readonly script: (
		key: AgentScriptKey,
		...answers: ReadonlyArray<AgentScript>
	) => Effect.Effect<void>;
	/** Every call made, in order. */
	readonly calls: Effect.Effect<ReadonlyArray<AgentRunInput>>;
}

type Scripts = ReadonlyMap<string, ReadonlyArray<AgentScript>>;

export class AgentFake extends Context.Service<AgentFake, AgentFakeShape>()(
	'@ship/core/AgentFake'
) {
	/**
	 * A fake `Agent` answering from scripts, plus `AgentFake` to script it. Timeouts apply
	 * as in the real one, so a script that never finishes fails with `AgentTimeout` under
	 * `TestClock`. New sessions are `fake-session-<n>`; a resumed call keeps its session
	 * and adds its cost to the session's total.
	 */
	static readonly layer: Layer.Layer<Agent | AgentFake> = Layer.effectContext(
		Effect.gen(function* () {
			const scripts = yield* Ref.make<Scripts>(new Map());
			const calls = yield* Ref.make<ReadonlyArray<AgentRunInput>>([]);
			const sessions = yield* Ref.make(0);

			const keyOf = (key: AgentScriptKey) =>
				key.label === undefined ? key.step : `${key.step}/${key.label}`;

			const nextScript = (input: AgentRunInput) =>
				Ref.modify(scripts, (current): [AgentScript | null, Scripts] => {
					const keys = [
						...(input.label === undefined ? [] : [keyOf(input)]),
						keyOf({ step: input.step })
					];
					for (const key of keys) {
						const [first, ...rest] = current.get(key) ?? [];
						if (first !== undefined) return [first, new Map(current).set(key, rest)];
					}
					return [null, current];
				});

			const answer = (input: AgentRunInput, script: AgentScript | null) => {
				if (script === null) {
					return Effect.fail(
						new AgentSdkError({
							step: input.step,
							reason: 'unscripted',
							detail: `No scripted answer for ${keyOf(input)}`
						})
					);
				}
				if (typeof script === 'function') return script(input);
				if (
					script instanceof AgentSdkError ||
					script instanceof AgentTimeout ||
					script instanceof AgentOutputMismatch
				) {
					return Effect.fail(script);
				}
				return Effect.succeed(script);
			};

			const call = (input: AgentRunInput) =>
				Effect.gen(function* () {
					yield* Ref.update(calls, (all) => [...all, input]);
					const reply = yield* answer(input, yield* nextScript(input));
					const costUsd = reply.costUsd ?? 0;
					const sessionId =
						input.resume?.sessionId ??
						SessionId.make(
							`fake-session-${yield* Ref.updateAndGet(sessions, (n) => n + 1)}`
						);
					const result: AgentResult<null> = {
						session: {
							sessionId,
							cumulativeCostUsd: (input.resume?.cumulativeCostUsd ?? 0) + costUsd
						},
						output: null,
						text: reply.text ?? '',
						cost: { step: input.step, model: input.model, sessionId, costUsd },
						turns: reply.turns ?? 1,
						transcriptPath: null
					};
					return { result, output: reply.output };
				}).pipe(
					Effect.timeoutOrElse({
						duration: input.timeoutMs,
						orElse: () =>
							Effect.fail(
								new AgentTimeout({ step: input.step, timeoutMs: input.timeoutMs })
							)
					})
				);

			const agent: AgentShape = {
				run: (input) => Effect.map(call(input), ({ result }) => result),
				runStructured: <A>(input: AgentRunInput, schema: OutputSchema<A>) =>
					Effect.gen(function* () {
						const { result, output } = yield* call(input);
						const decoded = yield* decodeOutput(input.step, schema, output).pipe(
							Effect.mapError(billedTo(result))
						);
						return { ...result, output: decoded };
					})
			};
			const fake: AgentFakeShape = {
				script: (key, ...answers) =>
					Ref.update(scripts, (current) =>
						new Map(current).set(keyOf(key), [
							...(current.get(keyOf(key)) ?? []),
							...answers
						])
					),
				calls: Ref.get(calls)
			};
			return Context.empty().pipe(
				Context.add(Agent, Agent.of(agent)),
				Context.add(AgentFake, fake)
			);
		})
	);
}

// --- Gh ---

/** A PR in the fake GitHub. */
export interface FakePr extends CreatePrInput {
	readonly url: string;
	readonly number: number;
}

export interface GhFakeShape {
	/** Every PR ever opened, open or not, oldest first. */
	readonly prs: Effect.Effect<ReadonlyArray<FakePr>>;
	/** Adds an open PR, as if a previous attempt had opened it. */
	readonly addPr: (pr: Omit<FakePr, 'url' | 'number'>) => Effect.Effect<FakePr>;
	/** Makes `method` fail with a `GhError` carrying `stderr`, until cleared with `succeed`. */
	readonly fail: (method: keyof GhShape, stderr: string) => Effect.Effect<void>;
	readonly succeed: (method: keyof GhShape) => Effect.Effect<void>;
}

export class GhFake extends Context.Service<GhFake, GhFakeShape>()('@ship/core/GhFake') {
	/** A fake `Gh` over an in-memory list of PRs, plus `GhFake` to inspect and drive it. */
	static readonly layer: Layer.Layer<Gh | GhFake> = Layer.effectContext(
		Effect.gen(function* () {
			const prs = yield* Ref.make<ReadonlyArray<FakePr>>([]);
			const failures = yield* Ref.make<Partial<Record<keyof GhShape, GhError>>>({});

			const guard = (method: keyof GhShape) =>
				Effect.flatMap(Ref.get(failures), (current) => {
					const failure = current[method];
					return failure === undefined ? Effect.void : Effect.fail(failure);
				});

			const add = (pr: CreatePrInput) =>
				Ref.modify(prs, (current): [FakePr, ReadonlyArray<FakePr>] => {
					const number = current.length + 1;
					const created = {
						...pr,
						number,
						url: `https://github.com/f-elix/example/pull/${number}`
					};
					return [created, [...current, created]];
				});

			const update = (url: string, f: (pr: FakePr) => FakePr) =>
				Ref.update(prs, (current) => current.map((pr) => (pr.url === url ? f(pr) : pr)));

			const gh: GhShape = {
				findPr: (_repo, branch) =>
					Effect.andThen(guard('findPr'), () =>
						Effect.map(Ref.get(prs), (current) => {
							const pr = current.find((candidate) => candidate.head === branch);
							return pr === undefined
								? null
								: { url: pr.url, number: pr.number, isDraft: pr.draft };
						})
					),
				createPr: (_repo, input) =>
					Effect.andThen(guard('createPr'), () => Effect.map(add(input), (pr) => pr.url)),
				editPr: (_repo, { url, title, body }) =>
					Effect.andThen(guard('editPr'), () =>
						update(url, (pr) => ({ ...pr, title, body }))
					),
				markDraft: (_repo, url) =>
					Effect.andThen(guard('markDraft'), () =>
						update(url, (pr) => ({ ...pr, draft: true }))
					)
			};
			const fake: GhFakeShape = {
				prs: Ref.get(prs),
				addPr: (pr) => add(pr),
				fail: (method, stderr) =>
					Ref.update(failures, (current) => ({
						...current,
						[method]: new GhError({ args: [method], cwd: '/repo', exitCode: 1, stderr })
					})),
				succeed: (method) =>
					Ref.update(failures, (current) => Struct.omit(current, [method]))
			};
			return Context.empty().pipe(Context.add(Gh, Gh.of(gh)), Context.add(GhFake, fake));
		})
	);
}

// --- Clef ---

export interface ClefFakeShape {
	/** Every `pick` call that asked Clef, oldest first; a call with no candidates asks nothing. */
	readonly calls: Effect.Effect<ReadonlyArray<ClefPickInput>>;
	/**
	 * The probability Clef gives each reviewer, by name; unlisted reviewers get 0. `pick`
	 * applies {@link CLEF_THRESHOLD} as the real Clef does.
	 */
	readonly answer: (probabilities: Readonly<Record<string, number>>) => Effect.Effect<void>;
	/** Makes `pick` and `verify` fail with a `ClefError`, until cleared with `succeed`. */
	readonly fail: (error: ClefError) => Effect.Effect<void>;
	readonly succeed: Effect.Effect<void>;
}

export class ClefFake extends Context.Service<ClefFake, ClefFakeShape>()('@ship/core/ClefFake') {
	/** A fake `Clef` that gives scripted probabilities, plus `ClefFake` to script and inspect it. */
	static readonly layer: Layer.Layer<Clef | ClefFake> = Layer.effectContext(
		Effect.gen(function* () {
			const calls = yield* Ref.make<ReadonlyArray<ClefPickInput>>([]);
			const probabilities = yield* Ref.make<Readonly<Record<string, number>>>({});
			const failure = yield* Ref.make<ClefError | null>(null);

			const guard = Effect.flatMap(Ref.get(failure), (error) =>
				error === null ? Effect.void : Effect.fail(error)
			);

			const clef: ClefShape = {
				pick: (input) =>
					input.candidates.length === 0
						? Effect.succeed([])
						: Ref.update(calls, (current) => [...current, input]).pipe(
								Effect.andThen(guard),
								Effect.andThen(Ref.get(probabilities)),
								Effect.map((answers) =>
									input.candidates.flatMap(
										(reviewer): ReadonlyArray<ClefPick> => {
											const probability = answers[reviewer.name] ?? 0;
											return probability >= CLEF_THRESHOLD
												? [{ name: reviewer.name, probability }]
												: [];
										}
									)
								)
							),
				verify: () => guard
			};
			const fake: ClefFakeShape = {
				calls: Ref.get(calls),
				answer: (next) => Ref.set(probabilities, next),
				fail: (error) => Ref.set(failure, error),
				succeed: Ref.set(failure, null)
			};
			return Context.empty().pipe(
				Context.add(Clef, Clef.of(clef)),
				Context.add(ClefFake, fake)
			);
		})
	);
}
