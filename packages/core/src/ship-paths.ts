import { Context, Layer } from 'effect';
import type { ProjectKey, RunId } from './primitives.ts';
import { projectKeySegments } from './project-key.ts';

/** The files a plan dir holds; `ship run` requires both. */
export const PLAN_FILES = { spec: 'spec.md', plan: 'implementation-plan.md' } as const;

/**
 * Where ship keeps its files under its home directory, normally `~/.ship`. A project key
 * becomes nested directories: `github.com/f-elix/ship` maps to
 * `projects/github.com/f-elix/ship.json` and `projects/github.com/f-elix/ship/reviewers/`.
 */
export const shipPaths = (home: string) => {
	const project = (key: ProjectKey) => [home, 'projects', ...projectKeySegments(key)].join('/');
	const runs = `${home}/runs`;
	const run = (runId: RunId) => `${runs}/${runId}`;
	return {
		home,
		globalConfig: `${home}/config.json`,
		projectConfig: (key: ProjectKey) => `${project(key)}.json`,
		projectReviewers: (key: ProjectKey) => `${project(key)}/reviewers`,
		db: `${home}/ship.db`,
		socket: `${home}/daemon.sock`,
		/** The daemon's process id: its claim on the home, written before it listens. */
		pidFile: `${home}/daemon.pid`,
		/** Where the daemon writes its log. */
		daemonLog: `${home}/daemon.log`,
		runs,
		run,
		transcripts: (runId: RunId) => `${run(runId)}/transcripts`
	};
};
export type ShipPaths = ReturnType<typeof shipPaths>;

/** Ship's home directory paths, for steps that read reviewers or write transcripts. */
export class ShipHome extends Context.Service<ShipHome, ShipPaths>()('@ship/core/ShipHome') {
	static readonly layer = (home: string) => Layer.succeed(this, shipPaths(home));
}
