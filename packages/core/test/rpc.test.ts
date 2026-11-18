import { assert, describe, it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { RpcTest } from 'effect/rpc';
import { PreconditionFailed, RunEvent, RunNotFound, ShipRpcs } from '../src/index.ts';
import { at, runId } from './fixtures.ts';

const notUsed = () => Effect.die('not used in this test');

/** Stub handlers: `run` always fails its precondition, `events` replays two events. */
const Handlers = ShipRpcs.toLayer({
	handshake: notUsed,
	run: () => Effect.fail(new PreconditionFailed({ reason: 'on-default-branch', detail: 'main' })),
	resume: notUsed,
	cancel: notUsed,
	status: (payload) => Effect.fail(new RunNotFound({ runId: payload.runId })),
	list: notUsed,
	stop: notUsed,
	runChecks: () => Stream.die('not used in this test'),
	events: (payload) =>
		Stream.fromIterable([
			{ runId: payload.runId, seq: 1, event: RunEvent.cases.RunResumed.make({ at }) },
			{ runId: payload.runId, seq: 2, event: RunEvent.cases.RunCancelled.make({ at }) }
		]).pipe(Stream.filter((envelope) => envelope.seq >= (payload.fromSeq ?? 1)))
});

describe('ShipRpcs', () => {
	it.effect('carries typed errors and streams event envelopes', () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(ShipRpcs);

			const error = yield* Effect.flip(
				client.run({ planDir: '/plans/feature', cwd: '/repo', env: {} })
			);
			assert.strictEqual(error.reason, 'on-default-branch');

			const missing = yield* Effect.flip(client.status({ runId }));
			assert.strictEqual(missing._tag, 'RunNotFound');

			const tags = yield* client.events({ runId, fromSeq: 2 }).pipe(
				Stream.map((envelope) => envelope.event._tag),
				Stream.runCollect
			);
			assert.deepStrictEqual(Array.from(tags), ['RunCancelled']);
		}).pipe(Effect.provide(Handlers), Effect.scoped)
	);
});
