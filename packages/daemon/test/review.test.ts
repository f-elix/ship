import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import {
	cancelFromLog,
	configParseOptions,
	Conventions,
	decodeProjectConfig,
	GlobalConfig,
	initialReviewRunState,
	Locks,
	Pr,
	ProjectKey,
	resolveConfig,
	resumeRun,
	Reviewers,
	ShipHome,
	startReview,
	type ReviewRunState,
	type RunEvent
} from '@ship/core';
import {
	AgentFake,
	ChecksFake,
	ClefFake,
	fakeSha,
	GhFake,
	GitFake,
	type AgentScript
} from '@ship/core/testing';
import { RunStore } from '@ship/store';
import { Deferred, Effect, Layer, Schema, type Scope } from 'effect';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { PATH: '/usr/bin:/bin', GITHUB_TOKEN: 'ghp_review-secret' };
const projectKey = ProjectKey.make('github.com/f-elix/example');
const PR_URL = 'https://github.com/f-elix/example/pull/7';
const BASE = fakeSha(0xb);
const HEAD = fakeSha(0xc);

const REVIEWER = `---
name: standards
triggers:
    fileKinds: [source]
---

Checks the project's conventions.
`;

/** A diff whose hunk covers lines 1 to 5 of `src/feature.ts`. */
const DIFF = [
	'diff --git a/src/feature.ts b/src/feature.ts',
	'--- /dev/null',
	'+++ b/src/feature.ts',
	'@@ -0,0 +1,5 @@',
	...Array.from({ length: 5 }, (_, index) => `+line ${index + 1}`)
].join('\n');

const tempDir = Effect.acquireRelease(
	Effect.promise(() => mkdtemp(join(tmpdir(), 'ship-review-'))),
	(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
);

const harness = (dir: string) =>
	Layer.mergeAll(
		Reviewers.layerWithBriefs(join(dir, 'briefs')),
		Conventions.layer,
		ChecksFake.layer,
		Pr.layer,
		ShipHome.layer(join(dir, 'home')),
		RunStore.journal
	).pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				AgentFake.layer,
				ClefFake.layer,
				GhFake.layer,
				Locks.layer({}),
				GitFake.layer({
					headSha: HEAD,
					changedFiles: [{ path: 'src/feature.ts', status: 'added' }],
					diff: DIFF
				}),
				RunStore.layerFile(join(dir, 'ship.db'))
			)
		),
		Layer.provideMerge(NodeServices.layer)
	);

type Harness = Layer.Success<ReturnType<typeof harness>>;

/** Runs `body` against fresh fakes, a temp run store and a temp reviewer brief. */
const withHarness = <A, E>(body: (dir: string) => Effect.Effect<A, E, Harness | Scope.Scope>) =>
	Effect.gen(function* () {
		const dir = yield* tempDir;
		mkdirSync(join(dir, 'briefs/reviewers'), { recursive: true });
		writeFileSync(join(dir, 'briefs/reviewers/standards.md'), REVIEWER);
		writeFileSync(join(dir, 'briefs/verifier.md'), 'You verify findings.\n');
		return yield* body(dir).pipe(Effect.provide(harness(dir)));
	}).pipe(Effect.scoped);

/** Creates a review run of PR 7 in the store and returns its initial state. */
const newReview = (post: boolean) =>
	Effect.gen(function* () {
		const store = yield* RunStore;
		const home = yield* ShipHome;
		const projectConfig = yield* decodeProjectConfig({ reviewers: { clef: false } }).pipe(
			Effect.orDie
		);
		const info = yield* store.createReview({
			projectKey,
			repoDir: '/repo',
			prUrl: PR_URL,
			prNumber: 7,
			baseSha: BASE,
			headSha: HEAD
		});
		return initialReviewRunState({
			runId: info.runId,
			projectKey,
			cwd: home.reviewWorktree(info.runId),
			env,
			config: resolveConfig(
				Schema.decodeUnknownSync(GlobalConfig, configParseOptions)({}),
				projectConfig
			),
			pr: {
				number: 7,
				url: PR_URL,
				title: 'Add the feature',
				body: 'Adds the feature module.',
				baseSha: BASE,
				headSha: HEAD
			},
			post,
			repoDir: '/repo'
		});
	});

const finding = (severity: 'must-fix' | 'nit', line: number) => ({
	file: 'src/feature.ts',
	line,
	severity,
	claim: `A ${severity} on line ${line}`,
	evidence: `line ${line}`
});

const reviewerSays = (...findings: ReadonlyArray<ReturnType<typeof finding>>) => ({
	output: { findings },
	costUsd: 0.1
});

const verifierConfirms = (count: number) => ({
	output: {
		verdicts: Array.from({ length: count }, (_, index) => ({
			index,
			verdict: 'confirmed',
			reason: 'Seen'
		})),
		previous: []
	},
	costUsd: 0.2
});

/** Blocks forever once called, after signalling `started`. */
const hangs =
	(started: Deferred.Deferred<void>): AgentScript =>
	() =>
		Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));

const eventsOf = Effect.fnUntraced(function* (state: ReviewRunState) {
	const store = yield* RunStore;
	return (yield* store.events(state.runId)).map((envelope) => envelope.event);
});

const transitions = (events: ReadonlyArray<RunEvent | { readonly _tag: 'UnknownEvent' }>) =>
	events.flatMap((event) => (event._tag === 'StateChanged' ? [event.to] : []));

describe('review run', () => {
	it.effect('reviews the PR in a worktree at its head and removes the worktree after', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const gh = yield* GhFake;
				const state = yield* newReview(false);
				// The reviewer runs in the worktree, added at the PR's head before the round.
				yield* agent.script({ step: 'review', label: 'standards' }, () =>
					Effect.map(git.state, (repo) => {
						expect(repo.worktrees).toEqual([{ path: state.cwd, sha: HEAD }]);
						return reviewerSays(finding('must-fix', 3));
					})
				);
				yield* agent.script({ step: 'verify' }, verifierConfirms(1));

				const summary = yield* Effect.flatMap(startReview(state), (handle) => handle.await);

				expect((yield* git.state).worktrees).toEqual([]);
				expect(summary).toMatchObject({
					kind: 'review',
					status: 'done',
					prUrl: PR_URL,
					reviewUrl: null,
					costUsd: expect.closeTo(0.3),
					tradeoffs: [],
					nits: [],
					error: null
				});
				expect(summary.mustFix).toHaveLength(1);
				expect(transitions(yield* eventsOf(state))).toEqual([
					'route',
					'review',
					'verify',
					'done'
				]);
				// Without --post nothing reaches GitHub.
				expect(yield* gh.reviews).toEqual([]);
				const calls = yield* agent.calls;
				expect(calls.map((call) => call.cwd)).toEqual([state.cwd, state.cwd]);
				expect(calls[0]?.prompt).toContain('Title: Add the feature');
			})
		)
	);

	it.effect('posts the findings as one review on the pinned head with --post', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					reviewerSays(finding('must-fix', 3), finding('nit', 40))
				);
				yield* agent.script({ step: 'verify' }, verifierConfirms(2));
				const state = yield* newReview(true);

				const summary = yield* Effect.flatMap(startReview(state), (handle) => handle.await);

				const reviews = yield* gh.reviews;
				expect(reviews).toMatchObject([
					{
						prUrl: PR_URL,
						commitId: HEAD,
						event: 'REQUEST_CHANGES',
						comments: [{ path: 'src/feature.ts', line: 3 }]
					}
				]);
				expect(reviews[0]?.body).toContain('`src/feature.ts:40`');
				expect(summary).toMatchObject({
					status: 'done',
					reviewUrl: `${PR_URL}#pullrequestreview-1`
				});
				const events = yield* eventsOf(state);
				expect(transitions(events)).toEqual(['route', 'review', 'verify', 'post', 'done']);
				expect(events.find((event) => event._tag === 'PrReviewPosted')).toMatchObject({
					event: 'REQUEST_CHANGES',
					inline: 1,
					inBody: 1
				});
			})
		)
	);

	it.effect('posts nothing when the round found nothing, even with --post', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				const state = yield* newReview(true);

				const summary = yield* Effect.flatMap(startReview(state), (handle) => handle.await);

				expect(summary).toMatchObject({ status: 'done', reviewUrl: null, mustFix: [] });
				expect(yield* gh.reviews).toEqual([]);
				expect(transitions(yield* eventsOf(state))).not.toContain('post');
			})
		)
	);

	it.effect('fails when posting fails, still removing the worktree', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const git = yield* GitFake;
				yield* gh.fail('submitReview', 'HTTP 422: Unprocessable Entity');
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					reviewerSays(finding('nit', 3))
				);
				yield* agent.script({ step: 'verify' }, verifierConfirms(1));
				const state = yield* newReview(true);

				const summary = yield* Effect.flatMap(startReview(state), (handle) => handle.await);

				expect(summary.status).toBe('failed');
				expect(summary.error).toContain('HTTP 422');
				expect((yield* git.state).worktrees).toEqual([]);
			})
		)
	);

	it.effect('removes the worktree when cancelled mid-review', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const started = yield* Deferred.make<void>();
				yield* agent.script({ step: 'review', label: 'standards' }, hangs(started));
				const state = yield* newReview(false);

				const handle = yield* startReview(state);
				yield* Deferred.await(started);
				expect((yield* git.state).worktrees).toHaveLength(1);
				yield* handle.cancel;
				const summary = yield* handle.await;

				expect(summary.status).toBe('cancelled');
				expect((yield* git.state).worktrees).toEqual([]);
			})
		)
	);

	it.effect('resumes mid-review on the pinned head, reusing its worktree', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const gh = yield* GhFake;
				const store = yield* RunStore;
				const started = yield* Deferred.make<void>();
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					hangs(started),
					reviewerSays(finding('must-fix', 2))
				);
				yield* agent.script({ step: 'verify' }, verifierConfirms(1));
				const state = yield* newReview(true);

				// The daemon stops mid-review: the run's scope closes without finishing it.
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* startReview(state);
						yield* Deferred.await(started);
					})
				);
				expect(yield* store.markInterrupted).toEqual([state.runId]);
				// Someone pushes to the PR meanwhile; the run keeps reviewing what it pinned.
				yield* git.update((repo) => ({
					...repo,
					remoteRefs: { 'refs/pull/7/head': fakeSha(0xd) }
				}));

				const freshEnv = { PATH: '/opt/bin' };
				const handle = yield* resumeRun(state.runId, freshEnv);
				const summary = yield* handle.await;

				expect(summary).toMatchObject({ kind: 'review', status: 'done' });
				const repo = yield* git.state;
				expect(repo.fetches).toEqual([]);
				expect(repo.worktrees).toEqual([]);
				expect((yield* gh.reviews).map((review) => review.commitId)).toEqual([HEAD]);
				const calls = yield* agent.calls;
				expect(calls.at(-1)?.env).toEqual(freshEnv);
				expect(transitions(yield* eventsOf(state))).toEqual([
					'route',
					'review',
					'verify',
					'post',
					'done'
				]);
			})
		)
	);

	it.effect('removes the worktree when an interrupted run is cancelled', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const store = yield* RunStore;
				const started = yield* Deferred.make<void>();
				yield* agent.script({ step: 'review', label: 'standards' }, hangs(started));
				const state = yield* newReview(false);
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* startReview(state);
						yield* Deferred.await(started);
					})
				);
				yield* store.markInterrupted;
				expect((yield* git.state).worktrees).toHaveLength(1);

				const summary = yield* cancelFromLog(state.runId, env);

				expect(summary).toMatchObject({
					kind: 'review',
					status: 'cancelled',
					prUrl: PR_URL
				});
				expect((yield* git.state).worktrees).toEqual([]);
				expect((yield* store.get(state.runId)).status).toBe('cancelled');
			})
		)
	);
});
