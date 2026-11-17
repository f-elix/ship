import { configJsonSchemaFiles } from '@ship/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('../schemas/', import.meta.url));

mkdirSync(outDir, { recursive: true });
for (const [name, content] of Object.entries(configJsonSchemaFiles())) {
	writeFileSync(`${outDir}${name}`, content);
	process.stdout.write(`wrote packages/cli/schemas/${name}\n`);
}
