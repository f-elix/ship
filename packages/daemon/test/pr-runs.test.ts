import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import {
	ChangeIntent,
	configParseOptions,
	Conventions,
	decodeProjectConfig,
	FindingId,
	FindingsSource,
	FIX_COMMIT_MESSAGE,
	GlobalConfig,
	initialFixRunState,
	initialRecheckRunState,
	Locks,
	Pr,
	ProjectKey,
	resolveConfig,
	resumeRun,
	Reviewers,
	ShipHome,
	startFix,
	startRecheck,
	type PushTarget,
	type RunEvent,
	type RunId,
	type VerifiedFinding
} from '@ship/core';
import {
	AgentFake,
	ChecksFake,
	ClefFake,
	exitCodesByCheck,
	fakeSha,
	GhFake,
	GitFake,
	type AgentScript,
	type GitFakeShape
} from '@ship/core/testing';
import { RunStore } from '@ship/store';
import { Deferred, Effect, Layer, Schema, type Scope } from 'effect';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { PATH: '/usr/bin:/bin' };
const projectKey = ProjectKey.make('github.com/f-elix/example');
const PR_URL = 'https://github.com/f-elix/example/pull/1';
const BASE = fakeSha(0xb);
/** The PR's head, checked out in the caller's checkout when the run starts. */
const HEAD = fakeSha(0xc);
const ORIGIN: PushTarget = { remote: 'origin', ref: 'feature' };

const tempDir = Effect.acquireRelease(
	Effect.promise(() => mkdtemp(join(tmpdir(), 'ship-pr-runs-'))),
	(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
);

const harness = (dir: string) =>
	Layer.mergeAll(
		Reviewers.layerWithBriefs(join(dir, 'briefs')),
		Conventions.layer,
		ChecksFake.layer,
		Pr.layer,
		ShipHome.layer(join(dir, 'home')),
		RunStore.journal,
		RunStore.reviews
	).pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				AgentFake.layer,
				ClefFake.layer,
				GhFake.layer,
				Locks.layer({ cpu: 2 }),
				// History starts at the PR's head: the run's own commits follow it.
				GitFake.layer({
					baseSha: HEAD,
					headSha: HEAD,
					changedFiles: [{ path: 'src/feature.ts', status: 'added' }]
				}),
				RunStore.layerFile(join(dir, 'ship.db'))
			)
		),
		Layer.provideMerge(NodeServices.layer)
	);

type Harness = Layer.Success<ReturnType<typeof harness>>;

const withHarness = <A, E>(body: Effect.Effect<A, E, Harness | Scope.Scope>) =>
	Effect.gen(function* () {
		const dir = yield* tempDir;
		mkdirSync(join(dir, 'briefs/reviewers'), { recursive: true });
		writeFileSync(join(dir, 'briefs/verifier.md'), 'You verify findings.\n');
		return yield* body.pipe(Effect.provide(harness(dir)));
	}).pipe(Effect.scoped);

const config = Effect.map(
	decodeProjectConfig({
		checks: [{ name: 'test', run: 'pnpm test' }],
		clef: false
	}),
	(project) =>
		resolveConfig(Schema.decodeUnknownSync(GlobalConfig, configParseOptions)({}), project)
).pipe(Effect.orDie);

const findingOf = (n: number, severity: 'must-fix' | 'nit' = 'must-fix'): VerifiedFinding => ({
	id: FindingId.make(`t${n}`),
	round: 1,
	reviewer: 'github:octocat',
	alsoReportedBy: [],
	file: 'src/feature.ts',
	line: n,
	severity,
	claim: `Problem ${n}.`,
	evidence: `${PR_URL}#discussion_r${n}`
});

const FINDINGS = [findingOf(1), findingOf(2, 'nit')];

const source = FindingsSource.cases.PrThreads.make({ pr: '1' });

const created = (kind: 'fix' | 'recheck', baseSha = HEAD) =>
	Effect.flatMap(RunStore, (store) =>
		store.createPrRun({
			kind,
			projectKey,
			repoDir: '/repo',
			prUrl: PR_URL,
			prNumber: 1,
			baseSha,
			headSha: HEAD,
			source,
			findings: FINDINGS,
			ignoredThreads: []
		})
	);

/** A fix run of PR 1's findings, pushing to `push` and running the checks unless told not to. */
const newFix = (
	options: { readonly push?: PushTarget | null; readonly runChecks?: boolean } = {}
) =>
	Effect.gen(function* () {
		const { runId } = yield* created('fix');
		return initialFixRunState({
			runId,
			projectKey,
			cwd: '/repo',
			env,
			config: yield* config,
			pr: { number: 1, url: PR_URL, headSha: HEAD },
			findings: FINDINGS,
			push: options.push === undefined ? ORIGIN : options.push,
			runChecks: options.runChecks ?? true
		});
	});

/** A recheck run of PR 1's findings, with `threads` open on GitHub by finding id. */
const newRecheck = (threads: Readonly<Record<string, string>>, resolve = true) =>
	Effect.gen(function* () {
		const { runId } = yield* created('recheck', BASE);
		return initialRecheckRunState({
			runId,
			projectKey,
			cwd: '/repo',
			env,
			config: yield* config,
			baseSha: BASE,
			pr: { number: 1, url: PR_URL, headSha: HEAD },
			intent: ChangeIntent.cases.Description.make({ title: 'Add the feature', body: '' }),
			findings: FINDINGS,
			threads,
			resolve
		});
	});

/** A fix call that edits `src/feature.ts`, as a real agent would. */
const edits =
	(git: GitFakeShape, costUsd = 0.5): AgentScript =>
	() =>
		Effect.as(git.edit([{ path: 'src/feature.ts', status: 'modified' }]), { costUsd });

/** Blocks forever once called, after signalling `started`. */
const hangs =
	(started: Deferred.Deferred<void>): AgentScript =>
	() =>
		Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));

/** A verifier answer: the status of each finding by id. */
const verifierSays = (statuses: Readonly<Record<string, 'fixed' | 'unfixed'>>) => ({
	output: {
		verdicts: [],
		previous: Object.entries(statuses).map(([id, status]) => ({
			id,
			status,
			evidence: `${id} is ${status}`
		}))
	},
	costUsd: 0.2
});

const eventsOf = (runId: RunId) =>
	Effect.map(
		Effect.flatMap(RunStore, (store) => store.events(runId)),
		(envelopes) => envelopes.map((envelope) => envelope.event)
	);

const transitions = (events: ReadonlyArray<RunEvent | { readonly _tag: 'UnknownEvent' }>) =>
	events.flatMap((event) => (event._tag === 'StateChanged' ? [event.to] : []));

const tagsOf = (events: ReadonlyArray<{ readonly _tag: string }>) =>
	events.map((event) => event._tag);

/** Runs `start` until `reached` completes, then stops it as a daemon shutdown would. */
const interruptAfter = <E, R>(
	start: Effect.Effect<unknown, E, R>,
	runId: RunId,
	reached: Deferred.Deferred<void>
) =>
	Effect.gen(function* () {
		const store = yield* RunStore;
		yield* Effect.scoped(Effect.andThen(start, Deferred.await(reached)));
		expect(yield* store.markInterrupted).toEqual([runId]);
	});

/** Opens a thread on PR 1 and returns its id. */
const openThread = (line: number) =>
	Effect.map(
		Effect.flatMap(GhFake, (gh) =>
			gh.addThread({
				prUrl: PR_URL,
				path: 'src/feature.ts',
				line,
				author: 'octocat',
				body: `Problem ${line}.`
			})
		),
		(thread) => thread.id
	);

describe('fix run', () => {
	it.effect('fixes the findings, runs the checks, commits and pushes to the PR branch', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const checks = yield* ChecksFake;
				yield* agent.script({ step: 'fix' }, edits(git));
				const state = yield* newFix();

				const summary = yield* Effect.flatMap(startFix(state), (handle) => handle.await);

				const repo = yield* git.state;
				expect(repo.commits.map((commit) => commit.message)).toEqual([FIX_COMMIT_MESSAGE]);
				expect(repo.headPushes).toEqual([{ ...ORIGIN, sha: repo.headSha }]);
				expect(summary).toMatchObject({
					kind: 'fix',
					status: 'done',
					prUrl: PR_URL,
					findings: FINDINGS,
					commits: [repo.headSha],
					pushed: true,
					costUsd: 0.5,
					error: null
				});
				if (summary.kind !== 'fix') throw new Error('Expected a fix summary');
				expect(summary.checks).toHaveLength(1);
				expect((yield* checks.calls).map((call) => call.check)).toContain('test');
				const [fix] = yield* agent.calls;
				expect(fix?.prompt).toContain('Problem 1.');
				expect(fix?.prompt).toContain('Problem 2.');
				expect(transitions(yield* eventsOf(state.runId))).toEqual([
					'checks.running',
					'push',
					'done'
				]);
			})
		)
	);

	it.effect('keeps the commits local with --local', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				yield* agent.script({ step: 'fix' }, edits(git));
				const state = yield* newFix({ push: null });

				const summary = yield* Effect.flatMap(startFix(state), (handle) => handle.await);

				const repo = yield* git.state;
				expect(repo.commits).toHaveLength(1);
				expect(repo.headPushes).toEqual([]);
				expect(summary).toMatchObject({ status: 'done', pushed: false });
				expect(transitions(yield* eventsOf(state.runId))).toEqual([
					'checks.running',
					'done'
				]);
			})
		)
	);

	it.effect('commits without running the checks with --no-checks', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const checks = yield* ChecksFake;
				yield* agent.script({ step: 'fix' }, edits(git));
				const state = yield* newFix({ runChecks: false });

				const summary = yield* Effect.flatMap(startFix(state), (handle) => handle.await);

				expect(yield* checks.calls).toEqual([]);
				expect(summary).toMatchObject({ status: 'done', pushed: true, checks: [] });
				expect((yield* git.state).commits.map((commit) => commit.message)).toEqual([
					FIX_COMMIT_MESSAGE
				]);
				expect(transitions(yield* eventsOf(state.runId))).toEqual([
					'commit',
					'push',
					'done'
				]);
			})
		)
	);

	it.effect('fails without committing or pushing when the checks still fail', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const checks = yield* ChecksFake;
				yield* checks.respond(yield* exitCodesByCheck({ test: [1, 1, 1, 1] }));
				yield* agent.script({ step: 'fix' }, edits(git));
				yield* agent.script(
					{ step: 'fixChecks' },
					edits(git, 0.1),
					edits(git, 0.1),
					edits(git, 0.1)
				);
				const state = yield* newFix();

				const summary = yield* Effect.flatMap(startFix(state), (handle) => handle.await);

				expect(summary.status).toBe('failed');
				expect(summary.error).toContain('Checks still fail after the check fixes: test');
				const repo = yield* git.state;
				expect(repo.commits).toEqual([]);
				expect(repo.headPushes).toEqual([]);
				// The check fixes resumed the fix agent's session.
				const calls = yield* agent.calls;
				expect(
					calls
						.filter((call) => call.step === 'fixChecks')
						.map((call) => call.resume?.sessionId)
				).toEqual(['fake-session-1', 'fake-session-1', 'fake-session-1']);
			})
		)
	);

	it.effect('fails when HEAD left the PR head before the push, pushing nothing', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				// The caller checks out unrelated work while the fix agent runs.
				yield* agent.script({ step: 'fix' }, () =>
					Effect.as(
						git.update((repo) => ({ ...repo, headSha: fakeSha(0xe) })),
						{ costUsd: 0.5 }
					)
				);
				const state = yield* newFix({ runChecks: false });

				const summary = yield* Effect.flatMap(startFix(state), (handle) => handle.await);

				expect(summary.status).toBe('failed');
				expect(summary.error).toContain(`does not descend from the PR's head ${HEAD}`);
				expect((yield* git.state).headPushes).toEqual([]);
			})
		)
	);

	it.effect('resumes after a crash right after the push without fixing or committing again', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const pushed = yield* Deferred.make<void>();
				yield* agent.script({ step: 'fix' }, edits(git));
				// The remote takes the push, then the daemon stops before ship records it.
				yield* git.afterPushHead(
					Deferred.succeed(pushed, undefined).pipe(Effect.andThen(Effect.never))
				);
				const state = yield* newFix({ runChecks: false });
				yield* interruptAfter(startFix(state), state.runId, pushed);
				yield* git.afterPushHead(Effect.void);

				const summary = yield* Effect.flatMap(
					resumeRun(state.runId, env),
					(handle) => handle.await
				);

				const repo = yield* git.state;
				expect(summary).toMatchObject({ kind: 'fix', status: 'done', pushed: true });
				expect(repo.commits).toHaveLength(1);
				// Pushing the same commit again is a no-op for git.
				expect(repo.headPushes.map((push) => push.sha)).toEqual([
					repo.headSha,
					repo.headSha
				]);
				expect((yield* agent.calls).map((call) => call.step)).toEqual(['fix']);
				expect(
					tagsOf(yield* eventsOf(state.runId)).filter((tag) => tag === 'CommitCreated')
				).toHaveLength(1);
			})
		)
	);

	it.effect('resumes mid-fix and finishes the run', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const started = yield* Deferred.make<void>();
				yield* agent.script({ step: 'fix' }, hangs(started), edits(git));
				const state = yield* newFix();
				yield* interruptAfter(startFix(state), state.runId, started);

				const summary = yield* Effect.flatMap(
					resumeRun(state.runId, env),
					(handle) => handle.await
				);

				expect(summary).toMatchObject({ kind: 'fix', status: 'done', pushed: true });
				expect((yield* git.state).headPushes).toHaveLength(1);
			})
		)
	);
});

describe('recheck run', () => {
	it.effect('rechecks every finding and resolves the threads of the fixed ones', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const first = yield* openThread(1);
				const second = yield* openThread(2);
				yield* agent.script(
					{ step: 'verify' },
					verifierSays({ t1: 'fixed', t2: 'unfixed' })
				);
				const state = yield* newRecheck({ t1: first, t2: second });

				const summary = yield* Effect.flatMap(
					startRecheck(state),
					(handle) => handle.await
				);

				expect(summary).toMatchObject({
					kind: 'recheck',
					status: 'done',
					prUrl: PR_URL,
					resolvedThreads: [first],
					costUsd: 0.2,
					error: null
				});
				if (summary.kind !== 'recheck') throw new Error('Expected a recheck summary');
				expect(
					summary.findings.map(({ finding, status, evidence }) => [
						finding.id,
						status,
						evidence
					])
				).toEqual([
					['t1', 'fixed', 't1 is fixed'],
					['t2', 'unfixed', 't2 is unfixed']
				]);
				expect((yield* gh.threads).map((thread) => [thread.id, thread.resolved])).toEqual([
					[first, true],
					[second, false]
				]);
				expect(transitions(yield* eventsOf(state.runId))).toEqual(['resolve', 'done']);
			})
		)
	);

	it.effect('resolves nothing with --local', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const first = yield* openThread(1);
				yield* agent.script({ step: 'verify' }, verifierSays({ t1: 'fixed', t2: 'fixed' }));
				const state = yield* newRecheck({ t1: first }, false);

				const summary = yield* Effect.flatMap(
					startRecheck(state),
					(handle) => handle.await
				);

				expect(summary).toMatchObject({ status: 'done', resolvedThreads: [] });
				expect(yield* gh.resolveCalls).toEqual([]);
				expect(transitions(yield* eventsOf(state.runId))).toEqual(['done']);
			})
		)
	);

	it.effect('fails when resolving a thread fails, keeping the statuses', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const first = yield* openThread(1);
				yield* gh.fail('resolveThread', 'HTTP 403: Resource not accessible');
				yield* agent.script({ step: 'verify' }, verifierSays({ t1: 'fixed', t2: 'fixed' }));
				const state = yield* newRecheck({ t1: first });

				const summary = yield* Effect.flatMap(
					startRecheck(state),
					(handle) => handle.await
				);

				expect(summary.status).toBe('failed');
				expect(summary.error).toContain('HTTP 403');
				if (summary.kind !== 'recheck') throw new Error('Expected a recheck summary');
				expect(summary.findings.map((finding) => finding.status)).toEqual([
					'fixed',
					'fixed'
				]);
			})
		)
	);

	it.effect('resumes mid-resolve without resolving a resolved thread again', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const first = yield* openThread(1);
				const second = yield* openThread(2);
				const resolved = yield* Deferred.make<void>();
				yield* agent.script({ step: 'verify' }, verifierSays({ t1: 'fixed', t2: 'fixed' }));
				const state = yield* newRecheck({ t1: first, t2: second });
				// The first thread is resolved and recorded; the daemon stops during the second.
				let calls = 0;
				yield* gh.afterResolve(
					Effect.suspend(() => {
						calls += 1;
						return calls === 2
							? Deferred.succeed(resolved, undefined).pipe(
									Effect.andThen(Effect.never)
								)
							: Effect.void;
					})
				);
				yield* interruptAfter(startRecheck(state), state.runId, resolved);
				yield* gh.afterResolve(Effect.void);

				const summary = yield* Effect.flatMap(
					resumeRun(state.runId, env),
					(handle) => handle.await
				);

				expect(summary).toMatchObject({
					kind: 'recheck',
					status: 'done',
					resolvedThreads: [first, second]
				});
				// The verifier is not asked again, and only the interrupted thread is resolved again.
				expect((yield* agent.calls).map((call) => call.step)).toEqual(['verify']);
				expect(yield* gh.resolveCalls).toEqual([first, second, second]);
			})
		)
	);

	it.effect('refuses to resolve when HEAD moved since the run started', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const git = yield* GitFake;
				const first = yield* openThread(1);
				yield* agent.script({ step: 'verify' }, () =>
					Effect.as(
						git.update((repo) => ({ ...repo, headSha: fakeSha(0xd) })),
						{
							...verifierSays({ t1: 'fixed', t2: 'fixed' })
						}
					)
				);
				const state = yield* newRecheck({ t1: first });

				const summary = yield* Effect.flatMap(
					startRecheck(state),
					(handle) => handle.await
				);

				expect(summary.status).toBe('failed');
				expect(summary.error).toContain(`HEAD moved from the PR's head ${HEAD}`);
				expect(yield* gh.resolveCalls).toEqual([]);
			})
		)
	);
});
