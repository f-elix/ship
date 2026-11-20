import {
	baselinePass,
	cancelFromLog,
	Checks,
	ChecksAborted,
	DaemonBusy,
	Git,
	initialFixRunState,
	initialPrimitiveRunState,
	initialRecheckRunState,
	initialReviewRunState,
	initialRunState,
	InvalidRunStatus,
	isResumable,
	isWaitingState,
	PreconditionFailed,
	resumeRun,
	RunJournal,
	ShipRpcs,
	startFix,
	startPrimitiveRun,
	startRecheck,
	startReview,
	startRun,
	TerminalRunStatus,
	VersionMismatch,
	type CheckEvent,
	type CheckSpawnError,
	type CheckTimeout,
	type Env,
	type NewPrimitiveRunState,
	type RunId,
	type RunInfo,
	type RunNotFound,
	type RunStatus,
	type UnknownLockResource
} from '@ship/core';
import { RunStore, type StoredRunStatus } from '@ship/store';
import { Context, Deferred, Effect, Queue, Ref, Schema, Stream } from 'effect';
import type { Rpc, RpcGroup } from 'effect/rpc';
import {
	checkBranchPreconditions,
	checkFixPreconditions,
	checkPostPreconditions,
	checkPreconditions,
	checkRecheckPreconditions,
	checkReviewPreconditions,
	loadProjectConfig
} from './preconditions.ts';
import { RunHost } from './run-host.ts';

/** What the handlers need from the daemon itself. */
export class DaemonControl extends Context.Service<
	DaemonControl,
	{
		readonly version: string;
		/** Completed by `stop`; the daemon then shuts down. */
		readonly shutdown: Deferred.Deferred<void>;
	}
>()('@ship/daemon/DaemonControl') {}

const isTerminal = Schema.is(TerminalRunStatus);

type ListFilter = Rpc.Payload<Rpc.ExtractTag<RpcGroup.Rpcs<typeof ShipRpcs>, 'list'>>;

/** A `running` run whose machine waits for a check lock is reported as `waiting`. */
const withLiveStatus = (info: RunInfo): RunInfo =>
	info.status === 'running' && isWaitingState(info.state) ? { ...info, status: 'waiting' } : info;

const storedStatus = (status: RunStatus): StoredRunStatus =>
	status === 'waiting' ? 'running' : status;

const abortReason = (error: CheckSpawnError | CheckTimeout | UnknownLockResource): string => {
	switch (error._tag) {
		case 'CheckSpawnError':
			return `cannot start \`${error.commandLine}\` in ${error.cwd}: ${error.detail}`;
		case 'CheckTimeout':
			return error.message;
		case 'UnknownLockResource':
			return `the daemon has no permits for lock ${error.resource}`;
	}
};

/** The RPC handlers, over the run store, the run host and the config loader. */
export const handlers = ShipRpcs.toLayer(
	Effect.gen(function* () {
		const control = yield* DaemonControl;
		const store = yield* RunStore;
		const host = yield* RunHost;
		// The services the preconditions use, captured once for every call that starts a run
		// and every `runChecks` call.
		const preconditions = yield* Effect.context<
			| Effect.Services<ReturnType<typeof checkPreconditions>>
			| Effect.Services<ReturnType<typeof checkReviewPreconditions>>
			| Effect.Services<ReturnType<typeof checkFixPreconditions>>
			| Effect.Services<ReturnType<typeof checkRecheckPreconditions>>
			| Effect.Services<ReturnType<typeof checkBranchPreconditions>>
			| Effect.Services<ReturnType<typeof checkPostPreconditions>>
		>();
		const git = yield* Git;
		const checks = yield* Checks;
		// `runChecks` passes in progress: a non-forced `stop` is refused while any runs.
		const checkPasses = yield* Ref.make(0);

		const list = Effect.fn('Daemon.list')(function* (filter: ListFilter) {
			const wanted = filter.status;
			// `waiting` is not stored: telling `running` and `waiting` apart needs every
			// `running` row, so the limit is applied after the live status is known.
			const splitsRunning =
				wanted !== undefined && wanted.includes('running') !== wanted.includes('waiting');
			const runs = yield* store.list({
				...(filter.projectKey === undefined ? {} : { projectKey: filter.projectKey }),
				...(wanted === undefined ? {} : { status: [...new Set(wanted.map(storedStatus))] }),
				...(filter.limit === undefined || splitsRunning ? {} : { limit: filter.limit })
			});
			const live = runs
				.map(withLiveStatus)
				.filter((info) => wanted === undefined || wanted.includes(info.status));
			return filter.limit === undefined ? live : live.slice(0, filter.limit);
		});

		/**
		 * Creates and launches a primitive run as one step, like `run`, once its
		 * preconditions held.
		 */
		const launchPrimitiveRun = (
			request: { readonly cwd: string; readonly env: Env },
			start: Omit<NewPrimitiveRunState, 'runId' | 'cwd' | 'env'>
		) =>
			Effect.gen(function* () {
				if (!(yield* host.accepting)) return yield* Effect.interrupt;
				const runId = yield* Effect.uninterruptible(
					Effect.gen(function* () {
						const { runId } = yield* store.createPrimitiveRun({
							kind: start.kind,
							projectKey: start.projectKey,
							repoDir: request.cwd,
							baseSha: start.baseSha,
							branch: start.branch,
							planDir: start.planDir,
							review: start.review
						});
						const state = initialPrimitiveRunState({
							...start,
							runId,
							cwd: request.cwd,
							env: request.env
						});
						yield* host
							.launch(runId, startPrimitiveRun(state))
							.pipe(Effect.catchTag('InvalidRunStatus', Effect.die));
						return runId;
					})
				);
				return { runId };
			});

		const cancelRun: (runId: RunId) => Effect.Effect<void, RunNotFound | InvalidRunStatus> =
			Effect.fn('Daemon.cancel')(function* (runId: RunId) {
				const handle = yield* host.active(runId);
				if (handle !== undefined) {
					yield* handle.cancel;
					yield* handle.await;
					return;
				}
				// No machine runs it here (it was interrupted, or its machine died): finish it
				// from its log, holding its claim so it cannot be resumed meanwhile.
				const claimed = yield* host.exclusive(
					runId,
					Effect.gen(function* () {
						const info = yield* store.get(runId);
						if (isTerminal(info.status)) {
							return yield* new InvalidRunStatus({ runId, status: info.status });
						}
						yield* cancelFromLog(runId).pipe(Effect.provideService(RunJournal, store));
					})
				);
				if (claimed) return;
				// The daemon is stopping: it takes no claims, and marks the run interrupted.
				if (!(yield* host.accepting)) return yield* Effect.interrupt;
				// Claimed since `active` returned: by a launch (then its machine is cancelled) or
				// another cancel (then the run is finished by now).
				yield* cancelRun(runId);
			});

		return ShipRpcs.of({
			handshake: Effect.fn('Daemon.handshake')(function* ({ version }) {
				const activeRuns = yield* host.activeCount;
				if (version !== control.version) {
					return yield* new VersionMismatch({
						clientVersion: version,
						daemonVersion: control.version,
						activeRuns
					});
				}
				return { version: control.version, activeRuns };
			}),

			run: Effect.fn('Daemon.run')(function* (request) {
				const start = yield* checkPreconditions(request).pipe(
					Effect.provide(preconditions)
				);
				// A run the daemon would not launch is never created.
				if (!(yield* host.accepting)) return yield* Effect.interrupt;
				// Created and launched as one step: a client that disconnects in between would
				// leave a `running` run without a machine.
				const runId = yield* Effect.uninterruptible(
					Effect.gen(function* () {
						const { runId } = yield* store.create({
							projectKey: start.projectKey,
							cwd: request.cwd,
							planDir: request.planDir,
							branch: start.branch,
							baseSha: start.baseSha
						});
						const state = initialRunState({
							runId,
							projectKey: start.projectKey,
							cwd: request.cwd,
							env: request.env,
							planDir: request.planDir,
							branch: start.branch,
							baseSha: start.baseSha,
							config: start.config
						});
						// A new run id: it cannot be running already.
						yield* host
							.launch(runId, startRun(state))
							.pipe(Effect.catchTag('InvalidRunStatus', Effect.die));
						return runId;
					})
				);
				return { runId };
			}),

			review: Effect.fn('Daemon.review')(function* (request) {
				const start = yield* checkReviewPreconditions(request).pipe(
					Effect.provide(preconditions)
				);
				if (!(yield* host.accepting)) return yield* Effect.interrupt;
				// Created and launched as one step, like `run`.
				const runId = yield* Effect.uninterruptible(
					Effect.gen(function* () {
						const { runId } = yield* store.createReview({
							projectKey: start.projectKey,
							repoDir: request.cwd,
							prUrl: start.pr.url,
							prNumber: start.pr.number,
							baseSha: start.pr.baseSha,
							headSha: start.pr.headSha
						});
						const state = initialReviewRunState({
							runId,
							projectKey: start.projectKey,
							cwd: request.cwd,
							env: request.env,
							config: start.config,
							pr: start.pr,
							post: request.post
						});
						yield* host
							.launch(runId, startReview(state))
							.pipe(Effect.catchTag('InvalidRunStatus', Effect.die));
						return runId;
					})
				);
				return { runId };
			}),

			fix: Effect.fn('Daemon.fix')(function* (request) {
				const start = yield* checkFixPreconditions(request).pipe(
					Effect.provide(preconditions)
				);
				if (!(yield* host.accepting)) return yield* Effect.interrupt;
				// Created and launched as one step, like `run`.
				const runId = yield* Effect.uninterruptible(
					Effect.gen(function* () {
						const { runId } = yield* store.createPrRun({
							kind: 'fix',
							projectKey: start.projectKey,
							repoDir: request.cwd,
							prUrl: start.pr.url,
							prNumber: start.pr.number,
							baseSha: start.pr.headSha,
							headSha: start.pr.headSha,
							source: request.source,
							findings: start.loaded.findings,
							ignoredThreads: start.loaded.ignoredThreads
						});
						const state = initialFixRunState({
							runId,
							projectKey: start.projectKey,
							cwd: request.cwd,
							env: request.env,
							config: start.config,
							pr: start.pr,
							findings: start.loaded.findings,
							push: start.push,
							runChecks: request.checks
						});
						yield* host
							.launch(runId, startFix(state))
							.pipe(Effect.catchTag('InvalidRunStatus', Effect.die));
						return runId;
					})
				);
				return { runId };
			}),

			recheck: Effect.fn('Daemon.recheck')(function* (request) {
				const start = yield* checkRecheckPreconditions(request).pipe(
					Effect.provide(preconditions)
				);
				if (!(yield* host.accepting)) return yield* Effect.interrupt;
				// Created and launched as one step, like `run`.
				const runId = yield* Effect.uninterruptible(
					Effect.gen(function* () {
						const { runId } = yield* store.createPrRun({
							kind: 'recheck',
							projectKey: start.projectKey,
							repoDir: request.cwd,
							prUrl: start.pr.url,
							prNumber: start.pr.number,
							baseSha: start.baseSha,
							headSha: start.pr.headSha,
							source: request.source,
							findings: start.loaded.findings,
							ignoredThreads: start.loaded.ignoredThreads
						});
						const state = initialRecheckRunState({
							runId,
							projectKey: start.projectKey,
							cwd: request.cwd,
							env: request.env,
							config: start.config,
							baseSha: start.baseSha,
							pr: start.pr,
							intent: start.loaded.intent,
							findings: start.loaded.findings,
							threads: start.loaded.threads,
							resolve: !request.local
						});
						yield* host
							.launch(runId, startRecheck(state))
							.pipe(Effect.catchTag('InvalidRunStatus', Effect.die));
						return runId;
					})
				);
				return { runId };
			}),

			implement: Effect.fn('Daemon.implement')(function* (request) {
				const start = yield* checkPreconditions(request).pipe(
					Effect.provide(preconditions)
				);
				return yield* launchPrimitiveRun(request, {
					...start,
					kind: 'implement',
					planDir: request.planDir,
					runChecks: request.checks,
					review: null
				});
			}),

			checks: Effect.fn('Daemon.checks')(function* (request) {
				const start = yield* checkBranchPreconditions('checks', {
					...request,
					planDir: null
				}).pipe(Effect.provide(preconditions));
				return yield* launchPrimitiveRun(request, {
					...start,
					kind: 'checks',
					planDir: null,
					runChecks: true,
					review: null
				});
			}),

			pr: Effect.fn('Daemon.pr')(function* (request) {
				const start = yield* checkBranchPreconditions('pr', request).pipe(
					Effect.provide(preconditions)
				);
				return yield* launchPrimitiveRun(request, {
					...start,
					kind: 'pr',
					planDir: request.planDir,
					runChecks: false,
					review: null
				});
			}),

			post: Effect.fn('Daemon.post')(function* (request) {
				const start = yield* checkPostPreconditions(request).pipe(
					Effect.provide(preconditions)
				);
				return yield* launchPrimitiveRun(request, {
					...start,
					kind: 'post',
					planDir: null,
					branch: null,
					runChecks: false,
					review: request.review
				});
			}),

			resume: Effect.fn('Daemon.resume')(function* ({ runId, env }) {
				// Lets a start or a cancel in progress settle, so the status read is current.
				yield* host.active(runId);
				const info = yield* store.get(runId);
				if (!isResumable(info.status)) {
					return yield* new InvalidRunStatus({ runId, status: info.status });
				}
				yield* host.launch(runId, resumeRun(runId, env));
			}),

			cancel: ({ runId }) => cancelRun(runId),

			status: Effect.fn('Daemon.status')(function* ({ runId }) {
				return withLiveStatus(yield* store.get(runId));
			}),

			list,

			events: ({ runId, fromSeq, follow }) =>
				follow === false
					? Stream.fromIterableEffect(store.events(runId, fromSeq))
					: store.follow(runId, fromSeq),

			runChecks: ({ cwd, env }) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const repo = { cwd, env };
						const key = yield* git.projectKey(repo).pipe(
							Effect.mapError(
								(error) =>
									new PreconditionFailed({
										reason: 'not-a-git-repo',
										detail: error.message
									})
							)
						);
						const config = yield* loadProjectConfig(key).pipe(
							Effect.provide(preconditions)
						);
						return Stream.callback<CheckEvent, ChecksAborted>((queue) => {
							// Checks run one at a time; this is the one an abort stops.
							let running: string | null = null;
							const onEvent = (event: CheckEvent) => {
								if (event._tag === 'CheckStarted') running = event.check;
								if (event._tag === 'CheckFinished') running = null;
								return Queue.offer(queue, event);
							};
							// Counted until the stream's scope closes: it ends, fails, or is
							// interrupted (a client disconnect included).
							const counted = Effect.acquireRelease(
								Ref.update(checkPasses, (n) => n + 1),
								() => Ref.update(checkPasses, (n) => n - 1)
							);
							return counted.pipe(
								Effect.andThen(
									checks.run(baselinePass({ cwd, env, config, onEvent }))
								),
								Effect.mapError(
									(error) =>
										new ChecksAborted({
											check:
												error._tag === 'CheckTimeout'
													? error.check
													: running,
											detail: abortReason(error)
										})
								),
								Effect.andThen(Queue.end(queue))
							);
						});
					}).pipe(Effect.withSpan('Daemon.runChecks'))
				),

			stop: Effect.fn('Daemon.stop')(function* ({ force }) {
				const activeRuns = yield* host.activeCount;
				const activeCheckPasses = yield* Ref.get(checkPasses);
				if ((activeRuns > 0 || activeCheckPasses > 0) && force !== true) {
					return yield* new DaemonBusy({ activeRuns, activeCheckPasses });
				}
				yield* Deferred.succeed(control.shutdown, undefined);
			})
		});
	})
);
