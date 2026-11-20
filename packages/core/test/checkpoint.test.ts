import { describe, expect, it } from '@effect/vitest';
import { Effect, Ref, Schema } from 'effect';
import {
	Checkpoint,
	CheckpointUnreadable,
	makeCheckpoint,
	withCheckpointScope
} from '../src/index.ts';
import { mapStorage } from './primitive-harness.ts';

/** An effect that counts its runs and succeeds with `value`. */
const counted = <A>(runs: Ref.Ref<number>, value: A) =>
	Effect.as(
		Ref.update(runs, (n) => n + 1),
		value
	);

describe('Checkpoint', () => {
	it.effect('runs the work once and returns the stored value after', () =>
		Effect.gen(function* () {
			const checkpoint = makeCheckpoint(mapStorage().storage);
			const runs = yield* Ref.make(0);

			const first = yield* checkpoint.once('k', Schema.Number, counted(runs, 1));
			const second = yield* checkpoint.once('k', Schema.Number, counted(runs, 2));

			expect([first, second]).toEqual([1, 1]);
			expect(yield* Ref.get(runs)).toBe(1);
		})
	);

	it.effect('stores nothing when the work fails, so it runs again', () =>
		Effect.gen(function* () {
			const { values, storage } = mapStorage();
			const checkpoint = makeCheckpoint(storage);

			const error = yield* Effect.flip(
				checkpoint.once('k', Schema.Number, Effect.fail('no'))
			);
			const value = yield* checkpoint.once('k', Schema.Number, Effect.succeed(3));

			expect(error).toBe('no');
			expect(value).toBe(3);
			expect([...values]).toEqual([['k', 3]]);
		})
	);

	it.effect('stores the encoded value and decodes it on the way back', () =>
		Effect.gen(function* () {
			const { values, storage } = mapStorage();
			const schema = Schema.Struct({ at: Schema.DateTimeUtcFromString });
			const at = new Date('2026-11-20T10:00:00.000Z');
			const work = Effect.sync(() =>
				Schema.decodeUnknownSync(schema)({ at: at.toISOString() })
			);

			yield* makeCheckpoint(storage).once('k', schema, work);
			const again = yield* makeCheckpoint(storage).once('k', schema, Effect.die('ran twice'));

			expect(values.get('k')).toEqual({ at: at.toISOString() });
			expect(again.at.epochMilliseconds).toBe(at.getTime());
		})
	);

	it.effect('fails without running the work when the stored value does not decode', () =>
		Effect.gen(function* () {
			const { values, storage } = mapStorage();
			// Written by an older ship whose value had another shape.
			values.set('review:1/k', { old: true });
			const runs = yield* Ref.make(0);

			const error = yield* Effect.flip(
				makeCheckpoint(storage, 'review:1').once('k', Schema.Number, counted(runs, 4))
			);

			expect(error).toBeInstanceOf(CheckpointUnreadable);
			expect(error).toMatchObject({ key: 'review:1/k' });
			expect(yield* Ref.get(runs)).toBe(0);
			expect(values.get('review:1/k')).toEqual({ old: true });
		})
	);

	it.effect('keeps scoped keys apart, so loop iterations never collide', () =>
		Effect.gen(function* () {
			const { values, storage } = mapStorage();
			const checkpoint = makeCheckpoint(storage);

			yield* checkpoint.scoped('review:1').once('verify', Schema.Number, Effect.succeed(1));
			const round2 = yield* checkpoint
				.scoped('review:2')
				.once('verify', Schema.Number, Effect.succeed(2));
			yield* checkpoint
				.scoped('review:1')
				.scoped('reviewer')
				.once('standards', Schema.Number, Effect.succeed(3));

			expect(round2).toBe(2);
			expect([...values.keys()]).toEqual([
				'review:1/verify',
				'review:2/verify',
				'review:1/reviewer/standards'
			]);
		})
	);

	it.effect('scopes the Checkpoint service for the effect it wraps', () =>
		Effect.gen(function* () {
			const { values, storage } = mapStorage();
			const work = Effect.gen(function* () {
				const checkpoint = yield* Checkpoint;
				return yield* checkpoint.once('route', Schema.String, Effect.succeed('routed'));
			});

			yield* withCheckpointScope('review:1')(work).pipe(
				Effect.provideService(Checkpoint, makeCheckpoint(storage))
			);

			expect([...values.keys()]).toEqual(['review:1/route']);
		})
	);
});
