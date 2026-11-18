/** Helpers shared by the prompts of the agent steps. */

/** `diff`, cut to `max` characters with a note saying so. */
export const truncateDiff = (diff: string, max: number): string =>
	diff.length <= max
		? diff
		: `${diff.slice(0, max)}\n… diff truncated after ${max} of ${diff.length} characters; read the changed files for the rest.`;

/** The directories holding the spec and the plan, which read-only agents may read. */
export const planDirs = (paths: { readonly specPath: string; readonly planPath: string }) => [
	...new Set(
		[paths.specPath, paths.planPath].map((path) => path.slice(0, path.lastIndexOf('/')) || '/')
	)
];
