/**
 * The fields every step's input starts with. Kept apart from `step.ts` so run
 * contexts can build on them without importing the step machinery.
 */
import { Schema } from 'effect';
import { ResolvedConfig } from './config.ts';
import { AbsolutePath, Env, GitSha, ProjectKey, RunId } from './values.ts';

/**
 * What every step's input holds: the run it belongs to, where it works and the range
 * it starts from. Each step's input adds its own fields to these.
 */
export const stepScopeFields = {
	runId: RunId,
	projectKey: ProjectKey,
	/** The checkout the step works in; ship never creates or removes one. */
	cwd: AbsolutePath,
	env: Env,
	/** Where the run's range starts: the branch's base, or a PR's merge base. */
	baseSha: GitSha,
	/** Resolved when the run is created; later config edits do not change it. */
	config: ResolvedConfig
};

export const StepScope = Schema.Struct(stepScopeFields);
export interface StepScope extends Schema.Schema.Type<typeof StepScope> {}
