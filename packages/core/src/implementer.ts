/**
 * The implementer steps, `implement` and `fix`, and the implementer call they share
 * with `checks`, which runs the implementer between passes to fix failing checks.
 */
import { Effect, Schema } from 'effect';
import { agentContext } from './agent-context.ts';
import {
	Agent,
	type AgentCallCost,
	type AgentError,
	type AgentRunInput,
	type AgentShape
} from './agent.ts';
import { Checks, filesForChecks } from './checks.ts';
import { Conventions, implementerConventionsSection } from './conventions.ts';
import { VerifiedFinding } from './finding.ts';
import { Git } from './git.ts';
import { ChangeIntent } from './reviewers.ts';
import type { StepKit } from './run-step.ts';
import { AgentSession, CommitSubject } from './run.ts';
import { PLAN_FILES } from './ship-paths.ts';
import { stepScopeFields, type StepScope } from './step-scope.ts';
import type { Step } from './step.ts';
import { AbsolutePath, type StepName } from './values.ts';

// --- Plans ---

/** What a ship run's reviewers check the change against: its spec and plan. */
export const planIntent = (planDir: string) =>
	ChangeIntent.cases.Plan.make({
		specPath: `${planDir}/${PLAN_FILES.spec}`,
		planPath: `${planDir}/${PLAN_FILES.plan}`
	});

/** The plan's name: its directory's name. */
export const planName = (planDir: string): string => planDir.slice(planDir.lastIndexOf('/') + 1);

// --- The implementer call ---

/** What every implementer call reads: where it works, and the session it resumes. */
export const implementerFields = {
	...stepScopeFields,
	/**
	 * The plan the work comes from; the implementer may read its dir. `null` for work
	 * with no plan.
	 */
	planDir: Schema.NullOr(AbsolutePath),
	/** The implementer session to resume; `null` starts a new one. */
	session: Schema.NullOr(AgentSession)
};

/** The input of every implementer call. */
export interface ImplementerScope extends StepScope {
	readonly planDir: string | null;
	readonly session: AgentSession | null;
}

/** Runs the project's format command on the run's changed files, if it has one. */
const formatChanges = Effect.fnUntraced(function* (scope: StepScope) {
	if (scope.config.format === null) return;
	const git = yield* Git;
	const checks = yield* Checks;
	const changed = yield* git.changedFiles(scope, { from: scope.baseSha });
	const result = yield* checks.format({
		cwd: scope.cwd,
		env: scope.env,
		command: scope.config.format,
		files: filesForChecks(changed)
	});
	if (result !== null && result.exitCode !== 0) {
		yield* Effect.logWarning(`The format command exited with ${result.exitCode}`);
	}
});

/** What an implementer call produced: its session and cost, and the call's answer. */
interface ImplementerReply<A> {
	readonly session: AgentSession;
	readonly cost: AgentCallCost;
	readonly value: A;
}

type ImplementerAsk<A> = (
	agent: AgentShape,
	input: AgentRunInput
) => Effect.Effect<ImplementerReply<A>, AgentError>;

/** An implementer call whose answer is only its work on the tree. */
const askPlain: ImplementerAsk<void> = (agent, input) =>
	Effect.map(agent.run(input), (result) => ({
		session: result.session,
		cost: result.cost,
		value: undefined
	}));

/** What `implement` answers alongside its work. */
const ImplementAnswer = Schema.Struct({ commitSubject: CommitSubject });

/**
 * Asks the implementer for its work and a commit subject. A missing or invalid subject
 * does not fail the call: it is still billed and its session kept, and the subject is
 * `null` so the commit falls back to the default message.
 */
const askWithSubject: ImplementerAsk<CommitSubject | null> = (agent, input) =>
	agent.runStructured(input, ImplementAnswer).pipe(
		Effect.map((result): ImplementerReply<CommitSubject | null> => ({
			session: result.session,
			cost: result.cost,
			value: result.output.commitSubject
		})),
		Effect.catchTag('AgentOutputMismatch', (error) =>
			error.spend === undefined
				? Effect.fail(error)
				: Effect.as(
						Effect.logWarning(
							`The implementer gave no valid commit subject: ${error.detail}`
						),
						{ session: error.spend.session, cost: error.spend.cost, value: null }
					)
		)
	);

/**
 * One implementer call, reported as `step`: resumes `input.session` when there is one,
 * records the call's cost and new session, then formats the changes. `prompt` places the
 * conventions section, picked by the repo's stack. Returns the call's answer and its
 * session, which the next implementer call resumes.
 */
export const implementerCall = <A>(
	step: Extract<StepName, 'implement' | 'fixChecks' | 'fix'>,
	input: ImplementerScope,
	kit: StepKit,
	prompt: (conventions: string) => string,
	ask: ImplementerAsk<A>
) =>
	Effect.gen(function* () {
		const agent = yield* Agent;
		const conventions = yield* (yield* Conventions).scope({ repo: input });
		const context = yield* agentContext(input);
		const reply = yield* ask(agent, {
			step,
			prompt: prompt(implementerConventionsSection(conventions)),
			model: step === 'implement' ? input.config.models.implement : input.config.models.fix,
			access: 'edit',
			...(input.session === null ? {} : { resume: input.session }),
			cwd: context.cwd,
			env: context.env,
			additionalDirectories: [
				...(input.planDir === null ? [] : [input.planDir]),
				conventions.dir
			],
			timeoutMs: input.config.timeouts[step],
			transcript: context.transcript
		});
		yield* kit.recordCost(reply.cost);
		yield* kit.recordSession(reply.session);
		yield* formatChanges(input);
		return { value: reply.value, session: reply.session };
	});

/** The rules every implementer prompt ends with. */
export const IMPLEMENTER_RULES = [
	'- Work in the current directory on the current branch.',
	'- Leave your changes uncommitted; ship commits them after the checks pass.',
	'- Never edit or commit the spec or the plan.',
	'- If part of the work is already done, for example by an earlier interrupted attempt, continue from it.'
].join('\n');

/** The prompt of a check-fix call, for the failing results of the latest pass. */
export const fixChecksPrompt =
	(
		failing: ReadonlyArray<{
			readonly name: string;
			readonly exitCode: number;
			readonly outputTail?: string;
		}>
	) =>
	(conventions: string): string =>
		[
			'These checks fail after your changes. Fix the causes in the code; never weaken or skip a check.',
			'',
			...failing.flatMap((result) => [
				`## ${result.name} (exit code ${result.exitCode})`,
				'',
				'```',
				result.outputTail ?? '',
				'```',
				''
			]),
			IMPLEMENTER_RULES,
			'',
			conventions
		].join('\n');

/** A check-fix call: the implementer fixes what the failing checks report. */
export const fixChecksCall = (
	input: ImplementerScope,
	kit: StepKit,
	failing: Parameters<typeof fixChecksPrompt>[0]
) => implementerCall('fixChecks', input, kit, fixChecksPrompt(failing), askPlain);

// --- implement ---

export const ImplementInput = Schema.Struct({
	...implementerFields,
	planDir: AbsolutePath
});
export interface ImplementInput extends Schema.Schema.Type<typeof ImplementInput> {}

/**
 * `implement`: the implementer works through the plan in `planDir`. Returns the commit
 * subject it wrote, or `null` when it gave no valid one. It leaves the work uncommitted:
 * `checks` commits it once the checks pass.
 */
export const implementStep = {
	name: 'implement',
	input: ImplementInput,
	output: Schema.NullOr(CommitSubject),
	timeoutMs: (config) => config.timeouts.implement,
	run: (input, kit) => {
		const intent = planIntent(input.planDir);
		return Effect.map(
			implementerCall(
				'implement',
				input,
				kit,
				(conventions) =>
					[
						'Implement the planned change described by these files:',
						'',
						`- Spec: ${intent.specPath}`,
						`- Implementation plan: ${intent.planPath}`,
						'',
						'Read both, then implement the whole plan, with tests where the plan or the project calls for them.',
						'',
						IMPLEMENTER_RULES,
						'',
						conventions,
						'',
						'When you are done, answer with `commitSubject`: the subject line of the commit for this change. Write it in the imperative mood, at most 72 characters, with no trailing period, saying what the change does (e.g. "Add retry to webhook delivery").'
					].join('\n'),
				askWithSubject
			),
			(reply) => reply.value
		);
	}
} satisfies Step<ImplementInput, CommitSubject | null, unknown>;

// --- fix ---

export const FixInput = Schema.Struct({
	...implementerFields,
	mustFix: Schema.Array(VerifiedFinding),
	nits: Schema.Array(VerifiedFinding)
});
export interface FixInput extends Schema.Schema.Type<typeof FixInput> {}

const describeFinding = (finding: VerifiedFinding): string =>
	[
		`## ${finding.id}: ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}`,
		'',
		finding.claim,
		'',
		`Evidence: ${finding.evidence}`
	].join('\n');

/** A heading and the findings under it; nothing when there are none. */
const findingsSection = (
	heading: string,
	findings: ReadonlyArray<VerifiedFinding>
): ReadonlyArray<string> =>
	findings.length === 0 ? [] : [`# ${heading}`, '', ...findings.map(describeFinding), ''];

/**
 * `fix`: the implementer fixes the given must-fix findings and nits, each verified against
 * the code. Like `implement`, it leaves the work for `checks` to commit.
 */
export const fixStep = {
	name: 'fix',
	input: FixInput,
	output: Schema.Void,
	timeoutMs: (config) => config.timeouts.fix,
	run: (input, kit) =>
		Effect.asVoid(
			implementerCall(
				'fix',
				input,
				kit,
				(conventions) =>
					[
						'Reviewers found these problems in your changes, and each was verified against the code. Fix every one, the nits included.',
						'',
						...findingsSection('Must-fix', input.mustFix),
						...findingsSection('Nits', input.nits),
						IMPLEMENTER_RULES,
						'',
						conventions
					].join('\n'),
				askPlain
			)
		)
} satisfies Step<FixInput, void, unknown>;
