import type { Env } from '@ship/core/contract';
import { Config } from 'effect';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Ship's home directory: `SHIP_HOME` when set, else `~/.ship`. Tests point `SHIP_HOME` at a
 * temp dir. See `shipPaths` for the files inside it.
 */
export const shipHomeDir = Config.String('SHIP_HOME').pipe(
	Config.withDefault(join(homedir(), '.ship'))
);

/** This process's environment, without the variables that are declared but unset. */
export const processEnv = (): Env => {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
};
