import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: { bin: 'src/bin.ts' },
	platform: 'node',
	format: 'esm',
	dts: false,
	// Workspace packages are private, so they are bundled; npm dependencies stay external.
	deps: { alwaysBundle: [/^@ship\//] },
	// Core resolves its built-in briefs, conventions and skills next to the running
	// module, `dist/briefs`, `dist/conventions` and `dist/skills` once bundled.
	copy: [
		{ from: '../core/src/briefs', to: 'dist' },
		{ from: '../core/src/conventions', to: 'dist' },
		{ from: '../core/src/skills', to: 'dist' },
		// The SvelteKit build of `ship ui`, which the build script makes first.
		{ from: '../ui/build', to: 'dist', rename: 'ui' }
	]
});
