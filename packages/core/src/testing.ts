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
	ClefError,
	type ChoiceAnswer,
	type ClefAnswers,
	type ClefQuestion,
	type ClefQuestions,
	type ClefRequest,
	type ClefScope,
	type ClefShape,
	type NoulAnswer,
	type ScoreAnswer
} from './clef.ts';
import {
	Gh,
	GhError,
	type CreatePrInput,
	type GhShape,
	type ReviewThread,
	type SubmitReviewInput
} from './gh.ts';
import {
	Git,
	GitError,
	type ChangedFile,
	type Commit,
	type GitRepo,
	type GitShape
} from './git.ts';
import type { Locks } from './locks.ts';
import { parsePrUrl, prRepoKey } from './pr-url.ts';
import { projectKeyOf } from './project-key.ts';
import { GitSha, ProjectKey, SessionId, type StepName } from './values.ts';

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
	/** Every `pushHead`, in order, with the HEAD it pushed. */
	readonly headPushes: ReadonlyArray<{
		readonly remote: string;
		readonly ref: string;
		readonly sha: GitSha;
	}>;
	readonly excluded: ReadonlyArray<string>;
	/** What `fetchRef` resolves each ref to; an unlisted ref resolves to `headSha`. */
	readonly remoteRefs: Readonly<Record<string, GitSha>>;
	/** Every ref fetched, in order. */
	readonly fetches: ReadonlyArray<string>;
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
	/**
	 * Runs `hook` inside every later `pushHead`, after the push is recorded: a hook that
	 * never ends stands for a crash after the remote took the push.
	 */
	readonly afterPushHead: (hook: Effect.Effect<void>) => Effect.Effect<void>;
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
			headPushes: [],
			excluded: [],
			remoteRefs: {},
			fetches: [],
			failures: {},
			...initial
		});
		const pushHook = yield* Ref.make<Effect.Effect<void>>(Effect.void);
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
			pushHead: (_repo, { remote, ref }) =>
				Effect.flatMap(read('pushHead'), (current) =>
					Ref.set(state, {
						...current,
						headPushes: [...current.headPushes, { remote, ref, sha: current.headSha }]
					}).pipe(Effect.andThen(Effect.flatten(Ref.get(pushHook))))
				),
			// History is `baseSha` then `commits`, in order; any other sha is unrelated.
			isAncestor: (_repo, ancestor, descendant) =>
				Effect.map(read('isAncestor'), (current) => {
					const chain = [current.baseSha, ...current.commits.map((commit) => commit.sha)];
					const at = chain.indexOf(ancestor);
					return (
						ancestor === descendant || (at !== -1 && chain.indexOf(descendant) >= at)
					);
				}),
			excludePath: (_repo, path) =>
				Effect.gen(function* () {
					const current = yield* read('excludePath');
					if (current.excluded.includes(path)) return false;
					yield* Ref.set(state, { ...current, excluded: [...current.excluded, path] });
					return true;
				}),
			fetchRef: (_repo, ref) =>
				Effect.gen(function* () {
					const current = yield* read('fetchRef');
					yield* Ref.set(state, { ...current, fetches: [...current.fetches, ref] });
					return current.remoteRefs[ref] ?? current.headSha;
				}),
			mergeBase: () => Effect.map(read('mergeBase'), (s) => s.baseSha)
		};

		const fake: GitFakeShape = {
			state: Ref.get(state),
			update: (f) => Ref.update(state, f),
			afterPushHead: (hook) => Ref.set(pushHook, hook),
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
	readonly step: StepName;
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
	/** The head `viewPr` reports; `GitFake`'s default base sha when absent. */
	readonly headSha?: GitSha;
	/** The PR comes from a fork; `false` when absent. */
	readonly isCrossRepository?: boolean;
	/** Maintainers may push to the fork's branch; `false` when absent. */
	readonly maintainerCanModify?: boolean;
	/** The repository of the PR's branch; the PR's own repository when absent. */
	readonly headRepository?: { readonly owner: string; readonly name: string } | null;
}

/** A review thread in the fake GitHub, resolved or not. */
export interface FakeThread extends ReviewThread {
	readonly prUrl: string;
	readonly resolved: boolean;
	/** An outdated thread is on a line the PR's diff no longer has. */
	readonly outdated: boolean;
}

/** A review posted through the fake, with the URL it got. */
export interface FakeReview extends SubmitReviewInput {
	readonly url: string;
}

export interface GhFakeShape {
	/** Every PR ever opened, open or not, oldest first. */
	readonly prs: Effect.Effect<ReadonlyArray<FakePr>>;
	/** Every review posted, oldest first. */
	readonly reviews: Effect.Effect<ReadonlyArray<FakeReview>>;
	/** Adds an open PR, as if a previous attempt had opened it. */
	readonly addPr: (pr: Omit<FakePr, 'url' | 'number'>) => Effect.Effect<FakePr>;
	/** Moves a PR's head, as a push to its branch would. */
	readonly setHead: (url: string, headSha: GitSha) => Effect.Effect<void>;
	/**
	 * Runs `hook` inside every later `submitReview`, after the review is recorded: a hook
	 * that never ends stands for a crash after GitHub accepted the review.
	 */
	readonly afterSubmit: (hook: Effect.Effect<void>) => Effect.Effect<void>;
	/** Every review thread, oldest first; posting a review opens one per inline comment. */
	readonly threads: Effect.Effect<ReadonlyArray<FakeThread>>;
	/**
	 * Opens a review thread on a PR, as a reviewer commenting on GitHub would; one who may
	 * push to the repository unless `authorCanWrite` says otherwise.
	 */
	readonly addThread: (
		thread: Omit<FakeThread, 'id' | 'url' | 'resolved' | 'outdated' | 'authorCanWrite'> &
			Partial<Pick<FakeThread, 'resolved' | 'outdated' | 'authorCanWrite'>>
	) => Effect.Effect<FakeThread>;
	/**
	 * Runs `hook` inside every later `resolveThread`, after the thread is resolved: a hook
	 * that never ends stands for a crash after GitHub resolved the thread.
	 */
	readonly afterResolve: (hook: Effect.Effect<void>) => Effect.Effect<void>;
	/** Every `resolveThread` call's thread id, in order, including repeats. */
	readonly resolveCalls: Effect.Effect<ReadonlyArray<string>>;
	/** Makes `method` fail with a `GhError` carrying `stderr`, until cleared with `succeed`. */
	readonly fail: (method: keyof GhShape, stderr: string) => Effect.Effect<void>;
	readonly succeed: (method: keyof GhShape) => Effect.Effect<void>;
}

export class GhFake extends Context.Service<GhFake, GhFakeShape>()('@ship/core/GhFake') {
	/** A fake `Gh` over an in-memory list of PRs, plus `GhFake` to inspect and drive it. */
	static readonly layer: Layer.Layer<Gh | GhFake> = Layer.effectContext(
		Effect.gen(function* () {
			const prs = yield* Ref.make<ReadonlyArray<FakePr>>([]);
			const reviews = yield* Ref.make<ReadonlyArray<FakeReview>>([]);
			const submitHook = yield* Ref.make<Effect.Effect<void>>(Effect.void);
			const threads = yield* Ref.make<ReadonlyArray<FakeThread>>([]);
			const resolveHook = yield* Ref.make<Effect.Effect<void>>(Effect.void);
			const resolveCalls = yield* Ref.make<ReadonlyArray<string>>([]);

			const addThread: GhFakeShape['addThread'] = (thread) =>
				Ref.modify(threads, (current): [FakeThread, ReadonlyArray<FakeThread>] => {
					const n = current.length + 1;
					const created: FakeThread = {
						resolved: false,
						outdated: false,
						authorCanWrite: true,
						...thread,
						id: `PRRT_${n}`,
						url: `${thread.prUrl}#discussion_r${n}`
					};
					return [created, [...current, created]];
				});
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
					),
				viewPr: (_repo, ref) =>
					Effect.andThen(guard('viewPr'), () =>
						Effect.flatMap(Ref.get(prs), (current) => {
							// Like `gh`, a URL names a PR of its own repository; a number, one of this repo's.
							const asUrl = parsePrUrl(ref);
							const pr = current.find((candidate) =>
								asUrl === null
									? candidate.number === Number(ref)
									: candidate.number === asUrl.number &&
										prRepoKey(candidate.url) === prRepoKey(ref)
							);
							return pr === undefined
								? Effect.fail(
										new GhError({
											args: ['pr', 'view', ref],
											cwd: '/repo',
											exitCode: 1,
											stderr: `no pull requests found for ${ref}`
										})
									)
								: Effect.succeed({
										number: pr.number,
										url: pr.url,
										title: pr.title,
										body: pr.body,
										baseRef: pr.base,
										headSha: pr.headSha ?? DEFAULT_BASE,
										headRef: pr.head,
										headRepository:
											pr.headRepository === undefined
												? { owner: 'f-elix', name: 'example' }
												: pr.headRepository,
										isCrossRepository: pr.isCrossRepository ?? false,
										maintainerCanModify: pr.maintainerCanModify ?? false
									});
						})
					),
				submitReview: (_repo, input) =>
					Effect.andThen(guard('submitReview'), () =>
						Ref.modify(reviews, (current): [string, ReadonlyArray<FakeReview>] => {
							const url = `${input.prUrl}#pullrequestreview-${current.length + 1}`;
							return [url, [...current, { ...input, url }]];
						}).pipe(
							Effect.tap(() =>
								Effect.forEach(input.comments, (comment) =>
									addThread({
										prUrl: input.prUrl,
										path: comment.path,
										line: comment.line,
										author: 'ship-bot',
										body: comment.body
									})
								)
							),
							Effect.tap(() => Effect.flatten(Ref.get(submitHook)))
						)
					),
				reviewThreads: (_repo, prUrl) =>
					Effect.andThen(guard('reviewThreads'), () =>
						Effect.map(Ref.get(threads), (current) =>
							current
								.filter(
									(thread) =>
										thread.prUrl === prUrl &&
										!thread.resolved &&
										!thread.outdated
								)
								.map((thread): ReviewThread =>
									Struct.omit(thread, ['prUrl', 'resolved', 'outdated'])
								)
						)
					),
				resolveThread: (_repo, { threadId }) =>
					Effect.andThen(guard('resolveThread'), () =>
						Effect.gen(function* () {
							yield* Ref.update(resolveCalls, (current) => [...current, threadId]);
							yield* Ref.update(threads, (current) =>
								current.map((thread) =>
									thread.id === threadId ? { ...thread, resolved: true } : thread
								)
							);
							yield* Effect.flatten(Ref.get(resolveHook));
						})
					),
				findReview: (_repo, { prUrl, marker }) =>
					Effect.andThen(guard('findReview'), () =>
						Effect.map(
							Ref.get(reviews),
							(current) =>
								current.find(
									(review) =>
										review.prUrl === prUrl && review.body.includes(marker)
								)?.url ?? null
						)
					)
			};
			const fake: GhFakeShape = {
				prs: Ref.get(prs),
				reviews: Ref.get(reviews),
				addPr: (pr) => add(pr),
				setHead: (url, headSha) => update(url, (pr) => ({ ...pr, headSha })),
				afterSubmit: (hook) => Ref.set(submitHook, hook),
				threads: Ref.get(threads),
				addThread,
				afterResolve: (hook) => Ref.set(resolveHook, hook),
				resolveCalls: Ref.get(resolveCalls),
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

/**
 * A PR agent's answer: like an agent following the `pr` skill, it opens the PR for the
 * branch its prompt names, at the commit its prompt names, or updates the open one, with
 * `title` and `body`.
 */
export const opensPr = (text: {
	readonly title: string;
	readonly body: string;
	readonly costUsd?: number;
}) =>
	Effect.gen(function* () {
		const gh = yield* Gh;
		const fake = yield* GhFake;
		const script: AgentScript = (input) =>
			Effect.gen(function* () {
				const pushed = /The branch is `([^`]+)`, already pushed at (\w+)/u.exec(
					input.prompt
				);
				const base = /The base is `([^`]+)`/u.exec(input.prompt)?.[1];
				if (pushed === null || base === undefined) {
					return yield* Effect.die(new Error('The PR prompt names no branch or base'));
				}
				const [, branch = '', sha = ''] = pushed;
				const headSha = GitSha.make(sha);
				const repo = { cwd: input.cwd, env: input.env };
				const existing = yield* gh.findPr(repo, branch);
				const url =
					existing === null
						? (yield* fake.addPr({
								base,
								head: branch,
								title: text.title,
								body: text.body,
								draft: input.prompt.includes('Open a new PR as a draft'),
								headSha
							})).url
						: existing.url;
				if (existing !== null) {
					yield* gh.editPr(repo, { url, title: text.title, body: text.body });
					yield* fake.setHead(url, headSha);
				}
				return {
					text: url,
					...(text.costUsd === undefined ? {} : { costUsd: text.costUsd })
				};
			}).pipe(Effect.orDie);
		return script;
	});

// --- Clef ---

/** One `ask` that reached the fake Clef: the project had Clef on and asked something. */
export interface ClefAsk {
	readonly decision: string;
	readonly state: string;
	readonly questions: ClefQuestions;
}

/** A scripted answer; it must match the type of the question it answers. */
export type ClefFakeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface ClefFakeShape {
	/** Every `ask` that reached Clef, oldest first; one with Clef off or no questions does not. */
	readonly asks: Effect.Effect<ReadonlyArray<ClefAsk>>;
	/**
	 * Scripts the answer to every later question with id `id`. An unscripted question gets
	 * the answer that changes nothing: `noul` 0, `choice` its first option, `score` its
	 * middle level.
	 */
	readonly answer: (id: string, value: ClefFakeAnswer) => Effect.Effect<void>;
	/**
	 * Makes Clef unavailable until cleared with `succeed`: `ask` returns `null`, as the real
	 * Clef does when its call fails, and `verify` fails with `error`.
	 */
	readonly fail: (error: ClefError) => Effect.Effect<void>;
	readonly succeed: Effect.Effect<void>;
}

/** The answer an unscripted question gets: one that leaves every decision as without Clef. */
const neutralAnswer = (question: ClefQuestion): ClefFakeAnswer => {
	switch (question.type) {
		case 'noul':
			return { p: 0 };
		case 'choice': {
			const [first = ''] = Object.keys(question.criteria);
			return { pick: first, probabilities: { [first]: 1 } };
		}
		case 'score':
			return { score: (question.criteria.length - 1) / 2 };
	}
};

export class ClefFake extends Context.Service<ClefFake, ClefFakeShape>()('@ship/core/ClefFake') {
	/** A fake `Clef` that gives scripted answers, plus `ClefFake` to script and inspect it. */
	static readonly layer: Layer.Layer<Clef | ClefFake> = Layer.effectContext(
		Effect.gen(function* () {
			const asks = yield* Ref.make<ReadonlyArray<ClefAsk>>([]);
			const scripted = yield* Ref.make<ReadonlyMap<string, ClefFakeAnswer>>(new Map());
			const failure = yield* Ref.make<ClefError | null>(null);

			const clef: ClefShape = {
				ask: <const Qs extends ClefQuestions>(scope: ClefScope, request: ClefRequest<Qs>) =>
					Effect.gen(function* () {
						const entries = Object.entries(request.questions);
						// Built per question like the real Clef's answers, so they match `Qs`.
						if (entries.length === 0) return {} as ClefAnswers<Qs>;
						if (!scope.config.clef) return null;
						yield* Ref.update(asks, (all) => [
							...all,
							{
								decision: request.decision,
								state: request.state,
								questions: request.questions
							}
						]);
						if ((yield* Ref.get(failure)) !== null) return null;
						const answers = yield* Ref.get(scripted);
						return Object.fromEntries(
							entries.map(([id, question]) => [
								id,
								answers.get(id) ?? neutralAnswer(question)
							])
						) as ClefAnswers<Qs>;
					}),
				verify: () =>
					Effect.flatMap(Ref.get(failure), (error) =>
						error === null ? Effect.void : Effect.fail(error)
					)
			};
			const fake: ClefFakeShape = {
				asks: Ref.get(asks),
				answer: (id, value) =>
					Ref.update(scripted, (current) => new Map([...current, [id, value]])),
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
