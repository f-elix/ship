/**
 * The developer's archive marks, kept in `~/.ship/ui/archive.json`. Ship's run store
 * knows nothing of them: archiving is how the inbox is sorted, not something a run does.
 */
import { ShipHome } from '@ship/core/contract';
import {
	Clock,
	Context,
	DateTime,
	Effect,
	FileSystem,
	Layer,
	Ref,
	Result,
	Schema,
	Stream,
	SubscriptionRef
} from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { DeliverableId, type ArchiveMarks } from './deliverables.ts';

/** The archive file could not be read, decoded or written. */
export class ArchiveError extends Schema.TaggedError<ArchiveError>()('ArchiveError', {
	path: Schema.String,
	detail: Schema.String,
	cause: Schema.Defect()
}) {
	override get message(): string {
		return `Cannot use the archive file ${this.path}: ${this.detail}`;
	}
}

export interface ArchiveApi {
	/** The current marks, then the marks after each change. */
	readonly marks: Stream.Stream<ArchiveMarks>;
	/** The marks now. */
	readonly current: Effect.Effect<ArchiveMarks>;
	/** Marks the deliverable archived, as of now. */
	readonly archive: (id: DeliverableId) => Effect.Effect<void, ArchiveError>;
	/** Marks the deliverable not archived, as of now, which overrides archiving it automatically. */
	readonly unarchive: (id: DeliverableId) => Effect.Effect<void, ArchiveError>;
}

const ArchiveFile = Schema.Record(
	DeliverableId,
	Schema.Struct({ archived: Schema.Boolean, at: Schema.DateTimeUtcFromString })
);
const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ArchiveFile));
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(ArchiveFile));

/** Archive marks over `ref`; each change goes through `save` before `ref` takes it. */
const makeApi = (
	ref: SubscriptionRef.SubscriptionRef<ArchiveMarks>,
	save: (marks: ArchiveMarks) => Effect.Effect<void, ArchiveError>
): ArchiveApi => {
	const mark = (archived: boolean) => (id: DeliverableId) =>
		SubscriptionRef.updateEffect(ref, (marks) =>
			Effect.gen(function* () {
				const next = new Map(marks).set(id, { archived, at: yield* DateTime.now });
				yield* save(next);
				return next;
			})
		);
	return {
		marks: SubscriptionRef.changes(ref),
		current: SubscriptionRef.get(ref),
		archive: mark(true),
		unarchive: mark(false)
	};
};

const make = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const { uiArchive: path } = yield* ShipHome;
	const fail = (error: PlatformError | Schema.SchemaError) =>
		new ArchiveError({ path, detail: error.message, cause: error });

	const load = Effect.gen(function* () {
		if (!(yield* fs.exists(path))) return new Map();
		const file = yield* decodeFile(yield* fs.readFileString(path));
		return new Map(
			Object.entries(file) as Array<[DeliverableId, (typeof file)[DeliverableId]]>
		);
	}).pipe(Effect.mapError(fail));

	// A file the inbox cannot read must not hide the inbox, so it starts empty. Its marks
	// are not lost: the first save moves the file aside before it writes a new one.
	const initial = yield* load.pipe(Effect.result);
	if (initial._tag === 'Failure') yield* Effect.logWarning(initial.failure.message);
	const unread = yield* Ref.make(initial._tag === 'Failure');

	/** Keeps the file it could not read as `archive.json.<millis>.bak`, once. */
	const setAsideUnread = Effect.gen(function* () {
		if (!(yield* Ref.get(unread))) return;
		const backup = `${path}.${yield* Clock.currentTimeMillis}.bak`;
		yield* fs.rename(path, backup);
		yield* Ref.set(unread, false);
		yield* Effect.logWarning(`Kept the archive file it could not read as ${backup}`);
	});

	/** Replaces the file whole, through a temp file, so it is never partly written. */
	const save = (marks: ArchiveMarks) =>
		Effect.gen(function* () {
			const temp = `${path}.${process.pid}.tmp`;
			const text = yield* encodeFile(Object.fromEntries(marks)).pipe(Effect.orDie);
			yield* setAsideUnread;
			yield* fs.makeDirectory(path.slice(0, path.lastIndexOf('/')), { recursive: true });
			yield* fs.writeFileString(temp, `${text}\n`).pipe(
				Effect.andThen(fs.rename(temp, path)),
				Effect.onError(() => Effect.ignore(fs.remove(temp)))
			);
		}).pipe(Effect.mapError(fail));

	const marks = Result.getOrElse(initial, (): ArchiveMarks => new Map());
	return makeApi(yield* SubscriptionRef.make(marks), save);
});

export class Archive extends Context.Service<Archive, ArchiveApi>()('@ship/ui/Archive') {
	/** Marks kept in ship's home directory. */
	static readonly layer = Layer.effect(this, make);

	/** Marks kept in memory, starting from `initial`. */
	static readonly layerTest = (initial: ArchiveMarks = new Map()) =>
		Layer.effect(
			this,
			Effect.map(SubscriptionRef.make(initial), (ref) => makeApi(ref, () => Effect.void))
		);
}
