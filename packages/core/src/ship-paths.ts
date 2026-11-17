import type { ProjectKey, RunId } from './primitives.ts';
import { projectKeySegments } from './project-key.ts';

/**
 * Where ship keeps its files under its home directory, normally `~/.ship`. A project key
 * becomes nested directories: `github.com/f-elix/ship` maps to
 * `projects/github.com/f-elix/ship.json` and `projects/github.com/f-elix/ship/reviewers/`.
 */
export const shipPaths = (home: string) => {
	const project = (key: ProjectKey) => [home, 'projects', ...projectKeySegments(key)].join('/');
	const run = (runId: RunId) => `${home}/runs/${runId}`;
	return {
		home,
		globalConfig: `${home}/config.json`,
		projectConfig: (key: ProjectKey) => `${project(key)}.json`,
		projectReviewers: (key: ProjectKey) => `${project(key)}/reviewers`,
		db: `${home}/ship.db`,
		socket: `${home}/daemon.sock`,
		run,
		transcripts: (runId: RunId) => `${run(runId)}/transcripts`,
		/** Temporary worktree at the base commit for the baseline checks. */
		baseline: (runId: RunId) => `${run(runId)}/baseline`
	};
};
export type ShipPaths = ReturnType<typeof shipPaths>;
