import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import {
	ChangeIntent,
	ConfigLoader,
	FindingId,
	Locks,
	PreconditionFailed,
	ProjectKey,
	ReviewId,
	Reviews,
	shipPaths,
	type VerifiedFinding
} from '@ship/core';
import { fakeSha, GitFake, type FakeGitState } from '@ship/core/testing';
import { RunStore } from '@ship/store';
import { Effect, Layer, type Scope } from 'effect';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkBranchPreconditions, checkPostPreconditions } from '../src/preconditions.ts';

const env = { PATH: '/usr/bin:/bin' };
/** The project key of the fake repo's origin. */
const projectKey = ProjectKey.make('github.com/f-elix/example');
const PR_URL = 'https://github.com/f-elix/example/pull/1';
const REVIEWED_HEAD = fakeSha(0xc);
const review = ReviewId.make('run-1-r1');

const finding: VerifiedFinding = {
	id: FindingId.make('r1-1'),
	round: 1,
	reviewer: 'standards',
	alsoReportedBy: [],
	file: 'src/a.ts',
	line: 3,
	severity: 'must-fix',
	claim: 'Broken.',
	evidence: 'const a = 1;'
};

const tempDir = Effect.acquireRelease(
	Effect.promise(() => mkdtemp(join(tmpdir(), 'ship-preconditions-'))),
	(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
);

const harness = (dir: string, repo: Partial<FakeGitState>) =>
	Layer.mergeAll(
		GitFake.layer({ headSha: REVIEWED_HEAD, ...repo }),
		ConfigLoader.layer(join(dir, 'home')),
		Locks.layer({ cpu: 2 }),
		RunStore.reviews.pipe(Layer.provideMerge(RunStore.layerFile(join(dir, 'ship.db'))))
	).pipe(Layer.provideMerge(NodeServices.layer));

type Harness = Layer.Success<ReturnType<typeof harness>>;

interface Setup {
	readonly repo?: Partial<FakeGitState>;
	/** Writes the project config for the fake repo's origin. */
	readonly config?: boolean;
}

const withHarness = <A, E>(
	setup: Setup,
	body: (dir: string) => Effect.Effect<A, E, Harness | Scope.Scope>
) =>
	Effect.gen(function* () {
		const dir = yield* tempDir;
		if (setup.config === true) {
			const path = shipPaths(join(dir, 'home')).projectConfig(projectKey);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify({ checks: [{ name: 'test', run: 'true' }] }));
		}
		return yield* body(dir).pipe(Effect.provide(harness(dir, setup.repo ?? {})));
	}).pipe(Effect.scoped);

/** The reason the precondition check fails with, or its result when it passes. */
const outcome = <A, E, R>(check: Effect.Effect<A, E, R>) =>
	check.pipe(
		Effect.map((value) => ({ passed: value }) as const),
		Effect.catch((error) =>
			Effect.succeed({
				failed: error instanceof PreconditionFailed ? error.reason : String(error)
			} as const)
		)
	);

const storeReview = (
	subject: { readonly prUrl?: string | null; readonly projectKey?: ProjectKey } = {},
	findings: ReadonlyArray<VerifiedFinding> = [finding]
) =>
	Effect.gen(function* () {
		const { runId } = yield* (yield* RunStore).createPrimitiveRun({
			kind: 'post',
			projectKey,
			repoDir: '/repo',
			baseSha: fakeSha(0xb),
			branch: null,
			planDir: null,
			review: null
		});
		yield* (yield* Reviews).save({
			id: review,
			runId,
			subject: {
				projectKey: subject.projectKey ?? projectKey,
				prUrl: subject.prUrl === undefined ? PR_URL : subject.prUrl,
				baseSha: fakeSha(0xb),
				headSha: REVIEWED_HEAD,
				intent: ChangeIntent.cases.Description.make({ title: 'Add a', body: '' })
			},
			findings,
			postedUrl: null
		});
	});

const post = outcome(checkPostPreconditions({ review, cwd: '/repo', env }));

describe('checkPostPreconditions', () => {
	it.effect(
		'passes a review with findings on its PR, at the reviewed head, without a config',
		() =>
			withHarness({}, () =>
				Effect.gen(function* () {
					yield* storeReview();
					expect(yield* post).toMatchObject({
						passed: { projectKey, baseSha: fakeSha(0xb) }
					});
				})
			)
	);

	it.effect('refuses a review it does not have', () =>
		withHarness({}, () =>
			Effect.gen(function* () {
				expect(yield* post).toEqual({ failed: 'review-not-found' });
			})
		)
	);

	it.effect('refuses a review with no PR', () =>
		withHarness({}, () =>
			Effect.gen(function* () {
				yield* storeReview({ prUrl: null });
				expect(yield* post).toEqual({ failed: 'review-without-pr' });
			})
		)
	);

	it.effect('refuses a review of another repository', () =>
		withHarness({}, () =>
			Effect.gen(function* () {
				yield* storeReview({ projectKey: ProjectKey.make('github.com/f-elix/other') });
				expect(yield* post).toEqual({ failed: 'pr-other-repo' });
			})
		)
	);

	it.effect('refuses a review with no findings', () =>
		withHarness({}, () =>
			Effect.gen(function* () {
				yield* storeReview({}, []);
				expect(yield* post).toEqual({ failed: 'no-findings' });
			})
		)
	);

	it.effect('refuses a checkout whose HEAD is not the reviewed head', () =>
		withHarness({ repo: { headSha: fakeSha(0xd) } }, () =>
			Effect.gen(function* () {
				yield* storeReview();
				const error = yield* Effect.flip(
					checkPostPreconditions({ review, cwd: '/repo', env })
				);
				expect(error).toMatchObject({ reason: 'pr-not-checked-out' });
				expect(error.detail).toContain('gh pr checkout 1');
			})
		)
	);
});

describe('checkBranchPreconditions', () => {
	const request = { planDir: null, cwd: '/repo', env };

	it.effect('passes checks on a clean feature branch, from the merge base', () =>
		withHarness({ config: true }, () =>
			Effect.gen(function* () {
				const { baseSha } = yield* (yield* GitFake).state;
				expect(yield* outcome(checkBranchPreconditions('checks', request))).toMatchObject({
					passed: { projectKey, branch: 'feature', baseSha }
				});
			})
		)
	);

	it.effect('refuses checks on the default branch, without a config or with a dirty tree', () =>
		Effect.gen(function* () {
			const checks = outcome(checkBranchPreconditions('checks', request));
			expect(
				yield* withHarness({ config: true, repo: { branch: 'main' } }, () => checks)
			).toEqual({ failed: 'on-default-branch' });
			expect(yield* withHarness({}, () => checks)).toEqual({
				failed: 'unknown-project-config'
			});
			expect(
				yield* withHarness({ config: true, repo: { dirty: true } }, () => checks)
			).toEqual({ failed: 'dirty-tree' });
		})
	);

	it.effect('passes pr without a config, excluding the plan dir from git', () =>
		withHarness({}, (dir) =>
			Effect.gen(function* () {
				const planDir = join(dir, 'plan');
				mkdirSync(planDir);
				writeFileSync(join(planDir, 'spec.md'), '# Spec\n');
				writeFileSync(join(planDir, 'implementation-plan.md'), '# Plan\n');

				expect(
					yield* outcome(checkBranchPreconditions('pr', { ...request, planDir }))
				).toMatchObject({ passed: { projectKey, branch: 'feature' } });
				expect((yield* (yield* GitFake).state).excluded).toEqual([planDir]);
			})
		)
	);

	it.effect('refuses pr with a dirty tree', () =>
		withHarness({ repo: { dirty: true } }, () =>
			Effect.gen(function* () {
				expect(yield* outcome(checkBranchPreconditions('pr', request))).toEqual({
					failed: 'dirty-tree'
				});
			})
		)
	);
});
