#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const args = process.argv.slice(2);

if (args.length === 2 && args[0] === 'daemon' && args[1] === 'serve') {
	// Hidden: the daemon process the CLI spawns detached. Loaded only when needed.
	const { runDaemon } = await import('@ship/daemon');
	runDaemon(pkg.version);
} else {
	const { main } = await import('./main.ts');
	main({ version: pkg.version, binPath: fileURLToPath(import.meta.url), args });
}
