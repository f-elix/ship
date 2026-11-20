import type * as Core from '@ship/core/conventions';
import { Git } from '@ship/core/init';
import { Console, Effect, FileSystem, Layer, Option } from 'effect';
import { Argument, Command } from 'effect/cli';
import { cliError } from './connection.ts';
import { Invocation } from './invocation.ts';

/** Prints each file whole, tagged with its path so the links inside it resolve. */
const printFiles = (files: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		for (const path of files) {
			const text = yield* fs.readFileString(path);
			yield* Console.log(`<file path="${path}">\n${text.trimEnd()}\n</file>\n`);
		}
	});

/** The design conventions that apply to the repo, then an index of the others. */
const printDesign = ({
	Conventions,
	designConventionFiles,
	otherConventions,
	REPO_RULES_WIN
}: typeof Core) =>
	Effect.gen(function* () {
		const invocation = yield* Invocation;
		const conventions = yield* Conventions;
		const scope = yield* conventions
			.scope({ repo: { cwd: invocation.cwd, env: invocation.env } })
			.pipe(
				Effect.mapError((error) =>
					cliError(
						`cannot find the git repo of ${invocation.cwd} (${error.message}); run \`ship conventions\` inside the project`
					)
				)
			);
		yield* printFiles(designConventionFiles(scope));
		const others = otherConventions(scope);
		if (others.length > 0) {
			yield* Console.log(
				[
					'Other conventions apply to this repo. Print one with `ship conventions <topic>` once the discussion reaches it:',
					'',
					...others.map((topic) => `- ${topic.name}: ${topic.description}`),
					''
				].join('\n')
			);
		}
		yield* Console.log(REPO_RULES_WIN);
	});

/** One topic, base then details, or one reference, whatever the repo's stack. */
const printTopic = ({ Conventions, conventionFiles }: typeof Core, entry: string) =>
	Effect.gen(function* () {
		const { dir, topics } = yield* Conventions;
		const files = conventionFiles({ dir, topics }, entry);
		const fs = yield* FileSystem.FileSystem;
		if (files.length === 0 || !(yield* fs.exists(files[0]!))) {
			const names = topics.map((topic) => topic.name).join(', ');
			return yield* cliError(`no convention named "${entry}"; the topics are ${names}`);
		}
		yield* printFiles(files);
	});

export const conventions = Command.make(
	'conventions',
	{
		topic: Argument.String('topic').pipe(
			Argument.withDescription(
				'A topic, e.g. `effect`, or a reference, e.g. `references/testing`, to print in full'
			),
			Argument.optional
		)
	},
	Effect.fn('ship.conventions')(function* ({ topic }) {
		// Loaded on use: parsing the conventions' frontmatter pulls in `yaml`, which other
		// commands should not load at startup.
		const core = yield* Effect.promise(() => import('@ship/core/conventions'));
		const run = Option.match(topic, {
			onNone: () => printDesign(core),
			onSome: (entry) => printTopic(core, entry)
		});
		yield* run.pipe(
			Effect.provide(core.Conventions.layer.pipe(Layer.provideMerge(Git.layer))),
			Effect.catchTag('ConventionFileError', (error) => Effect.fail(cliError(error.message))),
			Effect.catchTag('PlatformError', (error) => Effect.fail(cliError(error.message)))
		);
	})
).pipe(
	Command.withDescription(
		"Print ship's design conventions that apply to this repo, for planning or discussing a change, and list the other topics; `ship conventions <topic>` prints one of them."
	)
);
