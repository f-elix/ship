import { describe, expect, it } from '@effect/vitest';
import {
	DaemonBusy,
	PreconditionFailed,
	shipPaths,
	SnapshotNotResumable,
	VersionMismatch,
	type RunId
} from '@ship/core';
import { AgentFake, GhFake, type AgentScript } from '@ship/core/testing';
import { Context, Deferred, Effect, Exit, Fiber, Scope, Stream } from 'effect';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DaemonAlreadyRunning } from '../src/index.ts';
import {
	addsFeature,
	allEvents,
	client,
	daemon,
	eventually,
	fakes,
	fixture,
	scriptHappyRun,
	VERSION,
	type Fixture
} from './harness.ts';

const TIMEOUT = 30_000;

/** An implementer call that signals `started`, then waits for `proceed` before editing. */
const gatedImplement =
	(started: Deferred.Deferred<void>, proceed: Deferred.Deferred<void>): AgentScript =>
	(input) =>
		Deferred.succeed(started, undefined).pipe(
			Effect.andThen(Deferred.await(proceed)),
			Effect.andThen(addsFeature(input))
		);

/** The reason `run` fails with for `request`. */
const preconditionOf = (
	rpc: Effect.Success<ReturnType<typeof client>>,
	request: Fixture['request']
) =>
	rpc.run(request).pipe(
		Effect.flip,
		Effect.map((error) => (error instanceof PreconditionFailed ? error.reason : error._tag))
	);

describe('daemon', () => {
	it.live(
		'runs a pipeline over RPC, with the caller env, and reports it through events and status',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				yield* scriptHappyRun(Context.get(services, AgentFake));
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);

				expect(yield* rpc.handshake({ version: VERSION })).toEqual({
					version: VERSION,
					activeRuns: 0
				});
				const { runId } = yield* rpc.run(fx.request);
				const events = yield* allEvents(rpc, runId);

				expect(events[0]).toBe('RunCreated');
				expect(events.at(-1)).toBe('RunFinished');
				const info = yield* rpc.status({ runId });
				expect(info).toMatchObject({ runId, status: 'done', state: 'done', cwd: fx.work });
				expect(info.summary).toMatchObject({
					status: 'done',
					prUrl: 'https://github.com/f-elix/example/pull/1',
					costUsd: 0.65
				});
				const prs = yield* Context.get(services, GhFake).prs;
				expect(prs.map((pr) => pr.head)).toEqual(['feature']);
				expect(yield* rpc.list({ status: ['done'] })).toHaveLength(1);
				expect(yield* rpc.handshake({ version: VERSION })).toEqual({
					version: VERSION,
					activeRuns: 0
				});
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'refuses runs whose preconditions fail, with typed errors',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				yield* daemon(fx.home, yield* fakes);
				const rpc = yield* client(fx.home);
				const notARepo = join(fx.dir, 'elsewhere');
				mkdirSync(notARepo);

				expect(yield* preconditionOf(rpc, { ...fx.request, cwd: notARepo })).toBe(
					'not-a-git-repo'
				);
				expect(
					yield* preconditionOf(rpc, { ...fx.request, planDir: join(fx.dir, 'no-plan') })
				).toBe('missing-plan-files');

				fx.write('dirty.txt', 'uncommitted\n');
				expect(yield* preconditionOf(rpc, fx.request)).toBe('dirty-tree');
				unlinkSync(join(fx.work, 'dirty.txt'));

				fx.git('switch', '--quiet', 'main');
				expect(yield* preconditionOf(rpc, fx.request)).toBe('on-default-branch');
				fx.git('switch', '--quiet', '--detach', 'HEAD');
				expect(yield* preconditionOf(rpc, fx.request)).toBe('detached-head');
				fx.git('switch', '--quiet', 'feature');

				// Locks are read when the daemon starts, so one added since is unknown to it.
				fx.configure(
					{ locks: { cpu: 2, gpu: 1 } },
					{ checks: [{ name: 'train', run: 'true', lock: 'gpu' }] }
				);
				expect(yield* preconditionOf(rpc, fx.request)).toBe('invalid-config');

				fx.git('remote', 'set-url', 'origin', 'https://github.com/f-elix/unknown.git');
				expect(yield* preconditionOf(rpc, fx.request)).toBe('unknown-project-config');

				fx.git('remote', 'set-head', 'origin', '--delete');
				fx.git('update-ref', '-d', 'refs/remotes/origin/main');
				fx.git('branch', '--quiet', '-m', 'main', 'trunk');
				expect(yield* preconditionOf(rpc, fx.request)).toBe('unknown-default-branch');

				expect(yield* rpc.list({})).toEqual([]);
				// The plan dir was excluded, so it never makes the tree dirty.
				expect(fx.git('status', '--porcelain')).toBe('');
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'reports a version mismatch with the active run count, and refuses to stop while a run is active',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				const started = yield* Deferred.make<void>();
				yield* Context.get(services, AgentFake).script(
					{ step: 'implement' },
					gatedImplement(started, yield* Deferred.make<void>())
				);
				const scope = yield* Scope.make();
				const running = yield* daemon(fx.home, services).pipe(Scope.provide(scope));
				const rpc = yield* client(fx.home);
				const { runId } = yield* rpc.run(fx.request);
				yield* Deferred.await(started);

				const mismatch = yield* Effect.flip(rpc.handshake({ version: '0.0.1' }));
				expect(mismatch).toBeInstanceOf(VersionMismatch);
				expect(mismatch).toMatchObject({
					clientVersion: '0.0.1',
					daemonVersion: VERSION,
					activeRuns: 1
				});

				const busy = yield* Effect.flip(rpc.stop({}));
				expect(busy).toBeInstanceOf(DaemonBusy);
				expect(busy).toMatchObject({ activeRuns: 1 });
				expect((yield* rpc.status({ runId })).status).toBe('running');

				// A second daemon on the same home refuses to start.
				const second = yield* Effect.exit(daemon(fx.home, services));
				expect(Exit.isFailure(second) && Exit.findErrorOption(second)).toMatchObject({
					_tag: 'Some',
					value: expect.any(DaemonAlreadyRunning)
				});

				yield* rpc.stop({ force: true });
				yield* running.stopRequested;
				yield* Scope.close(scope, Exit.void);
				expect(existsSync(running.paths.socket)).toBe(false);
				expect(existsSync(running.paths.pidFile)).toBe(false);

				yield* daemon(fx.home, services);
				const after = yield* client(fx.home);
				expect((yield* after.status({ runId })).status).toBe('interrupted');
				expect((yield* allEvents(after, runId)).at(-1)).toBe('RunInterrupted');

				// A snapshot naming a state the pipeline does not have cannot be resumed.
				const db = new DatabaseSync(running.paths.db);
				db.prepare(
					`UPDATE snapshots SET snapshot = json_set(snapshot, '$.value', 'nowhere') WHERE run_id = ?`
				).run(runId);
				const unfit = yield* Effect.flip(after.resume({ runId, env: fx.env }));
				expect(unfit).toBeInstanceOf(SnapshotNotResumable);
				expect((yield* after.status({ runId })).status).toBe('interrupted');
				expect((yield* allEvents(after, runId)).at(-1)).toBe('RunInterrupted');

				// A run whose snapshot is gone cannot be resumed, and stays interrupted.
				db.prepare('DELETE FROM snapshots WHERE run_id = ?').run(runId);
				db.close();
				const notResumable = yield* Effect.flip(after.resume({ runId, env: fx.env }));
				expect(notResumable).toBeInstanceOf(SnapshotNotResumable);
				expect((yield* after.status({ runId })).status).toBe('interrupted');
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'keeps a run going when a client disconnects mid-stream',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				const agent = Context.get(services, AgentFake);
				const started = yield* Deferred.make<void>();
				const proceed = yield* Deferred.make<void>();
				yield* scriptHappyRun(agent, gatedImplement(started, proceed));
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);

				const watcherScope = yield* Scope.make();
				const watcher = yield* client(fx.home).pipe(Scope.provide(watcherScope));
				const received = yield* Deferred.make<RunId>();
				const { runId } = yield* rpc.run(fx.request);
				const stream = yield* watcher.events({ runId }).pipe(
					Stream.tap(() => Deferred.succeed(received, runId)),
					Stream.runDrain,
					Effect.forkChild
				);
				yield* Deferred.await(received);
				yield* Deferred.await(started);
				// Disconnect: stop reading and close the client's connections.
				yield* Fiber.interrupt(stream);
				yield* Scope.close(watcherScope, Exit.void);
				yield* Deferred.succeed(proceed, undefined);

				const events = yield* allEvents(rpc, runId);
				expect(events.at(-1)).toBe('RunFinished');
				expect((yield* rpc.status({ runId })).status).toBe('done');
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'lets exactly one of two daemons started at once claim the home',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				const exits = yield* Effect.all(
					[
						Effect.exit(daemon(fx.home, services)),
						Effect.exit(daemon(fx.home, services))
					],
					{ concurrency: 'unbounded' }
				);
				const failures = exits.filter(Exit.isFailure);
				expect(failures).toHaveLength(1);
				expect(failures.map((exit) => Exit.findErrorOption(exit))).toMatchObject([
					{ _tag: 'Some', value: expect.any(DaemonAlreadyRunning) }
				]);

				const rpc = yield* client(fx.home);
				expect(yield* rpc.handshake({ version: VERSION })).toMatchObject({ activeRuns: 0 });
				expect(existsSync(shipPaths(fx.home).pidFile)).toBe(true);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'reports runs waiting for a lock as waiting, and limits lists after deriving it',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const gate = join(fx.dir, 'gate');
				fx.configure(
					{ locks: { cpu: 1 } },
					{
						checks: [
							{ name: 'gated', run: `while [ ! -f '${gate}' ]; do sleep 0.05; done` }
						]
					}
				);
				yield* daemon(fx.home, yield* fakes);
				// Runs before the daemon stops, so the check holding the lock ends.
				yield* Effect.addFinalizer(() => Effect.sync(() => writeFileSync(gate, '')));
				const rpc = yield* client(fx.home);
				const runs = [yield* rpc.run(fx.request), yield* rpc.run(fx.request)].map(
					(run) => run.runId
				);
				const statuses = Effect.forEach(runs, (runId) =>
					Effect.map(rpc.status({ runId }), (info) => info.status)
				);
				yield* eventually(Effect.map(statuses, (all) => all.includes('waiting')));

				const [first, second] = runs as [RunId, RunId];
				const waiting =
					(yield* rpc.status({ runId: first })).status === 'waiting' ? first : second;
				const holder = waiting === first ? second : first;
				expect((yield* rpc.status({ runId: holder })).status).toBe('running');
				const ids = (filter: Parameters<typeof rpc.list>[0]) =>
					Effect.map(rpc.list(filter), (infos) => infos.map((info) => info.runId));
				expect(yield* ids({ status: ['waiting'] })).toEqual([waiting]);
				expect(yield* ids({ status: ['waiting'], limit: 1 })).toEqual([waiting]);
				expect(yield* ids({ status: ['running'], limit: 1 })).toEqual([holder]);
				expect([...(yield* ids({}))].sort()).toEqual([...runs].sort());
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'replaces a pid file no live process owns',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				const paths = shipPaths(fx.home);
				const dead = spawnSync('true').pid;
				// Empty, garbled, a gone process, and a live one that is not a daemon (a reused pid).
				for (const content of ['', 'garbage\n', `${dead}\n`, `${process.ppid}\n`]) {
					writeFileSync(paths.pidFile, content);
					yield* Effect.scoped(
						Effect.gen(function* () {
							yield* daemon(fx.home, services);
							const rpc = yield* client(fx.home);
							expect(yield* rpc.handshake({ version: VERSION })).toMatchObject({
								activeRuns: 0
							});
							expect(readFileSync(paths.pidFile, 'utf8')).toBe(`${process.pid}\n`);
						})
					);
					expect(existsSync(paths.pidFile)).toBe(false);
				}
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});
