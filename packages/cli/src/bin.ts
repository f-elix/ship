#!/usr/bin/env node
import pkg from '../package.json' with { type: 'json' };

const [command, subcommand] = process.argv.slice(2);

if (command === '--version' || command === '-v') {
	process.stdout.write(`${pkg.version}\n`);
} else if (command === 'daemon' && subcommand === 'serve') {
	// Hidden: the daemon process the CLI spawns detached. Loaded only when needed.
	const { runDaemon } = await import('@ship/daemon');
	runDaemon(pkg.version);
} else {
	process.stderr.write('Usage: ship --version\n');
	process.exitCode = 1;
}
