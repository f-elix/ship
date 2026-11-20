import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import {
	AgentSdkError,
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
	reviewIdFor,
	Reviews,
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
import { Deferred, Effect, Layer, Option, Schema, type Scope } from 'effect';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { PATH: '/usr/bin:/bin', GITHUB_TOKEN: 'ghp_review-secret' };
const projectKey = ProjectKey.make('github.com/f-elix/example');
const PR_URL = 'https://github.com/f-elix/example/pull/7';
const BASE = fakeSha(0xb);
const HEAD = fakeSha(0xc);

const reviewer = (name: string) => `---
name: ${name}
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
		RunStore.journal,
		RunStore.reviews
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

/** Runs `body` against fresh fakes, a temp run store and a temp brief per reviewer. */
const withHarness = <A, E>(
	body: (dir: string) => Effect.Effect<A, E, Harness | Scope.Scope>,
	reviewerNames: ReadonlyArray<string> = ['standards']
) =>
	Effect.gen(function* () {
		const dir = yield* tempDir;
		mkdirSync(join(dir, 'briefs/reviewers'), { recursive: true });
		for (const name of reviewerNames) {
			writeFileSync(join(dir, `briefs/reviewers/${name}.md`), reviewer(name));
		}
		writeFileSync(join(dir, 'briefs/verifier.md'), 'You verify findings.\n');
		return yield* body(dir).pipe(Effect.provide(harness(dir)));
	}).pipe(Effect.scoped);

/** Creates a review run of PR 7 in the store and returns its initial state. */
const newReview = (post: boolean) =>
	Effect.gen(function* () {
		const store = yield* RunStore;
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
			cwd: '/repo',
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
			post
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

/** Runs the review until `started` completes, then stops it as a daemon shutdown would. */
const interruptAfter = (state: ReviewRunState, started: Deferred.Deferred<void>) =>
	Effect.gen(function* () {
		const store = yield* RunStore;
		yield* Effect.scoped(
			Effect.gen(function* () {
				yield* startReview(state);
				yield* Deferred.await(started);
			})
		);
		expect(yield* store.markInterrupted).toEqual([state.runId]);
	});

/** Waits until the run's checkpoint `key` is stored. */
const checkpointed = (state: ReviewRunState, key: string) =>
	Effect.gen(function* () {
		const store = yield* RunStore;
		while (Option.isNone(yield* store.loadCheckpoint(state.runId, key))) {
			yield* Effect.yieldNow;
		}
	});

/** The reviewers called so far, sorted: reviewers run concurrently. */
const reviewerCalls = Effect.gen(function* () {
	const calls = yield* (yield* AgentFake).calls;
	return calls
		.filter((call) => call.step === 'review')
		.map((call) => call.label)
		.toSorted();
});

describe('review run', () => {
	it.effect("reviews the PR in the caller's checkout and stores the review", () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const reviews = yield* Reviews;
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					reviewerSays(finding('must-fix', 3))
				);
				yield* agent.script({ step: 'verify' }, verifierConfirms(1));
				const state = yield* newReview(false);

				const summary = yield* Effect.flatMap(startReview(state), (handle) => handle.await);

				const reviewId = reviewIdFor(state.runId, 1);
				expect(summary).toMatchObject({
					kind: 'review',
					status: 'done',
					prUrl: PR_URL,
					reviewUrl: null,
					reviewId,
					costUsd: expect.closeTo(0.3),
					tradeoffs: [],
					nits: [],
					error: null
				});
				expect(summary.mustFix).toHaveLength(1);
				expect(transitions(yield* eventsOf(state))).toEqual(['done']);
				// The review outlives the run: it is stored with the subject it is about.
				const stored = yield* reviews.get(reviewId);
				expect(stored).toMatchObject({
					runId: state.runId,
					subject: {
						projectKey,
						prUrl: PR_URL,
						baseSha: BASE,
						headSha: HEAD,
						intent: { _tag: 'Description', title: 'Add the feature' }
					},
					postedUrl: null
				});
				expect(stored.findings).toEqual(summary.mustFix);
				// Without --post nothing reaches GitHub.
				expect(yield* gh.reviews).toEqual([]);
				const calls = yield* agent.calls;
				expect(calls.map((call) => call.cwd)).toEqual(['/repo', '/repo']);
				expect(calls[0]?.prompt).toContain('Title: Add the feature');
			})
		)
	);

	it.effect('posts the stored review on the pinned head with --post', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const reviews = yield* Reviews;
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					reviewerSays(finding('must-fix', 3), finding('nit', 40))
				);
				yield* agent.script({ step: 'verify' }, verifierConfirms(2));
				const state = yield* newReview(true);

				const summary = yield* Effect.flatMap(startReview(state), (handle) => handle.await);

				const posted = yield* gh.reviews;
				expect(posted).toMatchObject([
					{
						prUrl: PR_URL,
						commitId: HEAD,
						event: 'REQUEST_CHANGES',
						comments: [{ path: 'src/feature.ts', line: 3 }]
					}
				]);
				expect(posted[0]?.body).toContain('`src/feature.ts:40`');
				const reviewUrl = `${PR_URL}#pullrequestreview-1`;
				expect(summary).toMatchObject({ status: 'done', reviewUrl });
				expect((yield* reviews.get(reviewIdFor(state.runId, 1))).postedUrl).toBe(reviewUrl);
				const events = yield* eventsOf(state);
				expect(transitions(events)).toEqual(['post', 'done']);
				expect(events.find((event) => event._tag === 'PrReviewPosted')).toMatchObject({
					event: 'REQUEST_CHANGES',
					inline: 1,
					inBody: 1
				});
			})
		)
	);

	it.effect('posts nothing when the review found nothing, even with --post', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				const state = yield* newReview(true);

				const summary = yield* Effect.flatMap(startReview(state), (handle) => handle.await);

				expect(summary).toMatchObject({ status: 'done', reviewUrl: null, mustFix: [] });
				expect(yield* gh.reviews).toEqual([]);
				expect(transitions(yield* eventsOf(state))).toEqual(['done']);
			})
		)
	);

	it.effect('fails when posting fails, keeping the stored review unposted', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const reviews = yield* Reviews;
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
				expect((yield* reviews.get(reviewIdFor(state.runId, 1))).postedUrl).toBeNull();
			})
		)
	);

	it.effect('fails without storing a review when HEAD moved before the review routed', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const reviews = yield* Reviews;
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				yield* git.update((repo) => ({ ...repo, headSha: fakeSha(0xd) }));
				const state = yield* newReview(false);

				const summary = yield* Effect.flatMap(startReview(state), (handle) => handle.await);

				expect(summary.status).toBe('failed');
				expect(summary.error).toContain(`to ${fakeSha(0xd)} during the review`);
				const missing = yield* Effect.flip(reviews.get(reviewIdFor(state.runId, 1)));
				expect(missing._tag).toBe('ReviewNotFound');
			})
		)
	);

	it.effect('is cancelled mid-review', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const started = yield* Deferred.make<void>();
				yield* agent.script({ step: 'review', label: 'standards' }, hangs(started));
				const state = yield* newReview(false);

				const handle = yield* startReview(state);
				yield* Deferred.await(started);
				yield* handle.cancel;
				const summary = yield* handle.await;

				expect(summary.status).toBe('cancelled');
			})
		)
	);

	it.effect('resumes mid-review without re-running the reviewers that reported', () =>
		withHarness(
			() =>
				Effect.gen(function* () {
					const agent = yield* AgentFake;
					const gh = yield* GhFake;
					const git = yield* GitFake;
					const started = yield* Deferred.make<void>();
					yield* agent.script(
						{ step: 'review', label: 'standards' },
						reviewerSays(finding('must-fix', 2))
					);
					yield* agent.script(
						{ step: 'review', label: 'security' },
						hangs(started),
						reviewerSays(finding('nit', 4))
					);
					yield* agent.script({ step: 'verify' }, verifierConfirms(2));
					const state = yield* newReview(true);

					// The daemon stops while `security` reviews, after `standards` reported.
					yield* Effect.scoped(
						Effect.gen(function* () {
							yield* startReview(state);
							yield* Deferred.await(started);
							yield* checkpointed(state, 'review/reviewer/standards');
						})
					);
					yield* (yield* RunStore).markInterrupted;
					expect(yield* reviewerCalls).toEqual(['security', 'standards']);
					const freshEnv = { PATH: '/opt/bin' };

					const summary = yield* Effect.flatMap(
						resumeRun(state.runId, freshEnv),
						(handle) => handle.await
					);

					if (summary.kind !== 'review') throw new Error('Expected a review summary');
					expect(summary.status).toBe('done');
					// Only the interrupted reviewer runs again; `standards`' report is reused.
					expect(yield* reviewerCalls).toEqual(['security', 'security', 'standards']);
					expect(summary.mustFix.map((finding) => finding.reviewer)).toEqual([
						'standards'
					]);
					expect(summary.nits.map((finding) => finding.reviewer)).toEqual(['security']);
					expect((yield* agent.calls).at(-1)?.env).toEqual(freshEnv);
					expect((yield* git.state).fetches).toEqual([]);
					expect((yield* gh.reviews).map((review) => review.commitId)).toEqual([HEAD]);
					expect(transitions(yield* eventsOf(state))).toEqual(['post', 'done']);
				}),
			['standards', 'security']
		)
	);

	it.effect('resumes a failed review, re-running only the reviewer that failed', () =>
		withHarness(
			() =>
				Effect.gen(function* () {
					const agent = yield* AgentFake;
					const store = yield* RunStore;
					const state = yield* newReview(false);
					const standardsSaved = yield* Deferred.make<void>();
					yield* checkpointed(state, 'review/reviewer/standards').pipe(
						Effect.andThen(Deferred.succeed(standardsSaved, undefined)),
						Effect.forkScoped
					);
					yield* agent.script(
						{ step: 'review', label: 'standards' },
						reviewerSays(finding('must-fix', 2))
					);
					// `security` fails once `standards` reported, as a safeguard flag would.
					yield* agent.script(
						{ step: 'review', label: 'security' },
						() =>
							Deferred.await(standardsSaved).pipe(
								Effect.andThen(
									Effect.fail(
										new AgentSdkError({
											step: 'review',
											reason: 'exception',
											detail: 'API Error: safeguards flagged this message'
										})
									)
								)
							),
						reviewerSays(finding('nit', 4))
					);
					yield* agent.script({ step: 'verify' }, verifierConfirms(2));

					const failed = yield* Effect.flatMap(
						startReview(state),
						(handle) => handle.await
					);
					expect(failed.status).toBe('failed');
					expect(failed.error).toContain('safeguards flagged');

					const summary = yield* Effect.flatMap(
						resumeRun(state.runId, env),
						(handle) => handle.await
					);

					if (summary.kind !== 'review') throw new Error('Expected a review summary');
					expect(summary.status).toBe('done');
					expect(summary.error).toBeNull();
					expect(yield* reviewerCalls).toEqual(['security', 'security', 'standards']);
					expect(summary.mustFix.map((finding) => finding.reviewer)).toEqual([
						'standards'
					]);
					expect(summary.nits.map((finding) => finding.reviewer)).toEqual(['security']);
					const info = yield* store.get(state.runId);
					expect(info.status).toBe('done');
					expect(
						(yield* eventsOf(state)).flatMap((event) =>
							event._tag === 'RunFinished' || event._tag === 'RunResumed'
								? [event._tag]
								: []
						)
					).toEqual(['RunFinished', 'RunResumed', 'RunFinished']);
				}),
			['standards', 'security']
		)
	);

	it.effect('refuses to resume a run that finished done', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				const state = yield* newReview(false);
				yield* Effect.flatMap(startReview(state), (handle) => handle.await);

				const error = yield* Effect.flip(resumeRun(state.runId, env));

				expect(error).toMatchObject({ _tag: 'InvalidRunStatus', status: 'done' });
			})
		)
	);

	it.effect('does not post a second review when resumed after GitHub accepted the first', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const reviews = yield* Reviews;
				const accepted = yield* Deferred.make<void>();
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					reviewerSays(finding('must-fix', 3))
				);
				yield* agent.script({ step: 'verify' }, verifierConfirms(1));
				// GitHub accepts the review, then the daemon stops before ship records it.
				yield* gh.afterSubmit(
					Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Effect.never))
				);
				const state = yield* newReview(true);
				yield* interruptAfter(state, accepted);
				yield* gh.afterSubmit(Effect.void);

				const summary = yield* Effect.flatMap(
					resumeRun(state.runId, env),
					(handle) => handle.await
				);

				const posted = yield* gh.reviews;
				expect(posted).toHaveLength(1);
				expect(posted[0]?.body).toContain(
					`<!-- ship-review: ${reviewIdFor(state.runId, 1)} -->`
				);
				expect(summary).toMatchObject({ status: 'done', reviewUrl: posted[0]?.url });
				expect((yield* reviews.get(reviewIdFor(state.runId, 1))).postedUrl).toBe(
					posted[0]?.url
				);
				// The resumed run did not review again either.
				expect(yield* reviewerCalls).toEqual(['standards']);
			})
		)
	);

	it.effect('refuses to post when HEAD moved since the run started', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const git = yield* GitFake;
				const started = yield* Deferred.make<void>();
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					reviewerSays(finding('must-fix', 3))
				);
				yield* agent.script({ step: 'verify' }, hangs(started), verifierConfirms(1));
				const state = yield* newReview(true);
				// The run stops while verifying, and the caller checks out another commit.
				yield* interruptAfter(state, started);
				yield* git.update((repo) => ({ ...repo, headSha: fakeSha(0xd) }));

				const summary = yield* Effect.flatMap(
					resumeRun(state.runId, env),
					(handle) => handle.await
				);

				expect(summary.status).toBe('failed');
				expect(summary.error).toContain(
					`HEAD moved from the reviewed ${HEAD} to ${fakeSha(0xd)}`
				);
				expect(yield* gh.reviews).toEqual([]);
			})
		)
	);

	it.effect('is cancelled from its log once interrupted', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const store = yield* RunStore;
				const started = yield* Deferred.make<void>();
				yield* agent.script({ step: 'review', label: 'standards' }, hangs(started));
				const state = yield* newReview(false);
				yield* interruptAfter(state, started);

				const summary = yield* cancelFromLog(state.runId);

				expect(summary).toMatchObject({
					kind: 'review',
					status: 'cancelled',
					prUrl: PR_URL
				});
				expect((yield* store.get(state.runId)).status).toBe('cancelled');
			})
		)
	);
});
