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
}

const make = (home: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const paths = shipPaths(home);

		const invalid = (path: string, detail: string) =>
			new ConfigError({ reason: 'invalid-config', path, detail });

		/** The file's JSON, or `undefined` when it does not exist. */
		const readJson = Effect.fnUntraced(function* (path: string) {
			const text = yield* fs.readFileString(path).pipe(
				Effect.map((content): string | undefined => content),
				Effect.catchTag('PlatformError', (error) =>
					error.reason._tag === 'NotFound'
						? Effect.succeed(undefined)
						: Effect.fail(invalid(path, error.message))
				)
			);
			if (text === undefined) return undefined;
			return yield* Effect.try({
				try: (): unknown => JSON.parse(text),
				catch: (error) => invalid(path, `Invalid JSON: ${String(error)}`)
			});
		});

		const globalPath = paths.globalConfig;
		const loadGlobal = Effect.gen(function* () {
			return yield* decodeGlobalConfig((yield* readJson(globalPath)) ?? {}).pipe(
				Effect.mapError((error) => invalid(globalPath, error.message))
			);
		}).pipe(Effect.withSpan('ConfigLoader.loadGlobal'));

		const load = Effect.fn('ConfigLoader.load')(function* (key: ProjectKey) {
			const global = yield* loadGlobal;

			const projectPath = paths.projectConfig(key);
			const projectJson = yield* readJson(projectPath);
			if (projectJson === undefined) {
				return yield* new ConfigError({
					reason: 'unknown-project-config',
					path: projectPath,
					detail: `No config for project ${key}`
				});
			}
			const project = yield* decodeProjectConfig(projectJson).pipe(
				Effect.mapError((error) => invalid(projectPath, error.message))
			);

			const unknownLocks = checksWithUnknownLock(global, project);
			if (unknownLocks.length > 0) {
				const names = unknownLocks
					.map((check) => `${check.name} (${check.lock})`)
					.join(', ');
				return yield* invalid(
					projectPath,
					`Checks use lock resources with no permits in ${globalPath}: ${names}`
				);
			}

			return { global, project, resolved: resolveConfig(global, project) };
		});

		return ConfigLoader.of({ paths, loadGlobal, load });
	});

/** Loads ship's config files from its home directory. */
export class ConfigLoader extends Context.Service<ConfigLoader, ConfigLoaderShape>()(
	'@ship/core/ConfigLoader'
) {
	/** Reads config from `home`, normally `~/.ship`. */
	static readonly layer = (home: string) => Layer.effect(this, make(home));
}
