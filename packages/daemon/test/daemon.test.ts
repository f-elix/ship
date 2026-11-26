import { describe, expect, it } from '@effect/vitest';
import {
	DaemonBusy,
	FindingsSource,
	GitSha,
	PreconditionFailed,
	ReviewId,
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
	cloneOfExample,
	daemon,
	eventually,
	fakes,
	fixture,
	reachState,
	scriptHappyRun,
	VERSION,
	type Fixture
} from '../src/testing.ts';

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
				yield* scriptHappyRun(services);
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
				const started = yield* Deferred.make<void>();
				const proceed = yield* Deferred.make<void>();
				yield* scriptHappyRun(services, gatedImplement(started, proceed));
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
		'ends an open watch when it shuts down, on a stop request or otherwise',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				for (const stopRequest of [true, false]) {
					const scope = yield* Scope.make();
					const running = yield* daemon(fx.home, services).pipe(Scope.provide(scope));
					const rpc = yield* client(fx.home);
					yield* rpc.run(fx.request);
					const opened = yield* Deferred.make<void>();
					const watch = yield* rpc.watch({}).pipe(
						Stream.runForEach(() => Deferred.succeed(opened, undefined)),
						Effect.exit,
						Effect.forkScoped
					);
					yield* Deferred.await(opened);

					if (stopRequest) {
						yield* rpc.stop({ force: true });
						yield* running.stopRequested;
					}
					// An open watch would hold the close for the server's 2 second graceful timeout.
					yield* Scope.close(scope, Exit.void).pipe(Effect.timeout('1 second'));
					expect(Exit.isSuccess(yield* Fiber.join(watch))).toBe(true);
				}
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
				const watched = yield* rpc.watch({}).pipe(Stream.take(2), Stream.runCollect);
				expect(watched.find((info) => info.runId === waiting)?.status).toBe('waiting');
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

	it.live(
		'runs the project checks once over RPC, holding locks, with typed errors',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				yield* daemon(fx.home, yield* fakes);
				const rpc = yield* client(fx.home);
				const repo = { cwd: fx.work, env: fx.env };

				const events = yield* rpc.runChecks(repo).pipe(Stream.runCollect);
				expect(Array.from(events, (event) => event._tag)).toEqual([
					'LockAcquired',
					'CheckStarted',
					'CheckFinished',
					'LockReleased'
				]);
				expect(Array.from(events).at(2)).toMatchObject({
					check: 'caller-env',
					baseline: true,
					exitCode: 0
				});

				const notRepo = yield* Effect.flip(
					rpc.runChecks({ cwd: fx.dir, env: fx.env }).pipe(Stream.runDrain)
				);
				expect(notRepo).toMatchObject({
					_tag: 'PreconditionFailed',
					reason: 'not-a-git-repo'
				});

				fx.configure({ locks: { cpu: 2 } }, { checks: 'none' });
				const invalid = yield* Effect.flip(rpc.runChecks(repo).pipe(Stream.runDrain));
				expect(invalid).toMatchObject({
					_tag: 'PreconditionFailed',
					reason: 'invalid-config'
				});

				fx.configure(
					{ locks: { cpu: 2 } },
					{
						checks: [{ name: 'slow', run: 'sleep 10' }],
						timeouts: { baseline: '1 second' }
					}
				);
				const timedOut = yield* Effect.flip(rpc.runChecks(repo).pipe(Stream.runDrain));
				expect(timedOut).toMatchObject({ _tag: 'ChecksAborted', check: 'slow' });
				expect(timedOut.message).toContain('timed out');
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'refuses a plain stop while a check pass runs, until it ends or its client disconnects',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const gate = join(fx.dir, 'gate');
				fx.configure(
					{ locks: { cpu: 2 } },
					{
						checks: [
							{ name: 'gated', run: `while [ ! -f '${gate}' ]; do sleep 0.05; done` }
						]
					}
				);
				const running = yield* daemon(fx.home, yield* fakes);
				const rpc = yield* client(fx.home);
				const repo = { cwd: fx.work, env: fx.env };
				/** Starts a pass from its own client; resolves once its check has started. */
				const startPass = Effect.gen(function* () {
					const scope = yield* Scope.make();
					const own = yield* client(fx.home).pipe(Scope.provide(scope));
					const started = yield* Deferred.make<void>();
					const fiber = yield* own.runChecks(repo).pipe(
						Stream.tap((event) =>
							event._tag === 'CheckStarted'
								? Deferred.succeed(started, undefined)
								: Effect.void
						),
						Stream.runCollect,
						Effect.forkChild
					);
					yield* Deferred.await(started);
					return { scope, fiber };
				});
				const stopped = rpc.stop({}).pipe(
					Effect.as(true),
					Effect.catchTag('DaemonBusy', () => Effect.succeed(false))
				);

				// A pass that ends: refused while it runs, the count released when it ends.
				const first = yield* startPass;
				const busy = yield* Effect.flip(rpc.stop({}));
				expect(busy).toBeInstanceOf(DaemonBusy);
				expect(busy).toMatchObject({ activeRuns: 0, activeCheckPasses: 1 });
				// The handshake still reports runs only.
				expect(yield* rpc.handshake({ version: VERSION })).toEqual({
					version: VERSION,
					activeRuns: 0
				});
				writeFileSync(gate, '');
				const events = yield* Fiber.join(first.fiber);
				expect(Array.from(events).at(-1)).toMatchObject({ _tag: 'LockReleased' });
				unlinkSync(gate);

				// A pass whose client disconnects mid-pass releases the count too.
				const second = yield* startPass;
				expect(yield* Effect.flip(rpc.stop({}))).toMatchObject({ activeCheckPasses: 1 });
				yield* Fiber.interrupt(second.fiber);
				yield* Scope.close(second.scope, Exit.void);
				yield* eventually(stopped);
				yield* running.stopRequested;
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'stops at once with force while a check pass runs',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				fx.configure(
					{ locks: { cpu: 2 } },
					{ checks: [{ name: 'slow', run: 'sleep 30' }] }
				);
				const scope = yield* Scope.make();
				const running = yield* daemon(fx.home, yield* fakes).pipe(Scope.provide(scope));
				const rpc = yield* client(fx.home);
				const started = yield* Deferred.make<void>();
				const pass = yield* rpc.runChecks({ cwd: fx.work, env: fx.env }).pipe(
					Stream.tap((event) =>
						event._tag === 'CheckStarted'
							? Deferred.succeed(started, undefined)
							: Effect.void
					),
					Stream.runDrain,
					Effect.exit,
					Effect.forkChild
				);
				yield* Deferred.await(started);

				yield* rpc.stop({ force: true });
				yield* running.stopRequested;
				yield* Scope.close(scope, Exit.void);
				// The pass was interrupted: its stream did not complete.
				expect(Exit.isSuccess(yield* Fiber.join(pass))).toBe(false);
				expect(existsSync(running.paths.socket)).toBe(false);
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});

/** The reason `review` fails with for `pr`. */
const reviewPreconditionOf = (
	rpc: Effect.Success<ReturnType<typeof client>>,
	fx: Fixture,
	pr: string
) =>
	rpc.review({ pr, post: true, cwd: fx.work, env: fx.env }).pipe(
		Effect.flip,
		Effect.map((error) => (error instanceof PreconditionFailed ? error.reason : error._tag))
	);

describe('ship review', () => {
	it.live(
		'refuses a PR of another repository before creating a run',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				yield* Context.get(services, GhFake).addPr({
					base: 'main',
					head: 'feature',
					title: 'Add the feature',
					body: '',
					draft: false
				});
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);

				// The fake's PRs belong to github.com/f-elix/example, not to this repo's origin.
				expect(yield* reviewPreconditionOf(rpc, fx, '1')).toBe('pr-other-repo');
				expect(
					yield* reviewPreconditionOf(rpc, fx, 'https://github.com/f-elix/example/pull/1')
				).toBe('pr-other-repo');
				expect(yield* reviewPreconditionOf(rpc, fx, '2')).toBe('pr-not-found');
				expect(
					yield* reviewPreconditionOf(rpc, fx, 'https://github.com/someone/else/pull/1')
				).toBe('pr-not-found');
				expect(yield* rpc.list({})).toEqual([]);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		"refuses a PR that is not checked out cleanly in the caller's checkout",
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				const { head, env } = cloneOfExample(fx);
				yield* Context.get(services, GhFake).addPr({
					base: 'main',
					head: 'feature',
					title: 'Add the feature',
					body: '',
					draft: false,
					headSha: head
				});
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);
				const reasonFor = () =>
					rpc.review({ pr: '1', post: false, cwd: fx.work, env }).pipe(
						Effect.flip,
						Effect.map((error) =>
							error instanceof PreconditionFailed ? error : error._tag
						)
					);

				fx.write('src/feature.ts', 'export const feature = 2;\n');
				expect(yield* reasonFor()).toMatchObject({
					reason: 'dirty-tree',
					detail: expect.stringContaining('`gh pr checkout 1`')
				});
				fx.git('commit', '--quiet', '-am', 'Not pushed');
				expect(yield* reasonFor()).toMatchObject({
					reason: 'pr-not-checked-out',
					detail: expect.stringContaining('`gh pr checkout 1`')
				});
				expect(yield* rpc.list({})).toEqual([]);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'refuses a PR whose base branch cannot be fetched, keeping the git error as the cause',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				const { head, env } = cloneOfExample(fx);
				// The PR exists and is checked out, but origin has no branch named like its base.
				yield* Context.get(services, GhFake).addPr({
					base: 'gone',
					head: 'feature',
					title: 'Add the feature',
					body: '',
					draft: false,
					headSha: head
				});
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);

				const error = yield* Effect.flip(
					rpc.review({ pr: '1', post: false, cwd: fx.work, env })
				);

				expect(error).toBeInstanceOf(PreconditionFailed);
				expect(error).toMatchObject({
					reason: 'base-fetch-failed',
					detail: expect.stringContaining('base branch gone')
				});
				const cause = error instanceof PreconditionFailed ? error.cause : undefined;
				expect(cause).toBeInstanceOf(Error);
				expect(cause).toMatchObject({
					message: expect.stringContaining('refs/heads/gone')
				});
				expect(yield* rpc.list({})).toEqual([]);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		"reviews a PR in the caller's checkout, posts the findings and stores the review",
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				const { head, env } = cloneOfExample(fx);
				const gh = Context.get(services, GhFake);
				yield* gh.addPr({
					base: 'main',
					head: 'feature',
					title: 'Add the feature',
					body: 'Adds src/feature.ts.',
					draft: false,
					headSha: head
				});
				const agent = Context.get(services, AgentFake);
				const reviewedIn: Array<string> = [];
				yield* agent.script({ step: 'review', label: 'standards' }, (input) =>
					Effect.sync(() => {
						reviewedIn.push(input.cwd);
						return {
							output: {
								findings: [
									{
										file: 'src/feature.ts',
										line: 1,
										severity: 'must-fix',
										claim: 'The feature is unused',
										evidence: 'export const feature = 1;'
									}
								]
							},
							costUsd: 0.1
						};
					})
				);
				yield* agent.script(
					{ step: 'verify' },
					{
						output: {
							verdicts: [{ index: 0, verdict: 'confirmed', reason: 'Seen' }],
							previous: []
						},
						costUsd: 0.2
					}
				);
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);

				// A URL copied from the PR's files tab names the PR too.
				const { runId } = yield* rpc.review({
					pr: 'https://github.com/f-elix/example/pull/1/files#diff-1',
					post: true,
					cwd: fx.work,
					env
				});
				const events = yield* allEvents(rpc, runId);

				expect(events[0]).toBe('ReviewRunCreated');
				expect(events).toContain('ReviewStored');
				expect(events).toContain('PrReviewPosted');
				expect(events.at(-1)).toBe('RunFinished');
				// ship reviews where it was called and leaves no worktree behind.
				expect(reviewedIn).toEqual([fx.work]);
				expect(
					fx.git('worktree', 'list', '--porcelain').match(/^worktree /gmu)
				).toHaveLength(1);
				const reviews = yield* gh.reviews;
				expect(reviews).toMatchObject([
					{
						commitId: head,
						event: 'REQUEST_CHANGES',
						comments: [{ path: 'src/feature.ts', line: 1 }]
					}
				]);
				const info = yield* rpc.status({ runId });
				expect(info).toMatchObject({
					kind: 'review',
					status: 'done',
					prUrl: 'https://github.com/f-elix/example/pull/1',
					reviewUrl: reviews[0]?.url
				});
				expect(info.summary).toMatchObject({
					kind: 'review',
					reviewId: `${runId}-r1`,
					mustFix: [{ line: 1 }]
				});
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'cancels an interrupted review run from a later daemon',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				const { head, env } = cloneOfExample(fx);
				yield* Context.get(services, GhFake).addPr({
					base: 'main',
					head: 'feature',
					title: 'Add the feature',
					body: '',
					draft: false,
					headSha: head
				});
				yield* Context.get(services, AgentFake).script(
					{ step: 'review', label: 'standards' },
					() => Effect.never
				);
				const runId = yield* Effect.scoped(
					Effect.gen(function* () {
						yield* daemon(fx.home, services);
						const before = yield* client(fx.home);
						const { runId } = yield* before.review({
							pr: '1',
							post: false,
							cwd: fx.work,
							env
						});
						yield* reachState(before, runId, 'review');
						return runId;
					})
				);

				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);
				expect((yield* rpc.status({ runId })).status).toBe('interrupted');
				yield* rpc.cancel({ runId });

				expect((yield* rpc.status({ runId })).status).toBe('cancelled');
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});

/** PR 1 of the fake, at `head`; `fork` makes it come from a fork. */
const addPr = (
	services: Effect.Success<typeof fakes>,
	head: string,
	fork: { readonly maintainerCanModify: boolean } | null = null
) =>
	Context.get(services, GhFake).addPr({
		base: 'main',
		head: 'feature',
		title: 'Add the feature',
		body: 'Adds src/feature.ts.',
		draft: false,
		headSha: GitSha.make(head),
		...(fork === null
			? {}
			: {
					isCrossRepository: true,
					maintainerCanModify: fork.maintainerCanModify,
					headRepository: { owner: 'someone', name: 'example' }
				})
	});

/** A review thread on PR 1's `src/feature.ts`, as a reviewer on GitHub would open it. */
const addThread = (services: Effect.Success<typeof fakes>, body: string, authorCanWrite = true) =>
	Context.get(services, GhFake).addThread({
		prUrl: 'https://github.com/f-elix/example/pull/1',
		path: 'src/feature.ts',
		line: 1,
		author: 'octocat',
		authorCanWrite,
		body
	});

/** The reason a `fix` or `recheck` request fails with, or the error's tag. */
const reasonOf = <E extends { readonly _tag: string }>(request: Effect.Effect<unknown, E>) =>
	request.pipe(
		Effect.flip,
		Effect.map((error) => (error instanceof PreconditionFailed ? error.reason : error._tag))
	);

/**
 * `cloneOfExample`'s env, with ssh to GitHub also taking pushes into the fixture's bare
 * repo. Git runs the command with the host and the remote command as its last arguments.
 */
const pushableEnv = (fx: Fixture, env: Record<string, string>) => {
	const origin = join(fx.dir, 'origin.git');
	return {
		...env,
		GIT_SSH_VARIANT: 'simple',
		GIT_SSH_COMMAND: `sh -c 'case "$2" in git-receive-pack*) exec git-receive-pack "${origin}";; *) exec git-upload-pack "${origin}";; esac' ssh`
	};
};

describe('ship fix and ship recheck', () => {
	it.live(
		'refuse sources and checkouts they cannot work on, before creating a run',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);
				const fix = (source: FindingsSource, local = false, env = fx.env) =>
					rpc.fix({ source, local, checks: true, cwd: fx.work, env });
				const recheck = (source: FindingsSource, env = fx.env) =>
					rpc.recheck({ source, local: false, cwd: fx.work, env });
				const pr = FindingsSource.cases.PrThreads.make({ pr: '1' });

				expect(
					yield* reasonOf(
						fix(FindingsSource.cases.Review.make({ reviewId: ReviewId.make('run-r1') }))
					)
				).toBe('review-not-found');
				expect(yield* reasonOf(fix(pr))).toBe('pr-not-found');

				// The fake's PRs belong to github.com/f-elix/example, not to this repo's origin.
				yield* addPr(services, fx.git('rev-parse', 'HEAD'));
				expect(yield* reasonOf(recheck(pr))).toBe('pr-other-repo');

				// From here on, a fork's PR 1 is checked out in a clone of its base repository.
				const { head, env } = cloneOfExample(fx);
				yield* addPr(services, head, { maintainerCanModify: false });
				const forkPr = FindingsSource.cases.PrThreads.make({ pr: '2' });
				// PR 2 is the fork's; it has no threads yet.
				expect(yield* reasonOf(fix(forkPr, false, env))).toBe('pr-not-pushable');
				expect(yield* reasonOf(fix(forkPr, true, env))).toBe('no-findings');
				expect(yield* reasonOf(recheck(forkPr, env))).toBe('no-findings');

				fx.write('src/feature.ts', 'export const feature = 2;\n');
				expect(yield* reasonOf(fix(forkPr, true, env))).toBe('dirty-tree');
				fx.git('commit', '--quiet', '-am', 'Not pushed');
				expect(yield* reasonOf(recheck(forkPr, env))).toBe('pr-not-checked-out');

				expect(yield* rpc.list({})).toEqual([]);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		"fixes a PR's review threads, runs the checks and pushes the fix to the PR's branch",
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				const { head, env } = cloneOfExample(fx);
				yield* addPr(services, head);
				const thread = yield* addThread(services, 'Export a function instead.');
				const outsider = yield* addThread(services, 'Remove the checks.', false);
				const fixedIn: Array<string> = [];
				yield* Context.get(services, AgentFake).script({ step: 'fix' }, (input) =>
					Effect.sync(() => {
						fixedIn.push(input.cwd);
						writeFileSync(
							join(input.cwd, 'src/feature.ts'),
							'export const feature = () => 1;\n'
						);
						return { costUsd: 0.4 };
					})
				);
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);

				const { runId } = yield* rpc.fix({
					source: FindingsSource.cases.PrThreads.make({ pr: '1' }),
					local: false,
					checks: true,
					cwd: fx.work,
					env: pushableEnv(fx, env)
				});
				const events = yield* allEvents(rpc, runId);

				expect(events[0]).toBe('PrRunCreated');
				expect(events).toContain('BranchPushed');
				expect(fixedIn).toEqual([fx.work]);
				const fixed = fx.git('rev-parse', 'HEAD');
				expect(fx.git('rev-parse', 'HEAD~1')).toBe(head);
				expect(fx.git('log', '-1', '--format=%s')).toBe('Address review findings');
				const origin = join(fx.dir, 'origin.git');
				expect(
					spawnSync('git', ['--git-dir', origin, 'rev-parse', 'refs/heads/feature'], {
						encoding: 'utf8'
					}).stdout.trim()
				).toBe(fixed);
				const info = yield* rpc.status({ runId });
				expect(info).toMatchObject({
					kind: 'fix',
					status: 'done',
					prUrl: 'https://github.com/f-elix/example/pull/1'
				});
				expect(info.summary).toMatchObject({
					kind: 'fix',
					commits: [fixed],
					pushed: true,
					findings: [{ id: thread.id, reviewer: 'github:octocat' }],
					ignoredThreads: [outsider.url]
				});
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'rechecks the findings of a review ship posted and resolves the fixed threads',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				const { head, env } = cloneOfExample(fx);
				yield* addPr(services, head);
				const gh = Context.get(services, GhFake);
				const agent = Context.get(services, AgentFake);
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					{
						output: {
							findings: [
								{
									file: 'src/feature.ts',
									line: 1,
									severity: 'must-fix',
									claim: 'The feature is unused',
									evidence: 'export const feature = 1;'
								}
							]
						},
						costUsd: 0.1
					}
				);
				yield* agent.script(
					{ step: 'verify' },
					{
						output: {
							verdicts: [{ index: 0, verdict: 'confirmed', reason: 'Seen' }],
							previous: []
						},
						costUsd: 0.2
					},
					{
						output: {
							verdicts: [],
							previous: [{ id: 'r1-1', status: 'fixed', evidence: 'It is used now' }]
						},
						costUsd: 0.2
					}
				);
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);
				const review = yield* rpc.review({ pr: '1', post: true, cwd: fx.work, env });
				yield* allEvents(rpc, review.runId);

				const { runId } = yield* rpc.recheck({
					source: FindingsSource.cases.Review.make({
						reviewId: ReviewId.make(`${review.runId}-r1`)
					}),
					local: false,
					cwd: fx.work,
					env
				});
				const events = yield* allEvents(rpc, runId);

				expect(events).toContain('FindingsRechecked');
				expect(events).toContain('ThreadResolved');
				const threads = yield* gh.threads;
				expect(threads.map((thread) => thread.resolved)).toEqual([true]);
				const info = yield* rpc.status({ runId });
				expect(info).toMatchObject({ kind: 'recheck', status: 'done' });
				expect(info.summary).toMatchObject({
					kind: 'recheck',
					findings: [{ finding: { id: 'r1-1' }, status: 'fixed' }],
					resolvedThreads: [threads[0]?.id]
				});
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});

describe('ship implement, ship checks, ship pr and ship post', () => {
	it.live(
		'refuse checkouts they cannot work on, before creating a run',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				yield* daemon(fx.home, yield* fakes);
				const rpc = yield* client(fx.home);
				const { cwd, env } = fx.request;

				expect(
					yield* reasonOf(
						rpc.implement({ planDir: join(fx.dir, 'no-plan'), checks: true, cwd, env })
					)
				).toBe('missing-plan-files');
				// The untracked plan dir makes the tree dirty for a command not given it.
				expect(yield* reasonOf(rpc.checks({ cwd, env }))).toBe('dirty-tree');
				expect(
					yield* reasonOf(rpc.post({ review: ReviewId.make('run-r1'), cwd, env }))
				).toBe('review-not-found');
				expect(yield* rpc.list({})).toEqual([]);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'implements a plan and commits it, then runs the checks on the branch',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				yield* Context.get(services, AgentFake).script({ step: 'implement' }, addsFeature);
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);
				const { cwd, env } = fx.request;

				const implement = yield* rpc.implement({ ...fx.request, checks: true });
				const events = yield* allEvents(rpc, implement.runId);

				expect(events[0]).toBe('PrimitiveRunCreated');
				expect(fx.git('log', '-1', '--format=%s')).toBe('Implement feature');
				const commit = fx.git('rev-parse', 'HEAD');
				const info = yield* rpc.status({ runId: implement.runId });
				expect(info).toMatchObject({
					kind: 'implement',
					status: 'done',
					planDir: fx.planDir,
					branch: 'feature'
				});
				expect(info.summary).toMatchObject({ kind: 'implement', commits: [commit] });

				unlinkSync(join(fx.planDir, 'spec.md'));
				unlinkSync(join(fx.planDir, 'implementation-plan.md'));
				const checks = yield* rpc.checks({ cwd, env });
				yield* allEvents(rpc, checks.runId);

				// The checks pass, so there is nothing to commit.
				expect(fx.git('rev-parse', 'HEAD')).toBe(commit);
				expect((yield* rpc.status({ runId: checks.runId })).summary).toMatchObject({
					kind: 'checks',
					status: 'done',
					commits: []
				});
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});
