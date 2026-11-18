import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: { bin: 'src/bin.ts' },
	platform: 'node',
	format: 'esm',
	dts: false,
	// Workspace packages are private, so they are bundled; npm dependencies stay external.
	deps: { alwaysBundle: [/^@ship\//] },
	// Core resolves its built-in briefs next to the running module, `dist/briefs` once bundled.
	copy: [{ from: '../core/src/briefs', to: 'dist' }]
});
