/**
 * Durable results of a run's sub-work. A resumed run re-runs the step that was in flight;
 * the step skips the parts it already finished by wrapping each in `Checkpoint.once`.
 *
 * Stored values outlive the code that wrote them, so changing the schema of a checkpointed
 * value requires bumping `SNAPSHOT_VERSION`: runs saved before it are then not resumed.
 */
import { Context, Effect, Option, Schema } from 'effect';

/** Where checkpoint values are kept, as their encoded JSON values, under full keys. */
export interface CheckpointStorage {
	readonly load: (key: string) => Effect.Effect<Option.Option<unknown>>;
	readonly save: (key: string, value: unknown) => Effect.Effect<void>;
}

export interface CheckpointShape {
	/**
	 * Returns the value stored under `key`, or runs `effect` and stores its value. The
	 * value is stored only once `effect` succeeds, so a failed or interrupted `effect` runs
	 * again next time. Whatever `effect` does besides producing its value, such as
	 * reporting events or recording cost, is not repeated when the stored value is
	 * returned. A stored value that does not decode with `schema` fails with
	 * `CheckpointUnreadable` instead of running `effect` again, since its side effects,
	 * such as a posted review, may already have happened.
	 */
	readonly once: <A, I, E, R>(
		key: string,
		schema: Schema.Codec<A, I>,
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<A, E | CheckpointUnreadable, R>;
	/** The same checkpoints with every key under `prefix`, e.g. `review:2`. */
	readonly scoped: (prefix: string) => CheckpointShape;
}

/** A stored checkpoint value does not decode with the schema it is read with. */
export class CheckpointUnreadable extends Schema.TaggedError<CheckpointUnreadable>()(
	'CheckpointUnreadable',
	{ key: Schema.String, detail: Schema.String }
) {
	override get message(): string {
		return `The checkpoint ${this.key} cannot be read: ${this.detail}`;
	}
}

/** A run's checkpoints. The run driver provides one per run, kept in the run store. */
export class Checkpoint extends Context.Service<Checkpoint, CheckpointShape>()(
	'@ship/core/Checkpoint'
) {}

const SEPARATOR = '/';

/** The checkpoints kept in `storage`, with keys under `prefix` when it is given. */
export const makeCheckpoint = (storage: CheckpointStorage, prefix?: string): CheckpointShape => {
	const fullKey = (key: string) => (prefix === undefined ? key : `${prefix}${SEPARATOR}${key}`);
	return {
		once: <A, I, E, R>(
			key: string,
			schema: Schema.Codec<A, I>,
			effect: Effect.Effect<A, E, R>
		): Effect.Effect<A, E | CheckpointUnreadable, R> =>
			Effect.gen(function* () {
				const full = fullKey(key);
				const stored = yield* storage.load(full);
				if (Option.isSome(stored)) {
					return yield* Schema.decodeUnknownEffect(schema)(stored.value).pipe(
						Effect.mapError(
							(cause) =>
								new CheckpointUnreadable({ key: full, detail: cause.message })
						)
					);
				}
				const value = yield* effect;
				// A value that cannot be encoded is a bug in `schema`, not an outcome.
				const encoded = yield* Effect.orDie(Schema.encodeEffect(schema)(value));
				yield* storage.save(full, encoded);
				return value;
			}),
		scoped: (inner) => makeCheckpoint(storage, fullKey(inner))
	};
};

/** Runs `effect` with the current checkpoints scoped under `prefix`. */
export const withCheckpointScope =
	(prefix: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | Checkpoint> =>
		Effect.gen(function* () {
			const checkpoint = yield* Checkpoint;
			return yield* Effect.provideService(effect, Checkpoint, checkpoint.scoped(prefix));
		});
