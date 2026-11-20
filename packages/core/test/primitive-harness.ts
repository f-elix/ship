/**
 * What the primitive tests share: the fakes and in-memory services a primitive runs on,
 * a step kit that records what the primitive reports, and its input's common fields.
 */
import { NodeServices } from '@effect/platform-node';
import { Context, Effect, Layer, Option, Ref, type Scope } from 'effect';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	Checkpoint,
	Conventions,
	Locks,
	makeCheckpoint,
	Pr,
	Reviewers,
	ReviewNotFound,
	Reviews,
	RunReporter,
	ShipHome,
	type AppendableEvent,
	type CheckpointStorage,
	type PrimitiveScope,
	type ResolvedConfig,
	type StepKit,
	type StoredReview
} from '../src/index.ts';
import {
	AgentFake,
	ChecksFake,
	ClefFake,
	GhFake,
	GitFake,
	type FakeGitState
} from '../src/testing.ts';
import { baseSha, projectKey, resolvedConfig, runId } from './fixtures.ts';
import { tempDir } from './temp-repo.ts';

/** Checkpoint storage over a plain map, so tests can read and plant raw values. */
export const mapStorage = () => {
	const values = new Map<string, unknown>();
	const storage: CheckpointStorage = {
		load: (key) => Effect.sync(() => Option.fromUndefinedOr(values.get(key))),
		save: (key, value) => Effect.sync(() => void values.set(key, value))
	};
	return { values, storage };
};

/** The raw checkpoint values of the test's `Checkpoint`. */
export class CheckpointValues extends Context.Service<CheckpointValues, Map<string, unknown>>()(
	'test/CheckpointValues'
) {}

const memoryReviews = Layer.sync(Reviews, () => {
	const stored = new Map<string, StoredReview>();
	return Reviews.of({
		save: (review) => Effect.sync(() => void stored.set(review.id, review)),
		get: (id) => {
			const review = stored.get(id);
			return review === undefined
				? Effect.fail(new ReviewNotFound({ reviewId: id }))
				: Effect.succeed(review);
		},
		byPr: (url) =>
			Effect.sync(() => [...stored.values()].filter((review) => review.subject.prUrl === url))
	});
});

/** A reviewer brief that runs on any change to `fileKind` files. */
const reviewerBrief = (name: string, fileKind: string) => `---
name: ${name}
conventions: '*'
triggers:
    fileKinds: [${fileKind}]
---

Reviews for ${name}.
`;

const harness = (dir: string, git: Partial<FakeGitState>) => {
	const { values, storage } = mapStorage();
	const fakes = Layer.mergeAll(
		AgentFake.layer,
		ClefFake.layer,
		GhFake.layer,
		GitFake.layer({ baseSha, ...git }),
		Locks.layer({ cpu: 2, db: 1 })
	);
	const services = Layer.mergeAll(
		ChecksFake.layer,
		Reviewers.layerWithBriefs(join(dir, 'briefs')),
		Conventions.layer,
		Pr.layer,
		ShipHome.layer(join(dir, 'home')),
		memoryReviews,
		Layer.succeed(Checkpoint, makeCheckpoint(storage)),
		Layer.succeed(CheckpointValues, values),
		// `invokePrimitive` reports through it; tests read events from `recordingKit`.
		Layer.succeed(RunReporter, { report: () => Effect.void })
	).pipe(Layer.provideMerge(fakes), Layer.provideMerge(NodeServices.layer));
	return services;
};

export type PrimitiveHarness = Layer.Success<ReturnType<typeof harness>>;

/**
 * Runs `body` on fresh fakes, an in-memory checkpoint and two reviewers: `standards` on
 * source changes and `security` on config changes.
 */
export const withPrimitives = <A, E>(
	body: Effect.Effect<A, E, PrimitiveHarness | Scope.Scope>,
	git: Partial<FakeGitState> = {}
) =>
	Effect.gen(function* () {
		const dir = yield* tempDir;
		mkdirSync(join(dir, 'briefs/reviewers'), { recursive: true });
		writeFileSync(
			join(dir, 'briefs/reviewers/standards.md'),
			reviewerBrief('standards', 'source')
		);
		writeFileSync(
			join(dir, 'briefs/reviewers/security.md'),
			reviewerBrief('security', 'config')
		);
		writeFileSync(join(dir, 'briefs/verifier.md'), 'You verify findings.\n');
		return yield* body.pipe(Effect.provide(harness(dir, git)));
	}).pipe(Effect.scoped);

/** A step kit that keeps what the primitive reports, records and resumes. */
export const recordingKit = Effect.gen(function* () {
	const events = yield* Ref.make<ReadonlyArray<{ readonly _tag: string }>>([]);
	const costs = yield* Ref.make<ReadonlyArray<number>>([]);
	const sessions = yield* Ref.make<ReadonlyArray<string>>([]);
	const keep = (event: { readonly _tag: string }) => Ref.update(events, (all) => [...all, event]);
	const kit: StepKit = {
		report: keep,
		emit: (event: AppendableEvent) => keep(event),
		recordCost: (cost) => Ref.update(costs, (all) => [...all, cost.costUsd]),
		recordSession: (session) => Ref.update(sessions, (all) => [...all, session.sessionId])
	};
	return {
		kit,
		/** The tags of every event reported, in order. */
		tags: Effect.map(Ref.get(events), (all) => all.map((event) => event._tag)),
		costs: Ref.get(costs),
		sessions: Ref.get(sessions)
	};
});

/** The fields every primitive input starts with, on the fake repo at `baseSha`. */
export const scopeWith = (config: Partial<ResolvedConfig> = {}): PrimitiveScope => ({
	runId,
	projectKey,
	cwd: '/repo',
	env: { PATH: '/usr/bin:/bin' },
	baseSha,
	config: { ...resolvedConfig, ...config }
});
