import { Context, Effect, FileSystem, Layer, Schema } from 'effect';
import {
	checksWithUnknownLock,
	decodeGlobalConfig,
	decodeProjectConfig,
	resolveConfig,
	type GlobalConfig,
	type ProjectConfig,
	type ResolvedConfig
} from './config.ts';
import type { ProjectKey } from './primitives.ts';
import { PreconditionReason } from './rpc.ts';
import { shipPaths, type ShipPaths } from './ship-paths.ts';

/**
 * A config file is missing or invalid. `reason` uses the `PreconditionFailed` reasons, so
 * the daemon can pass it on as is.
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()('ConfigError', {
	reason: PreconditionReason.pick(['unknown-project-config', 'invalid-config']),
	path: Schema.String,
	detail: Schema.String
}) {}

export interface LoadedConfig {
	readonly global: GlobalConfig;
	readonly project: ProjectConfig;
	readonly resolved: ResolvedConfig;
}

export interface ConfigLoaderShape {
	readonly paths: ShipPaths;
	/**
	 * Reads and validates the global config, with all defaults when the file is absent. The
	 * daemon builds its lock semaphores from it at startup.
	 */
	readonly loadGlobal: Effect.Effect<GlobalConfig, ConfigError>;
	/**
	 * Reads and validates the global config (all defaults when the file is absent) and the
	 * project's config (required), and resolves them. Fails when a check's lock resource
	 * has no permits in the global config.
	 */
	readonly load: (key: ProjectKey) => Effect.Effect<LoadedConfig, ConfigError>;
	/**
	 * Like `load`, but a missing project config reads as `{}`: the built-in reviewers and
	 * the global models and timeouts. `ship review` needs no project setup.
	 */
	readonly loadOrDefaults: (key: ProjectKey) => Effect.Effect<LoadedConfig, ConfigError>;
	/**
	 * Validates the text of a project config as `load` does, against the global config, and
	 * returns it decoded. `path` only labels the errors. Every schema issue is reported, not
	 * only the first.
	 */
	readonly validateProject: (
		text: string,
		path: string
	) => Effect.Effect<ProjectConfig, ConfigError>;
}

const make = (home: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const paths = shipPaths(home);

		const invalid = (path: string, detail: string) =>
			new ConfigError({ reason: 'invalid-config', path, detail });

		/** The file's text, or `undefined` when it does not exist. */
		const readText = (path: string) =>
			fs.readFileString(path).pipe(
				Effect.map((content): string | undefined => content),
				Effect.catchTag('PlatformError', (error) =>
					error.reason._tag === 'NotFound'
						? Effect.succeed(undefined)
						: Effect.fail(invalid(path, error.message))
				)
			);

		const parseJson = (path: string, text: string) =>
			Effect.try({
				try: (): unknown => JSON.parse(text),
				catch: (error) => invalid(path, `Invalid JSON: ${String(error)}`)
			});

		/** The file's JSON, or `undefined` when it does not exist. */
		const readJson = Effect.fnUntraced(function* (path: string) {
			const text = yield* readText(path);
			return text === undefined ? undefined : yield* parseJson(path, text);
		});

		const globalPath = paths.globalConfig;
		const loadGlobal = Effect.gen(function* () {
			return yield* decodeGlobalConfig((yield* readJson(globalPath)) ?? {}).pipe(
				Effect.mapError((error) => invalid(globalPath, error.message))
			);
		}).pipe(Effect.withSpan('ConfigLoader.loadGlobal'));

		const validate = Effect.fnUntraced(function* (
			global: GlobalConfig,
			text: string,
			path: string
		) {
			const project = yield* decodeProjectConfig(yield* parseJson(path, text)).pipe(
				Effect.mapError((error) => invalid(path, error.message))
			);
			const unknownLocks = checksWithUnknownLock(global, project);
			if (unknownLocks.length > 0) {
				const names = unknownLocks
					.map((check) => `${check.name} (${check.lock})`)
					.join(', ');
				const example = JSON.stringify(
					Object.fromEntries(unknownLocks.map((check) => [check.lock, 1]))
				);
				return yield* invalid(
					path,
					`Checks use lock resources with no permits in ${globalPath}: ${names}. Add them there, e.g. "locks": ${example}, then run \`ship daemon restart\`; or use another lock.`
				);
			}
			return project;
		});

		/** Loads the configs; `missing` is the project config's text when it has no file. */
		const loadWith = Effect.fnUntraced(function* (key: ProjectKey, missing: string | null) {
			const global = yield* loadGlobal;

			const projectPath = paths.projectConfig(key);
			const text = (yield* readText(projectPath)) ?? missing;
			if (text === null) {
				return yield* new ConfigError({
					reason: 'unknown-project-config',
					path: projectPath,
					detail: `No config for project ${key}`
				});
			}
			const project = yield* validate(global, text, projectPath);
			return { global, project, resolved: resolveConfig(global, project) };
		});

		const load = Effect.fn('ConfigLoader.load')(function* (key: ProjectKey) {
			return yield* loadWith(key, null);
		});

		const loadOrDefaults = Effect.fn('ConfigLoader.loadOrDefaults')(function* (
			key: ProjectKey
		) {
			return yield* loadWith(key, '{}');
		});

		const validateProject = Effect.fn('ConfigLoader.validateProject')(function* (
			text: string,
			path: string
		) {
			return yield* validate(yield* loadGlobal, text, path);
		});

		return ConfigLoader.of({ paths, loadGlobal, load, loadOrDefaults, validateProject });
	});

/** Loads ship's config files from its home directory. */
export class ConfigLoader extends Context.Service<ConfigLoader, ConfigLoaderShape>()(
	'@ship/core/ConfigLoader'
) {
	/** Reads config from `home`, normally `~/.ship`. */
	static readonly layer = (home: string) => Layer.effect(this, make(home));
}
