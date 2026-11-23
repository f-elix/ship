import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import {
	ChangeIntent,
	CHECKS_COMMIT_MESSAGE,
	configParseOptions,
	Conventions,
	decodeProjectConfig,
	FindingId,
	Git,
	GlobalConfig,
	initialPrimitiveRunState,
	Locks,
	Pr,
	ProjectKey,
	resolveConfig,
	resumeRun,
	Reviewers,
	ReviewId,
	Reviews,
	ShipHome,
	startPrimitiveRun,
	type NewPrimitiveRunState,
	type PrimitiveSummary,
	type RunEvent,
	type RunId,
	type Summary
} from '@ship/core';
import {
	AgentFake,
	ChecksFake,
	ClefFake,
	exitCodesByCheck,
	GhFake,
	GitFake,
	opensPr,
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
const PLAN_DIR = '/plans/feature';
const PR_URL = 'https://github.com/f-elix/example/pull/1';
const SUBJECT = 'Add the feature module';

const tempDir = Effect.acquireRelease(
	Effect.promise(() => mkdtemp(join(tmpdir(), 'ship-primitive-runs-'))),
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
				GitFake.layer(),
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

type Start = Pick<NewPrimitiveRunState, 'kind'> &
	Partial<Pick<NewPrimitiveRunState, 'planDir' | 'branch' | 'runChecks' | 'review'>>;

/** Creates the run in the store and returns its initial state. */
const newRun = (start: Start) =>
	Effect.gen(function* () {
		const { baseSha } = yield* (yield* GitFake).state;
		const fields = {
			kind: start.kind,
			planDir: start.planDir ?? null,
			branch: start.branch === undefined ? 'feature' : start.branch,
			review: start.review ?? null
		};
		const { runId } = yield* (yield* RunStore).createPrimitiveRun({
			...fields,
			projectKey,
			repoDir: '/repo',
			baseSha
		});
		return initialPrimitiveRunState({
			...fields,
			runId,
			projectKey,
			cwd: '/repo',
			env,
			config: yield* config,
			baseSha,
			runChecks: start.runChecks ?? true
		});
	});

/** An agent call that edits `src/<file>` and answers with `output`. */
const edits =
	(git: GitFakeShape, file: string, output?: unknown, costUsd = 0.5): AgentScript =>
	() =>
		Effect.as(git.edit([{ path: `src/${file}`, status: 'added' }]), {
			costUsd,
			...(output === undefined ? {} : { output })
		});

/** Blocks forever once called, after signalling `started`. */
const hangs =
	(started: Deferred.Deferred<void>): AgentScript =>
	() =>
		Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));

const eventsOf = (runId: RunId) =>
	Effect.map(
		Effect.flatMap(RunStore, (store) => store.events(runId)),
		(envelopes) => envelopes.map((envelope) => envelope.event)
	);

const transitions = (events: ReadonlyArray<RunEvent | { readonly _tag: 'UnknownEvent' }>) =>
	events.flatMap((event) => (event._tag === 'StateChanged' ? [event.to] : []));

const primitiveSummary = (summary: Summary): PrimitiveSummary => {
	switch (summary.kind) {
		case 'implement':
		case 'checks':
		case 'pr':
		case 'post':
			return summary;
		default:
			throw new Error(`Expected a primitive summary, got ${summary.kind ?? 'ship'}`);
	}
};

const runToEnd = (start: Start) =>
	Effect.gen(function* () {
		const state = yield* newRun(start);
		const summary = yield* Effect.flatMap(startPrimitiveRun(state), (handle) => handle.await);
		return { state, summary: primitiveSummary(summary) };
	});

describe('implement run', () => {
	it.effect('runs the baseline, implements, runs the checks and commits', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const checks = yield* ChecksFake;
				yield* agent.script(
					{ step: 'implement' },
					edits(git, 'feature.ts', { commitSubject: SUBJECT })
				);

				const { state, summary } = yield* runToEnd({
					kind: 'implement',
					planDir: PLAN_DIR
				});

				const repo = yield* git.state;
				expect(repo.commits.map((commit) => commit.message)).toEqual([SUBJECT]);
				expect(repo.pushes).toEqual([]);
				expect(repo.excluded).toEqual([PLAN_DIR]);
				expect(summary).toMatchObject({
					kind: 'implement',
					status: 'done',
					commits: [repo.headSha],
					prUrl: null,
					costUsd: 0.5,
					error: null
				});
				expect(summary.checks.map((pass) => pass.baseline)).toEqual([true, false]);
				expect((yield* checks.calls).map((call) => call.check)).toEqual(['test', 'test']);
				expect(transitions(yield* eventsOf(state.runId))).toEqual([
					'implement',
					'checks.running',
					'done'
				]);
			})
		)
	);

	it.effect('implements and commits without the checks with --no-checks', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const checks = yield* ChecksFake;
				yield* agent.script({ step: 'implement' }, edits(git, 'feature.ts'));

				const { state, summary } = yield* runToEnd({
					kind: 'implement',
					planDir: PLAN_DIR,
					runChecks: false
				});

				expect(yield* checks.calls).toEqual([]);
				expect(summary).toMatchObject({ status: 'done', checks: [] });
				expect((yield* git.state).commits.map((commit) => commit.message)).toEqual([
					'Implement feature'
				]);
				expect(transitions(yield* eventsOf(state.runId))).toEqual(['commit', 'done']);
			})
		)
	);

	it.effect('resumes mid-implement and finishes the run', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const store = yield* RunStore;
				const started = yield* Deferred.make<void>();
				yield* agent.script(
					{ step: 'implement' },
					hangs(started),
					edits(git, 'feature.ts', { commitSubject: SUBJECT })
				);
				const state = yield* newRun({ kind: 'implement', planDir: PLAN_DIR });
				yield* Effect.scoped(
					Effect.andThen(startPrimitiveRun(state), Deferred.await(started))
				);
				expect(yield* store.markInterrupted).toEqual([state.runId]);

				const summary = yield* Effect.flatMap(
					resumeRun(state.runId, env),
					(handle) => handle.await
				);

				expect(summary).toMatchObject({ kind: 'implement', status: 'done' });
				expect((yield* git.state).commits.map((commit) => commit.message)).toEqual([
					SUBJECT
				]);
			})
		)
	);
});

describe('checks run', () => {
	it.effect('fixes failing checks and commits the fixes', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const checks = yield* ChecksFake;
				yield* checks.respond(yield* exitCodesByCheck({ test: [1, 0] }));
				yield* agent.script({ step: 'fixChecks' }, edits(git, 'fix.ts', undefined, 0.1));

				const { state, summary } = yield* runToEnd({ kind: 'checks' });

				const repo = yield* git.state;
				expect(repo.commits.map((commit) => commit.message)).toEqual([
					CHECKS_COMMIT_MESSAGE
				]);
				expect(summary).toMatchObject({
					kind: 'checks',
					status: 'done',
					commits: [repo.headSha],
					costUsd: 0.1
				});
				// No baseline: the first failure is the branch's to fix.
				expect(summary.checks.map((pass) => pass.baseline)).toEqual([false, false]);
				expect(transitions(yield* eventsOf(state.runId))).toEqual(['done']);
			})
		)
	);

	it.effect('fails without committing when the checks still fail', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const checks = yield* ChecksFake;
				yield* checks.respond(yield* exitCodesByCheck({ test: [1, 1, 1, 1] }));
				yield* agent.script(
					{ step: 'fixChecks' },
					edits(git, 'a.ts'),
					edits(git, 'b.ts'),
					edits(git, 'c.ts')
				);

				const { summary } = yield* runToEnd({ kind: 'checks' });

				expect(summary.status).toBe('failed');
				expect(summary.error).toContain('Checks still fail after the check fixes: test');
				expect((yield* git.state).commits).toEqual([]);
			})
		)
	);
});

describe('pr run', () => {
	it.effect('pushes the branch and opens its PR without squashing', () =>
		withHarness(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const gh = yield* GhFake;
				const repoGit = yield* Git;
				const repo = { cwd: '/repo', env };
				yield* git.edit([{ path: 'src/a.ts', status: 'added' }]);
				yield* repoGit.commit(repo, 'First');
				yield* git.edit([{ path: 'src/b.ts', status: 'added' }]);
				yield* repoGit.commit(repo, 'Second');
				yield* agent.script(
					{ step: 'pr' },
					yield* opensPr({ title: 'Add a and b', body: 'Adds them.', costUsd: 0.05 })
				);

				const { state, summary } = yield* runToEnd({ kind: 'pr' });

				const after = yield* git.state;
				expect(after.pushes).toEqual(['feature']);
				expect(after.commits.map((commit) => commit.message)).toEqual(['First', 'Second']);
				expect(summary).toMatchObject({
					kind: 'pr',
					status: 'done',
					prUrl: PR_URL,
					commits: [],
					costUsd: 0.05
				});
				expect((yield* gh.prs).map((pr) => pr.url)).toEqual([PR_URL]);
				expect((yield* agent.calls)[0]?.prompt).toContain(
					'There is no spec or plan: the commits and the diff are the change.'
				);
				expect(transitions(yield* eventsOf(state.runId))).toEqual(['done']);
			})
		)
	);
});

describe('post run', () => {
	it.effect('posts a stored review on its PR', () =>
		withHarness(
			Effect.gen(function* () {
				const git = yield* GitFake;
				const gh = yield* GhFake;
				const { baseSha, headSha } = yield* git.state;
				const review = ReviewId.make('run-1-r1');
				yield* (yield* Reviews).save({
					id: review,
					runId: (yield* newRun({ kind: 'implement' })).runId,
					subject: {
						projectKey,
						prUrl: PR_URL,
						baseSha,
						headSha,
						intent: ChangeIntent.cases.Description.make({ title: 'Add a', body: '' })
					},
					findings: [
						{
							id: FindingId.make('r1-1'),
							round: 1,
							reviewer: 'standards',
							alsoReportedBy: [],
							file: 'src/a.ts',
							line: 40,
							severity: 'must-fix',
							claim: 'Claim 1.',
							evidence: 'const a = 1;'
						}
					],
					postedUrl: null
				});

				const { summary } = yield* runToEnd({ kind: 'post', branch: null, review });

				const [posted] = yield* gh.reviews;
				expect(posted).toMatchObject({ prUrl: PR_URL, event: 'REQUEST_CHANGES' });
				expect(summary).toMatchObject({
					kind: 'post',
					status: 'done',
					reviewUrl: posted?.url,
					prUrl: null
				});
				expect((yield* (yield* Reviews).get(review)).postedUrl).toBe(posted?.url);
			})
		)
	);
});
