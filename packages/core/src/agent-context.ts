import { Effect } from 'effect';
import type { AgentContext } from './reviewers.ts';
import { ShipHome } from './ship-paths.ts';
import type { StepScope } from './step-scope.ts';

/** Where a run's agents work, and where their transcripts go. */
export const agentContext = Effect.fnUntraced(function* (
	scope: Pick<StepScope, 'runId' | 'cwd' | 'env'>
) {
	const home = yield* ShipHome;
	return {
		cwd: scope.cwd,
		env: scope.env,
		transcript: { dir: home.transcripts(scope.runId) }
	} satisfies AgentContext;
});
