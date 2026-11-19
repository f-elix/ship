import { Context, Effect, Layer, Schema } from 'effect';
import { Agent, AgentCallCost, type AgentError, type TranscriptTarget } from './agent.ts';
import type { VerifiedFinding } from './finding.ts';
import { Gh, GhError } from './gh.ts';
import type { Commit, GitRepo } from './git.ts';
import { planDirs, truncateDiff } from './prompt.ts';
import type { CheckRound, EscalationReason, UnresolvedFindings } from './run.ts';

/** How much of the branch diff the PR agent sees; it has the repo to read the rest. */
const MAX_PR_DIFF_CHARS = 100_000;

// --- Public types ---

export interface OpenPrInput {
	/** The caller's repo; the branch must already be pushed (`Git.push`). */
	readonly repo: GitRepo;
	readonly branch: string;
	/** The branch to merge into, normally the default branch. */
	readonly base: string;
	/** The diff of the whole branch, `base..HEAD`. */
	readonly diff: string;
	/** The branch's commits, oldest first. */
	readonly commits: ReadonlyArray<Commit>;
	/** Absolute paths of the plan's `spec.md` and `implementation-plan.md`. */
	readonly specPath: string;
	readonly planPath: string;
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
	/** `false` when a PR for the branch already existed and its body was updated. */
	readonly created: boolean;
	readonly cost: AgentCallCost;
}

/**
 * `gh` failed after the agent wrote the PR text. Carries the agent call's cost, which was
 * paid even though no PR was opened or updated.
 */
export class PrPublishError extends Schema.TaggedError<PrPublishError>()('PrPublishError', {
	gh: GhError,
	cost: AgentCallCost
}) {
	override get message(): string {
		return `The PR text was written but publishing it failed: ${this.gh.message}`;
	}
}

export interface PrShape {
	/**
	 * Writes the title and body with an agent, then opens the PR, or updates the open PR
	 * for the branch so a resumed run can repeat this step. Escalated PRs are always
	 * drafts, and an existing ready PR is turned back into one. Only the agent call has a
	 * timeout; wrap the whole call in the step's timeout to bound the `gh` calls too.
	 */
	readonly open: (
		input: OpenPrInput
	) => Effect.Effect<OpenPrResult, AgentError | GhError | PrPublishError>;
}

// --- Body ---

/** The agent's part of the PR: a title and a body following {@link PR_TEMPLATE}. */
export const PrText = Schema.Struct({
	title: Schema.NonEmptyString,
	body: Schema.NonEmptyString
});
export interface PrText extends Schema.Schema.Type<typeof PrText> {}

/** The PR body template and how to fill it in. */
export const PR_TEMPLATE = `Use this template for the body:

\`\`\`markdown
## Summary

<diagram, diff-sketch, or tree>

## Evidence

- **Before:** <output/failing test run>
  **After:** <output/passing test run>

## Merge Danger

**Door:** <one-way or two-way>

<optional: description>

**Blast Radius:** <one-word description>

<optional: potential ramifications of merge>
\`\`\`

Skip preambles and keep prose brief. Use the project's domain language.

Summary: pick the smallest view that makes the key point clear, placed next to the short text it supports. Use one or two at most:
- pseudocode for logic or an algorithm;
- a call tree for runtime control flow;
- a component tree for UI structure, with the state and module boundaries that matter;
- a shallow file tree for file responsibilities or a broad refactor;
- a Mermaid diagram for interaction, control flow or data flow;
- a \`diff\` block shaped like the topic (component tree, file tree, call tree, control flow) when the point is what changes in a shape that already exists;
- the whole block when most of it is new.
Keep only the calls, files, props, states and boundaries needed to make the point.

Evidence: concrete proof that the change works, as a before and after. Prefer execution-based evidence: name the tests that now pass, in pseudocode, and the checks that ran.

Merge Danger: a two-way door is cheap to roll back; destructive or hard-to-reverse changes are one-way doors. The blast radius is what the change could affect: consumers, data, layout, and so on.`;

const ESCALATION_TEXT: Record<EscalationReason, string> = {
	'check-fix-cap': 'checks still fail after the last check-fix attempt',
	'review-cap': 'must-fix findings or nits remain after the last review round',
	stall: 'a fix round left a must-fix finding unresolved',
	timeout: 'a step timed out'
};

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

export const prPrompt = (input: OpenPrInput): string =>
	[
		'Write the title and body of a pull request for this change. You can read the spec, the plan and the repository, but the diff below is the change.',
		'',
		PR_TEMPLATE,
		'',
		'The title is one short imperative sentence. Do not list review findings; ship appends the tradeoffs after your body.',
		'',
		`- Spec: ${input.specPath}`,
		`- Implementation plan: ${input.planPath}`,
		'',
		'Commits:',
		'',
		...input.commits.map((commit) => `- ${commit.subject}`),
		'',
		'Latest checks:',
		'',
		checksEvidence(input.checks),
		'',
		'```diff',
		truncateDiff(input.diff, MAX_PR_DIFF_CHARS),
		'```'
	].join('\n');

const indent = (text: string) => text.split('\n').join('\n  ');

const findingItem = (finding: VerifiedFinding) => {
	const location = `${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}`;
	const reviewers = [finding.reviewer, ...finding.alsoReportedBy].join(', ');
	return `- \`${location}\` (${reviewers}): ${indent(finding.claim)}\n  ${indent(finding.evidence)}`;
};

const findingsSection = (title: string, findings: ReadonlyArray<VerifiedFinding>) =>
	findings.length === 0 ? [] : [`## ${title}`, '', ...findings.map(findingItem), ''];

/**
 * The full body: an escalation notice, the agent's body, then the review findings left
 * for a human, written by ship so none is lost or reworded. A finished run lists only its
 * tradeoffs; an escalated one also lists the must-fix findings and nits it left unresolved.
 */
export const renderPrBody = (
	agentBody: string,
	input: Pick<OpenPrInput, 'unresolved' | 'escalation'>
): string =>
	[
		...(input.escalation === null
			? []
			: [
					`> [!WARNING]`,
					`> ship escalated this run: ${ESCALATION_TEXT[input.escalation]}. It needs a human before merging.`,
					''
				]),
		agentBody.trim(),
		'',
		...(input.escalation === null
			? []
			: [
					...findingsSection('Unresolved must-fix findings', input.unresolved.mustFix),
					...findingsSection('Unresolved nits', input.unresolved.nits)
				]),
		...findingsSection('Tradeoffs', input.unresolved.tradeoffs)
	]
		.join('\n')
		.trimEnd()
		.concat('\n');

// --- Implementation ---

const make = Effect.gen(function* () {
	const agent = yield* Agent;
	const gh = yield* Gh;

	const open = Effect.fn('Pr.open')(function* (input: OpenPrInput) {
		const step = input.escalation === null ? 'pr' : 'escalate';
		// Look up the PR first, so a `gh` failure (e.g. not logged in) happens before the
		// agent call is paid for.
		const existing = yield* gh.findPr(input.repo, input.branch);
		const result = yield* agent.runStructured(
			{
				step,
				prompt: prPrompt(input),
				model: input.model,
				access: 'read-only',
				cwd: input.repo.cwd,
				env: input.repo.env,
				additionalDirectories: planDirs(input),
				timeoutMs: input.timeoutMs,
				transcript: input.transcript
			},
			PrText
		);
		const title = result.output.title.trim();
		const body = renderPrBody(result.output.body, input);
		const draft = input.draft || input.escalation !== null;
		const { cost } = result;

		const publish = Effect.gen(function* () {
			if (existing === null) {
				const url = yield* gh.createPr(input.repo, {
					base: input.base,
					head: input.branch,
					title,
					body,
					draft
				});
				return { url, draft, created: true, cost } satisfies OpenPrResult;
			}
			yield* gh.editPr(input.repo, { url: existing.url, title, body });
			if (input.escalation !== null && !existing.isDraft) {
				yield* gh.markDraft(input.repo, existing.url);
			}
			return {
				url: existing.url,
				draft: existing.isDraft || input.escalation !== null,
				created: false,
				cost
			} satisfies OpenPrResult;
		});
		return yield* publish.pipe(
			Effect.mapError((error) => new PrPublishError({ gh: error, cost }))
		);
	});

	return Pr.of({ open });
});

/** Opens or updates the run's pull request. Needs `Agent` and `Gh`. */
export class Pr extends Context.Service<Pr, PrShape>()('@ship/core/Pr') {
	static readonly layer = Layer.effect(this, make);
}
