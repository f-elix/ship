import { Archive } from '#lib/server/archive.ts';
import { DeliverableId } from '#lib/server/deliverables.ts';
import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { ShipHome, shipPaths } from '@ship/core/contract';
import { Effect, Layer } from 'effect';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ID = DeliverableId.make('pr:https://github.com/f-elix/example/pull/7');

const tempHome = Effect.acquireRelease(
	Effect.promise(() => mkdtemp(join(tmpdir(), 'ship-ui-archive-'))),
	(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
);

const archiveIn = (home: string) =>
	Archive.layer.pipe(Layer.provide([ShipHome.layer(home), NodeServices.layer]));

describe('Archive', () => {
	it.live('keeps the marks in the home directory across restarts', () =>
		Effect.gen(function* () {
			const home = yield* tempHome;
			yield* Archive.use((archive) => archive.archive(ID)).pipe(
				Effect.provide(archiveIn(home))
			);

			const marks = yield* Archive.use((archive) => archive.current).pipe(
				Effect.provide(archiveIn(home))
			);
			expect(marks.get(ID)?.archived).toBe(true);
			const file = JSON.parse(
				yield* Effect.promise(() => readFile(shipPaths(home).uiArchive, 'utf8'))
			);
			expect(file[ID]).toMatchObject({ archived: true });
		}).pipe(Effect.scoped)
	);

	it.live('starts empty from a file it cannot read, and keeps that file on the next change', () =>
		Effect.gen(function* () {
			const home = yield* tempHome;
			const { uiArchive } = shipPaths(home);
			yield* Effect.promise(async () => {
				await mkdir(join(home, 'ui'));
				await writeFile(uiArchive, 'not json');
			});

			yield* Archive.use((archive) =>
				Effect.gen(function* () {
					expect((yield* archive.current).size).toBe(0);
					yield* archive.archive(ID);
					yield* archive.unarchive(ID);
				})
			).pipe(Effect.provide(archiveIn(home)));

			const files = yield* Effect.promise(() => readdir(join(home, 'ui')));
			const backups = files.filter((name) => name.endsWith('.bak'));
			expect(backups).toHaveLength(1);
			expect(
				yield* Effect.promise(() => readFile(join(home, 'ui', backups[0]!), 'utf8'))
			).toBe('not json');
			const file = JSON.parse(yield* Effect.promise(() => readFile(uiArchive, 'utf8')));
			expect(file[ID]).toMatchObject({ archived: false });
		}).pipe(Effect.scoped)
	);

	it.live('fails a change it cannot write, leaving no temp file behind', () =>
		Effect.gen(function* () {
			const home = yield* tempHome;
			const { uiArchive } = shipPaths(home);

			const error = yield* Archive.use((archive) =>
				Effect.gen(function* () {
					// A directory in the file's place: the temp file is written, the rename fails.
					yield* Effect.promise(() =>
						mkdir(join(uiArchive, 'taken'), { recursive: true })
					);
					return yield* Effect.flip(archive.archive(ID));
				})
			).pipe(Effect.provide(archiveIn(home)));

			expect(error._tag).toBe('ArchiveError');
			expect(yield* Effect.promise(() => readdir(join(home, 'ui')))).toEqual([
				'archive.json'
			]);
		}).pipe(Effect.scoped)
	);
});
