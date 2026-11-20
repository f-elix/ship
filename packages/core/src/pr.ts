import { Context, Effect, FileSystem, Layer, Schema } from 'effect';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, AgentCallCost, type AgentError, type TranscriptTarget } from './agent.ts';
import { baselineFailures } from './checks.ts';
import type { VerifiedFinding } from './finding.ts';
import { Gh, type GhError } from './gh.ts';
import type { GitRepo } from './git.ts';
import { planDirs } from './prompt.ts';
import type { CheckRound, EscalationReason, UnresolvedFindings } from './run.ts';
import type { GitSha } from './values.ts';

// --- Public types ---

/** The paths of a plan's `spec.md` and `implementation-plan.md`. */
export interface PlanPaths {
	readonly specPath: string;
	readonly planPath: string;
}

export interface OpenPrInput {
	/** The caller's repo; the branch must already be pushed (`Git.push`). */
	readonly repo: GitRepo;
	readonly branch: string;
	/** The branch to merge into, normally the default branch. */
	readonly base: string;
	/** The commit ship pushed; the PR's head must still be it once the agent is done. */
	readonly headSha: GitSha;
	/** The plan the change implements, or `null` for a change made without one. */
	readonly plan: PlanPaths | null;
	/** Check passes, for the body's evidence. */
	readonly checks: ReadonlyArray<CheckRound>;
	readonly unresolved: UnresolvedFindings;
	/** Set when the run escalated: the PR is a draft and lists the unresolved must-fix findings and nits. */
	readonly escalation: EscalationReason | null;
	/** The project's `pr.draft`. */
	readonly draft: boolean;
	/** The configured `pr` model. */
	readonly model: string;
	readonly timeoutMs: number;
	readonly transcript?: TranscriptTarget | undefined;
}

export interface OpenPrResult {
	readonly url: string;
	readonly draft: boolean;
	/** `false` when a PR for the branch already existed and was updated. */
	readonly created: boolean;
	readonly cost: AgentCallCost;
}

/**
 * The agent finished, but its PR is missing or has the wrong head, or adding ship's
 * sections to it failed. Carries the agent call's cost, which was paid all the same.
 */
export class PrPublishError extends Schema.TaggedError<PrPublishError>()('PrPublishError', {
	reason: Schema.String,
	cost: AgentCallCost,
	cause: Schema.optionalKey(Schema.Defect())
}) {
	override get message(): string {
		return `The pr agent finished, but ${this.reason}`;
	}
}

export interface PrShape {
	/**
	 * Has an agent open the PR, or update the open PR for the branch so a resumed run can
	 * repeat this step, by following the `pr` skill: the repository's own when it has one,
	 * ship's otherwise. Ship then adds its sections to the body. Escalated PRs are always
	 * drafts, and an existing ready PR is turned back into one. Only the agent call has a
	 * timeout; wrap the whole call in the step's timeout to bound the `gh` calls too.
	 */
	readonly open: (
		input: OpenPrInput
	) => Effect.Effect<OpenPrResult, AgentError | GhError | PrPublishError>;
}

// --- Skill ---

/**
 * The skills bundled with ship. The CLI build copies `src/skills` to `dist/skills`, so keep
 * this module directly in `src/`.
 */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url));

/** Where a repository keeps its own `pr` skill, which wins over ship's. */
const PROJECT_PR_SKILLS = ['.agents/skills/pr/SKILL.md', '.claude/skills/pr/SKILL.md'];

/** The `SKILL.md` the PR agent follows: the repository's own, or ship's. */
export const findPrSkill = Effect.fn('findPrSkill')(function* (cwd: string) {
	const fs = yield* FileSystem.FileSystem;
	for (const path of PROJECT_PR_SKILLS) {
		const absolute = join(cwd, path);
		if (yield* fs.exists(absolute).pipe(Effect.orElseSucceed(() => false))) return absolute;
	}
	return join(BUILTIN_SKILLS_DIR, 'pr', 'SKILL.md');
});

// --- Prompt ---

/**
 * Runs the skill unattended: ship settles what the skill would ask, and the agent does
 * the rest of its steps, its writes to GitHub included.
 */
export const prPrompt = (input: OpenPrInput, skillPath: string): string =>
	[
		`Open or update the pull request for this branch by following the \`pr\` skill at ${skillPath}. Read it first, with any file it points to.`,
		'',
		'Nobody is there to answer, so ship has settled what the skill would ask:',
		'',
		`- The branch is \`${input.branch}\`, already pushed at ${input.headSha}. Do not commit, push, rebase or rename it.`,
		`- The base is \`${input.base}\`.`,
		`- Open a new PR ${isDraft(input) ? 'as a draft' : 'ready for review'}.`,
		'- Ask nothing. Where the skill would wait for an answer, take its default, or leave out what it would ask for (reviewers, extra labels), and go on.',
		'- Do every other step the skill calls for, including its writes to GitHub, such as labels and comments.',
		'',
		...(input.plan === null
			? ['There is no spec or plan: the commits and the diff are the change.']
			: [`- Spec: ${input.plan.specPath}`, `- Implementation plan: ${input.plan.planPath}`]),
		'',
		'Latest checks:',
		'',
		checksEvidence(input.checks),
		'',
		`Once you finish, ship adds its own sections to the body, inside \`<!-- ship:… -->\` comments: the review findings left for a human and the checks that failed before the change. Do not list those yourself, and leave such sections in the current body as they are.`,
		'',
		"Answer with the PR's URL."
	].join('\n');

const isDraft = (input: Pick<OpenPrInput, 'draft' | 'escalation'>) =>
	input.draft || input.escalation !== null;

const checksEvidence = (checks: ReadonlyArray<CheckRound>): string => {
	const last = checks.at(-1);
	if (last === undefined) return '(no checks ran)';
	return last.results
		.map(
			(result) =>
				`- ${result.name}: ${result.exitCode === 0 ? 'passed' : `failed (exit ${result.exitCode})`}`
		)
		.join('\n');
};

// --- Body ---

const ESCALATION_TEXT: Record<EscalationReason, string> = {
	'check-fix-cap': 'checks still fail after the last check-fix attempt',
	'review-cap': 'must-fix findings or nits remain after the last review round',
	stall: 'a fix round left a must-fix finding unresolved',
	timeout: 'a step timed out'
};

/**
 * `body` with ship's parts in place of any an earlier run added: an escalation notice on
 * top; then, at the end, the checks that failed before the change and the review findings
 * left for a human, written by ship so none is lost or reworded. A finished run lists
 * only its tradeoffs; an escalated one also lists the must-fix findings and nits it left
 * unresolved.
 */
export const renderPrBody = (
	body: string,
	input: Pick<OpenPrInput, 'unresolved' | 'escalation' | 'checks'>
): string => {
	const notice =
		input.escalation === null
			? []
			: [
					`> [!WARNING]`,
					`> ship escalated this run: ${ESCALATION_TEXT[input.escalation]}. It needs a human before merging.`
				];
	const sections = [
		...preexistingSection(input.checks),
		...(input.escalation === null
			? []
			: [
					...findingsSection('Unresolved must-fix findings', input.unresolved.mustFix),
					...findingsSection('Unresolved nits', input.unresolved.nits)
				]),
		...findingsSection('Tradeoffs', input.unresolved.tradeoffs)
	];
	return [
		shipPart('notice', notice),
		body.replaceAll(SHIP_PARTS, '').trim(),
		shipPart('sections', sections)
	]
		.filter((part) => part !== '')
		.join('\n\n')
		.concat('\n');
};

/** A part of the body ship wrote, between comments so a later run can replace it. */
const SHIP_PARTS = /<!-- ship:(\w+) -->[\s\S]*?<!-- \/ship:\1 -->\n*/gu;

const shipPart = (name: string, lines: ReadonlyArray<string>) =>
	lines.length === 0
		? ''
		: [`<!-- ship:${name} -->`, ...lines, `<!-- /ship:${name} -->`].join('\n');

const indent = (text: string) => text.split('\n').join('\n  ');

const findingItem = (finding: VerifiedFinding) => {
	const location = `${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}`;
	const reviewers = [finding.reviewer, ...finding.alsoReportedBy].join(', ');
	return `- \`${location}\` (${reviewers}): ${indent(finding.claim)}\n  ${indent(finding.evidence)}`;
};

const findingsSection = (title: string, findings: ReadonlyArray<VerifiedFinding>) =>
	findings.length === 0 ? [] : [`## ${title}`, '', ...findings.map(findingItem), ''];

/** The checks that failed on the base commit, which ship did not hold the change to. */
const preexistingSection = (checks: ReadonlyArray<CheckRound>) => {
	const failing = baselineFailures(checks);
	if (failing.length === 0) return [];
	const last = checks.at(-1);
	const status = (name: string) =>
		last?.results.find((result) => result.name === name)?.exitCode === 0
			? 'passes now'
			: 'still fails';
	return [
		'## Checks failing before this change',
		'',
		'These failed on the base commit, so ship did not hold the change to them.',
		'',
		...failing.map((name) => `- ${name}: ${status(name)}`),
		''
	];
};

// --- Implementation ---

const make = Effect.gen(function* () {
	const agent = yield* Agent;
	const gh = yield* Gh;
	const fs = yield* FileSystem.FileSystem;

	const open = Effect.fn('Pr.open')(function* (input: OpenPrInput) {
		const { repo } = input;
		// Look up the PR first, so a `gh` failure (e.g. not logged in) happens before the
		// agent call is paid for.
		const existing = yield* gh.findPr(repo, input.branch);
		const skillPath = yield* findPrSkill(repo.cwd).pipe(
			Effect.provideService(FileSystem.FileSystem, fs)
		);
		const { cost } = yield* agent.run({
			step: input.escalation === null ? 'pr' : 'escalate',
			prompt: prPrompt(input, skillPath),
			model: input.model,
			// The skill runs `gh` and `git`, and may run the repository's own scripts.
			access: 'edit',
			cwd: repo.cwd,
			env: repo.env,
			additionalDirectories: [
				...(input.plan === null ? [] : planDirs(input.plan)),
				join(skillPath, '..')
			],
			timeoutMs: input.timeoutMs,
			transcript: input.transcript
		});
		const fail = (reason: string, cause?: unknown) =>
			new PrPublishError({ reason, cost, ...(cause === undefined ? {} : { cause }) });

		return yield* Effect.gen(function* () {
			const opened = yield* gh.findPr(repo, input.branch);
			if (opened === null) return yield* fail(`no PR is open for ${input.branch}`);
			const details = yield* gh.viewPr(repo, opened.url);
			if (details.headSha !== input.headSha) {
				return yield* fail(
					`the PR's head is ${details.headSha}, not ${input.headSha}, the commit ship pushed`
				);
			}
			const body = renderPrBody(details.body, input);
			if (body !== details.body) {
				yield* gh.editPr(repo, { url: opened.url, title: details.title, body });
			}
			if (input.escalation !== null && !opened.isDraft) {
				yield* gh.markDraft(repo, opened.url);
			}
			return {
				url: opened.url,
				draft: opened.isDraft || input.escalation !== null,
				created: existing === null,
				cost
			} satisfies OpenPrResult;
		}).pipe(Effect.catchTag('GhError', (error) => Effect.fail(fail(error.message, error))));
	});

	return Pr.of({ open });
});

/** Opens or updates the run's pull request. Needs `Agent`, `Gh` and `FileSystem`. */
export class Pr extends Context.Service<Pr, PrShape>()('@ship/core/Pr') {
	static readonly layer = Layer.effect(this, make);
}
