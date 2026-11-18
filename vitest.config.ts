import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['packages/*/test/**/*.test.ts'],
		// Many tests run real git and shell processes; under a full parallel run they slow down.
		testTimeout: 15_000
	}
});
