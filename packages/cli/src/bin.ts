#!/usr/bin/env node
import pkg from '../package.json' with { type: 'json' };

const [command] = process.argv.slice(2);

if (command === '--version' || command === '-v') {
	process.stdout.write(`${pkg.version}\n`);
} else {
	process.stderr.write('Usage: ship --version\n');
	process.exitCode = 1;
}
