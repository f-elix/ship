import {
	cancelFromLog,
	DaemonBusy,
	initialRunState,
	InvalidRunStatus,
	isWaitingState,
	resumeRun,
	RunJournal,
	ShipRpcs,
	startRun,
	TerminalRunStatus,
	VersionMismatch,
	type RunId,
	type RunInfo,
	type RunNotFound,
	type RunStatus
} from '@ship/core';
import { RunStore, type StoredRunStatus } from '@ship/store';
import { Context, Deferred, Effect, Schema } from 'effect';
import type { Rpc, RpcGroup } from 'effect/rpc';
import { checkPreconditions } from './preconditions.ts';
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

/** The RPC handlers, over the run store, the run host and the config loader. */
export const handlers = ShipRpcs.toLayer(
	Effect.gen(function* () {
		const control = yield* DaemonControl;
		const store = yield* RunStore;
		const host = yield* RunHost;
		// The services the preconditions use, captured once for every `run` call.
		const preconditions =
			yield* Effect.context<Effect.Services<ReturnType<typeof checkPreconditions>>>();

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

			resume: Effect.fn('Daemon.resume')(function* ({ runId, env }) {
				// Lets a start or a cancel in progress settle, so the status read is current.
				yield* host.active(runId);
				const info = yield* store.get(runId);
				if (info.status !== 'interrupted') {
					return yield* new InvalidRunStatus({ runId, status: info.status });
				}
				yield* host.launch(runId, resumeRun(runId, env));
			}),

			cancel: ({ runId }) => cancelRun(runId),

			status: Effect.fn('Daemon.status')(function* ({ runId }) {
				return withLiveStatus(yield* store.get(runId));
			}),

			list,

			events: ({ runId, fromSeq }) => store.follow(runId, fromSeq),

			stop: Effect.fn('Daemon.stop')(function* ({ force }) {
				const activeRuns = yield* host.activeCount;
				if (activeRuns > 0 && force !== true) return yield* new DaemonBusy({ activeRuns });
				yield* Deferred.succeed(control.shutdown, undefined);
			})
		});
	})
);
