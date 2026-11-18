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
