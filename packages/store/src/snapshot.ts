import type { Env, PersistedRunSnapshot } from '@ship/core';

/** Where a stripped `env` property sat, as keys from the snapshot root. */
export type EnvPath = ReadonlyArray<string>;

type Json = Record<string, unknown> | Array<unknown>;

const isContainer = (value: unknown): value is Json => typeof value === 'object' && value !== null;

/**
 * Returns a JSON copy of `snapshot` without any property named `env`, wherever it is, and
 * the paths it removed. The caller's env sits in `context.env` and can also be copied into
 * an invoked actor's input; removing it by name covers both.
 */
export const stripEnv = (
	snapshot: PersistedRunSnapshot
): { readonly json: string; readonly envPaths: ReadonlyArray<EnvPath> } => {
	const copy: unknown = JSON.parse(JSON.stringify(snapshot));
	const envPaths: Array<EnvPath> = [];
	const walk = (node: unknown, path: ReadonlyArray<string>): void => {
		if (!isContainer(node)) return;
		if (!Array.isArray(node) && 'env' in node) {
			delete node['env'];
			envPaths.push([...path, 'env']);
		}
		Object.entries(node).forEach(([key, child]) => walk(child, [...path, key]));
	};
	walk(copy, []);
	return { json: JSON.stringify(copy), envPaths };
};

/** Puts `env` back at every path `stripEnv` removed it from. Mutates `snapshot`. */
export const restoreEnv = (snapshot: unknown, envPaths: ReadonlyArray<EnvPath>, env: Env): void => {
	envPaths.forEach((path) => {
		const parent = path
			.slice(0, -1)
			.reduce<unknown>(
				(node, key) => (isContainer(node) ? Reflect.get(node, key) : undefined),
				snapshot
			);
		if (!isContainer(parent)) throw new Error(`No object at snapshot path ${path.join('.')}`);
		Reflect.set(parent, 'env', { ...env });
	});
};
