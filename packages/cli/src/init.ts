import type { CheckEvent, ChecksAborted } from '@ship/core/contract';
import {
	ConfigLoader,
	detectProjectConfig,
	Git,
	PROJECT_SCHEMA_URL,
	projectFilesAt,
	type ProjectConfig
} from '@ship/core/init';
import { Console, Effect, FileSystem, Option, Predicate, Result, Stream } from 'effect';
import { Command, Flag } from 'effect/cli';
import { dirname, resolve } from 'node:path';
import { cliError, connectDaemon } from './connection.ts';
import { setExitCode } from './exit-code.ts';
import { Invocation } from './invocation.ts';
import { seconds } from './render.ts';

/** Lines of a failing check's output shown by `ship init --write`. */
const TAIL_LINES = 20;

const indent = (text: string, prefix = '  ') =>
	text
		.split('\n')
		.map((line) => `${prefix}${line}`)
		.join('\n');

/** The invocation's repo and the paths in ship's home. */
const context = Effect.gen(function* () {
	const invocation = yield* Invocation;
	const loader = yield* ConfigLoader;
	return { invocation, paths: loader.paths, repo: { cwd: invocation.cwd, env: invocation.env } };
});

const detect = Effect.gen(function* () {
	const { invocation, paths, repo } = yield* context;
	const git = yield* Git;
	const files = yield* projectFilesAt(invocation.cwd);
	const detection = yield* detectProjectConfig(files).pipe(
		Effect.mapError((error) => cliError(`cannot read the project's files: ${error.message}`))
	);
	yield* Console.log(JSON.stringify(detection.config, null, '\t'));

	const notes = [...detection.notes];
	const located = yield* Effect.all([git.projectKey(repo), git.repoRoot(repo)]).pipe(
		Effect.result
	);
	if (Result.isSuccess(located)) {
		const [key, root] = located.success;
		yield* Console.error(
			`ship: project ${key}; \`ship init --write\` saves to ${paths.projectConfig(key)}`
		);
		if (root !== invocation.cwd) {
			notes.unshift(
				`Detected in ${invocation.cwd}, not the repo root ${root}; checks run where \`ship run\` is started.`
			);
		}
	} else {
		notes.unshift(
			`cannot find the git repo of ${invocation.cwd} (${located.failure.message}); \`ship init --write\` and \`ship run\` need one.`
		);
	}
	for (const note of notes) yield* Console.error(`note: ${note}`);
});

/**
 * Reads the config file and validates it as a run would load it. Returns it decoded, and
 * its fields as written (defaults left out) without `$schema`, which is replaced.
 */
const readConfigFile = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const loader = yield* ConfigLoader;
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.mapError((error) => cliError(`cannot read ${path}: ${error.message}`)));
		const config = yield* loader.validateProject(text, path).pipe(
			Effect.mapError((error) =>
				cliError(
					// The global config, which holds the lock permits, is checked first.
					`${error.path} is not a valid ${error.path === path ? 'project' : 'global'} config:\n${indent(error.detail)}`
				)
			)
		);
		const json: unknown = JSON.parse(text);
		const fields = Predicate.isObject(json) ? Object.entries(json) : [];
		return { fields: fields.filter(([key]) => key !== '$schema'), config };
	});

type CheckOutcome = Extract<CheckEvent, { readonly _tag: 'CheckFinished' }>;

const lastLines = (text: string, count: number) => text.split('\n').slice(-count).join('\n');

/**
 * One line per check, in config order, failing checks followed by the end of their output.
 * A check with no outcome was skipped for using `{files}`, unless the pass had stopped.
 */
const report = (
	config: ProjectConfig,
	outcomes: ReadonlyArray<CheckOutcome>,
	abort: ChecksAborted | null
) => {
	let stopped = false;
	return config.checks
		.map((check) => {
			const outcome = outcomes.find((candidate) => candidate.check === check.name);
			if (abort !== null && check.name === abort.check) {
				stopped = true;
				return `stopped ${check.name}: ${abort.detail}`;
			}
			if (outcome === undefined) {
				return stopped ? `not run ${check.name}` : `skipped ${check.name}: it uses {files}`;
			}
			if (outcome.exitCode === 0) {
				return `passed  ${check.name} (${seconds(outcome.durationMs)})`;
			}
			const head = `failed  ${check.name}: exit code ${outcome.exitCode} (${seconds(outcome.durationMs)})`;
			return outcome.outputTail === ''
				? head
				: `${head}\n${indent(lastLines(outcome.outputTail, TAIL_LINES), '    ')}`;
		})
		.join('\n');
};

/** Runs the saved config's checks through the daemon, so they share its lock permits. */
const runChecks = (config: ProjectConfig) =>
	Effect.gen(function* () {
		const { repo } = yield* context;
		const { rpc } = yield* connectDaemon();
		const outcomes: Array<CheckOutcome> = [];
		const onEvent = (event: CheckEvent) => {
			switch (event._tag) {
				case 'CheckStarted':
					return Console.error(`ship: running ${event.check}: ${event.commandLine}`);
				case 'LockWaiting':
					return Console.error(
						`ship: ${event.check} is waiting for lock ${event.resource}`
					);
				case 'CheckFinished':
					outcomes.push(event);
					return Effect.void;
				default:
					return Effect.void;
			}
		};
		const abort = yield* rpc.runChecks(repo).pipe(
			Stream.runForEach(onEvent),
			Effect.as<ChecksAborted | null>(null),
			Effect.catchTags({
				PreconditionFailed: (error) =>
					Effect.fail(
						cliError(
							`cannot run the checks (${error.reason}): ${error.detail}. The config is saved; \`ship init --write <file> --force\` runs them again.`
						)
					),
				ChecksAborted: (error) => Effect.succeed(error)
			})
		);
		yield* Console.log(report(config, outcomes, abort));
		const failed = outcomes.filter((outcome) => outcome.exitCode !== 0).length;
		if (failed > 0 || abort !== null) {
			const problems = [
				...(failed > 0 ? [`${failed} of ${outcomes.length} checks failed`] : []),
				...(abort === null ? [] : [`the checks stopped: ${abort.detail}`])
			];
			yield* Console.error(
				`ship: ${problems.join('; ')}. The config is saved; \`ship run\` fails at its baseline until every check passes.`
			);
			yield* setExitCode(1);
		}
	}).pipe(Effect.scoped);

const write = (file: string, force: boolean) =>
	Effect.gen(function* () {
		const { invocation, paths, repo } = yield* context;
		const fs = yield* FileSystem.FileSystem;
		const git = yield* Git;
		const { fields, config } = yield* readConfigFile(resolve(invocation.cwd, file));

		const key = yield* git
			.projectKey(repo)
			.pipe(
				Effect.mapError((error) =>
					cliError(
						`cannot find the git repo of ${invocation.cwd} (${error.message}); run \`ship init\` inside the project`
					)
				)
			);
		const target = paths.projectConfig(key);
		if (!force && (yield* fs.exists(target))) {
			return yield* cliError(`${target} already exists; pass --force to replace it`);
		}
		yield* fs.makeDirectory(dirname(target), { recursive: true });
		yield* fs.writeFileString(
			target,
			`${JSON.stringify(Object.fromEntries([['$schema', PROJECT_SCHEMA_URL], ...fields]), null, '\t')}\n`
		);
		yield* Console.error(`ship: saved the config of ${key} to ${target}`);

		if (config.checks.length === 0) {
			yield* Console.error('ship: the config has no checks to run');
			return;
		}
		yield* runChecks(config);
	});

export const init = Command.make(
	'init',
	{
		detect: Flag.Boolean('detect').pipe(
			Flag.withDescription(
				'Print a draft project config, detected from the current directory, on stdout; the project key and notes go to stderr'
			),
			Flag.withDefault(false)
		),
		write: Flag.String('write').pipe(
			Flag.withMetavar('file'),
			Flag.withDescription(
				"Validate the config in <file>, save it as this project's config, then run every check once"
			),
			Flag.optional
		),
		force: Flag.Boolean('force').pipe(
			Flag.withDescription('With --write, replace an existing project config'),
			Flag.withDefault(false)
		)
	},
	Effect.fn('ship.init')(function* ({ detect: detecting, write: file, force }) {
		const invocation = yield* Invocation;
		const run =
			detecting && Option.isNone(file)
				? detect
				: !detecting && Option.isSome(file)
					? write(file.value, force)
					: Effect.fail(cliError('pass either --detect or --write <file>'));
		yield* run.pipe(
			Effect.provide([Git.layer, ConfigLoader.layer(invocation.home)]),
			Effect.catchTag('PlatformError', (error) => Effect.fail(cliError(error.message)))
		);
	})
).pipe(
	Command.withDescription(
		"Set up this project's config: `--detect` drafts it, `--write <file>` saves it and runs every check once, exiting 1 when one fails."
	)
);
