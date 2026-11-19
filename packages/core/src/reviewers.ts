import { Context, Effect, FileSystem, Layer, Result, Schema, Struct } from 'effect';
import { fileURLToPath } from 'node:url';
import {
	Agent,
	agentErrorCost,
	AgentOutputMismatch,
	billedTo,
	type AgentCallCost,
	type AgentError,
	type TranscriptTarget
} from './agent.ts';
import { REPO_RULES_WIN, reviewerConventionFiles, type ConventionScope } from './conventions.ts';
import {
	Finding,
	FindingId,
	Severity,
	type DisprovedFinding,
	type VerifiedFinding
} from './finding.ts';
import { Git, type Commit, type CommitRange, type GitRepo } from './git.ts';
import { NonNegativeInt, type Env } from './primitives.ts';
import { planDirs, truncateDiff } from './prompt.ts';
import { parseReviewerMarkdown, ReviewerFileError } from './reviewer-markdown.ts';
import type { ReviewerDef } from './reviewer.ts';
import { routeDeterministic, type ReviewChanges, type RoutedReviewer } from './router.ts';

// --- Built-in briefs ---

/**
 * The built-in briefs: `reviewers/*.md` and `verifier.md`. Resolved next to this module,
 * which is `packages/core/src/` from source and `dist/` in the bundled CLI; the CLI build
 * copies `src/briefs` to `dist/briefs`, so keep this module directly in `src/`.
 */
export const BUILTIN_BRIEFS_DIR = fileURLToPath(new URL('./briefs', import.meta.url));

// --- Public types ---

/** Where agents run and where their transcripts go; shared by every call in a step. */
export interface AgentContext {
	readonly cwd: string;
	readonly env: Env;
	readonly transcript?: TranscriptTarget;
}

/** What reviewers and the verifier are told about the work under review. */
export interface ReviewSubject {
	/** The unified diff of the reviewed range. */
	readonly diff: string;
	/** Commits in the reviewed range, oldest first. */
	readonly commits: ReadonlyArray<Commit>;
	/** Absolute paths of the plan's `spec.md` and `implementation-plan.md`. */
	readonly specPath: string;
	readonly planPath: string;
	/** The conventions that apply to the repo and the change; reviewers and the verifier may read its dir. */
	readonly conventions: ConventionScope;
}

export interface LoadReviewersInput {
	/** The project's reviewers directory, `shipPaths(home).projectReviewers(key)`; may be absent. */
	readonly projectDir: string;
	/** Built-in reviewers to leave out, from the project's `reviewers.disable`. */
	readonly disable: ReadonlyArray<string>;
}

/** One review range as `reviewChanges` reads it: what routing looks at. */
export interface ReviewDelta extends ReviewChanges {
	/** The unified diff of the range. */
	readonly diff: string;
	readonly commits: ReadonlyArray<Commit>;
}

export interface RouteInput {
	readonly reviewers: ReadonlyArray<ReviewerDef>;
	/** Round 1: `base..HEAD`. Later rounds: `lastReviewedSha..HEAD`, so only reviewers the fix touched run again. */
	readonly changes: ReviewDelta;
	/** The LLM router, when the project's `reviewers.llmRouter` is on; `null` skips it. */
	readonly llm: null | {
		readonly model: string;
		readonly timeoutMs: number;
		readonly context: AgentContext;
	};
}

export interface RouteResult {
	/** Deterministic picks first, then the LLM router's additions. */
	readonly reviewers: ReadonlyArray<RoutedReviewer>;
	readonly costs: ReadonlyArray<AgentCallCost>;
	/**
	 * Why the LLM router failed, if it did. Routing then keeps the deterministic picks:
	 * the router may only add reviewers, so its failure must not block the review.
	 */
	readonly llmError: AgentError | null;
}

export interface ReviewInput extends ReviewSubject {
	readonly reviewers: ReadonlyArray<ReviewerDef>;
	/** The configured `review` model; a reviewer's own `model` wins. */
	readonly model: string;
	/** Per reviewer call. */
	readonly timeoutMs: number;
	readonly context: AgentContext;
	/** Reviewers running at once; defaults to {@link DEFAULT_REVIEW_CONCURRENCY}. */
	readonly concurrency?: number;
	/**
	 * Called as each reviewer finishes, before the round ends. It is how finished
	 * reviewers' costs are recorded: when another reviewer fails, `review` fails without
	 * the reports (the failed call's own cost is on its error, see `agentErrorCost`).
	 */
	readonly onReport: (report: ReviewerReport) => Effect.Effect<void>;
}

export interface ReviewerReport {
	readonly reviewer: string;
	readonly findings: ReadonlyArray<Finding>;
	readonly cost: AgentCallCost;
}

export interface VerifyInput extends ReviewSubject {
	readonly round: number;
	/** Every finding reported this round. */
	readonly findings: ReadonlyArray<Finding>;
	/**
	 * Verified findings from earlier rounds to check again: normally the must-fix findings
	 * the last fix step was given. The verifier says which are fixed; an unfixed one comes
	 * back as a finding of this round that `repeats` it, which is a stall.
	 */
	readonly previous: ReadonlyArray<VerifiedFinding>;
	readonly model: string;
	readonly timeoutMs: number;
	readonly context: AgentContext;
}

export interface VerifyResult {
	readonly verified: ReadonlyArray<VerifiedFinding>;
	readonly disproved: ReadonlyArray<DisprovedFinding>;
	/** Previous findings the verifier found fixed. */
	readonly fixed: ReadonlyArray<FindingId>;
	/** `null` when there was nothing to verify and no agent ran. */
	readonly cost: AgentCallCost | null;
}

export interface ReviewersShape {
	/**
	 * The built-in reviewers minus `disable`, then the project's `*.md` reviewers; a project
	 * reviewer replaces the built-in with the same name. `disable` applies to built-ins only.
	 * Sorted by name.
	 */
	readonly load: (
		input: LoadReviewersInput
	) => Effect.Effect<ReadonlyArray<ReviewerDef>, ReviewerFileError>;
	/**
	 * Picks the reviewers for `changes`: every one whose triggers match, then the ones the
	 * LLM router adds. The LLM router never removes a deterministic pick.
	 */
	readonly route: (input: RouteInput) => Effect.Effect<RouteResult>;
	/**
	 * Runs the reviewers in parallel, read-only. Each sees only the subject and its own
	 * brief, never another reviewer's output. Fails when any reviewer fails.
	 */
	readonly review: (
		input: ReviewInput
	) => Effect.Effect<ReadonlyArray<ReviewerReport>, AgentError>;
	/**
	 * One agent pass over the round's findings: dedupes, checks each against the code,
	 * drops disproved ones, matches the rest to earlier rounds, and checks whether the
	 * previous findings are fixed.
	 */
	readonly verify: (
		input: VerifyInput
	) => Effect.Effect<VerifyResult, AgentError | ReviewerFileError>;
}

export const DEFAULT_REVIEW_CONCURRENCY = 4;

// --- Gathering changes ---

/** Everything routing and review need about `range`, from `Git`. */
export const reviewChanges = Effect.fn('reviewChanges')(function* (
	repo: GitRepo,
	range: CommitRange
) {
	const git = yield* Git;
	const [diff, commits, files, addedLines] = yield* Effect.all(
		[
			git.diff(repo, range),
			git.commits(repo, range),
			git.changedFiles(repo, range),
			git.addedLines(repo, range)
		],
		{ concurrency: 'unbounded' }
	);
	return { diff, commits, files, addedLines } satisfies ReviewDelta;
});

// --- Agent output schemas ---

/** What a reviewer returns; ship fills in `reviewer`. */
export const ReviewerOutput = Schema.Struct({
	findings: Schema.Array(Schema.Struct(Struct.omit(Finding.fields, ['reviewer'])))
});
export interface ReviewerOutput extends Schema.Schema.Type<typeof ReviewerOutput> {}

export const RouterOutput = Schema.Struct({
	reviewers: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String }))
});
export interface RouterOutput extends Schema.Schema.Type<typeof RouterOutput> {}

/**
 * The verifier's judgement of each finding by its index in the list it was given, and of
 * each previous finding by id. Ship assembles the verified findings from it.
 */
export const VerifierOutput = Schema.Struct({
	verdicts: Schema.Array(
		Schema.Struct({
			index: NonNegativeInt,
			verdict: Schema.Literals(['confirmed', 'disproved', 'duplicate']),
			reason: Schema.NonEmptyString,
			/** For `duplicate`: the index of the finding it repeats. */
			duplicateOf: Schema.optionalKey(NonNegativeInt),
			/** For `confirmed`: the id of the previous finding it is the same problem as. */
			repeats: Schema.optionalKey(Schema.String),
			/** For `confirmed`: a lower severity, when the evidence does not support the reported one. */
			severity: Schema.optionalKey(Severity)
		})
	),
	previous: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			status: Schema.Literals(['fixed', 'unfixed']),
			evidence: Schema.NonEmptyString
		})
	)
});
export interface VerifierOutput extends Schema.Schema.Type<typeof VerifierOutput> {}

// --- Prompts ---

/** Reviewers get the whole diff up to this size; beyond it they read the files themselves. */
const MAX_REVIEW_DIFF_CHARS = 200_000;
const MAX_ROUTER_DIFF_CHARS = 30_000;

const subjectSection = (subject: ReviewSubject) => {
	const commits =
		subject.commits.length === 0
			? '(none)'
			: subject.commits
					.map((commit) => `- ${commit.sha.slice(0, 12)} ${commit.subject}`)
					.join('\n');
	return [
		'## The change',
		'',
		`- Spec: ${subject.specPath}`,
		`- Implementation plan: ${subject.planPath}`,
		'',
		'Commits:',
		'',
		commits,
		'',
		'Diff:',
		'',
		'```diff',
		truncateDiff(subject.diff, MAX_REVIEW_DIFF_CHARS),
		'```'
	].join('\n');
};

/**
 * The rules every reviewer follows, after its own brief and the change. Condensed from
 * Matt Pocock's code-review skill (MIT); see `briefs/ATTRIBUTION.md`.
 */
const REVIEWER_RULES = `## Rules

- Stay inside your brief. Other reviewers own what it lists as out of scope.
- Report problems this change introduces or makes worse. Older problems count only when the change newly exposes them. After a fix round the diff may hold only the fix commits; read the files for context.
- Try to disprove each finding before reporting it: read the surrounding code, callers and tests, confirm what you call missing is missing, and confirm any helper or API you suggest exists.
- Severity:
  - \`must-fix\`: a real defect shown by concrete evidence, such as a traced failing path, a quoted requirement or a quoted written project rule. Suspicion, preference or a missing best practice is never must-fix.
  - \`tradeoff\`: a judgement call worth a human's attention; state its cost.
  - \`nit\`: style or wording with no effect on behaviour.

## Output

For each finding give the repo-relative \`file\`, the \`line\` in the new version when there is one, the \`severity\`, a one-sentence \`claim\`, and \`evidence\`: the quoted code (and rule or spec text where it applies), the reasoning that links them, and what you inferred but did not verify. Return an empty \`findings\` list when nothing survives; never pad it.`;

/** The convention files a reviewer reads, and how their rules count; empty when it has none. */
const conventionsSection = (
	reviewer: ReviewerDef,
	subject: ReviewSubject
): ReadonlyArray<string> => {
	const files = reviewerConventionFiles(subject.conventions, reviewer.conventions);
	if (files.length === 0) return [];
	return [
		'## Conventions',
		'',
		"Read these convention files before reviewing; a topic's details file follows its base file:",
		'',
		...files.map((file) => `- ${file}`),
		'',
		`Check the change against every rule in them, including rules a linter also enforces. A rule quoted from them counts as a written project rule, like one in AGENTS.md: breaking it can be \`must-fix\`. ${REPO_RULES_WIN}`,
		''
	];
};

/** The prompt for one reviewer: its brief, its conventions, then the change. */
export const reviewerPrompt = (reviewer: ReviewerDef, subject: ReviewSubject): string =>
	[
		`You are the "${reviewer.name}" reviewer of a code change. You can read and search the repository but not change it.`,
		'',
		'## Your brief',
		'',
		reviewer.brief,
		'',
		...conventionsSection(reviewer, subject),
		subjectSection(subject),
		'',
		REVIEWER_RULES
	].join('\n');

const firstParagraph = (brief: string): string => {
	const paragraph = brief.split(/\n\s*\n/u).find((part) => !part.trim().startsWith('#')) ?? '';
	const text = paragraph.replace(/\s+/gu, ' ').trim();
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

export const routerPrompt = (
	candidates: ReadonlyArray<ReviewerDef>,
	changes: ReviewDelta
): string =>
	[
		'Pick the code reviewers this change needs, beyond those already chosen. Pick a reviewer only when the change clearly touches what its description covers; pick none when in doubt.',
		'',
		'## Reviewers you can pick',
		'',
		...candidates.map(
			(reviewer) =>
				`- ${reviewer.name}: ${reviewer.description ?? firstParagraph(reviewer.brief)}`
		),
		'',
		'## Changed files',
		'',
		...changes.files.map((file) => `- ${file.status} ${file.path}`),
		'',
		'## Diff',
		'',
		'```diff',
		truncateDiff(changes.diff, MAX_ROUTER_DIFF_CHARS),
		'```',
		'',
		'Return the names you pick, each with a one-sentence reason.'
	].join('\n');

const findingLine = (finding: Finding) =>
	`${finding.reviewer} | ${finding.severity} | ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`} | ${finding.claim} | evidence: ${finding.evidence}`;

export const verifierPrompt = (
	brief: string,
	input: Pick<VerifyInput, 'findings' | 'previous'> & ReviewSubject
): string =>
	[
		brief,
		'',
		`Conventions directory: ${input.conventions.dir}`,
		'',
		subjectSection(input),
		'',
		'## Findings to verify',
		'',
		'One per line: `index. reviewer | severity | location | claim | evidence`.',
		'',
		...(input.findings.length === 0
			? ['(none)']
			: input.findings.map((finding, index) => `${index}. ${findingLine(finding)}`)),
		'',
		'## Previous findings',
		'',
		'Findings from earlier rounds, which the latest fix was meant to resolve. One per line: `id. reviewer | severity | location | claim | evidence`.',
		'',
		...(input.previous.length === 0
			? ['(none)']
			: input.previous.map((finding) => `${finding.id}. ${findingLine(finding)}`)),
		'',
		'## Output',
		'',
		'Give one verdict per finding, by index: `confirmed`, `disproved` or `duplicate` (with `duplicateOf`, the index of the finding it repeats), and a reason. For a confirmed finding that is the same problem as a previous finding, set `repeats` to that id; set `severity` only to lower one the evidence does not support. A kept finding takes the highest severity among the duplicates merged into it; its `severity` lowers that merged result. Then give each previous finding, by id, a status, `fixed` or `unfixed`, with evidence.'
	].join('\n');

/** What reviewers and the verifier may read outside the repo: the plan and the conventions. */
const readableDirs = (subject: ReviewSubject) => [...planDirs(subject), subject.conventions.dir];

// --- Severity ---

const SEVERITY_RANK: Record<Severity, number> = { nit: 0, tradeoff: 1, 'must-fix': 2 };

const mostSevere = (a: Severity, b: Severity): Severity =>
	SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;

const leastSevere = (a: Severity, b: Severity): Severity => (mostSevere(a, b) === a ? b : a);

/** A non-blocking reviewer's must-fix becomes a tradeoff, so it never starts a fix round. */
const capSeverity = (reviewer: ReviewerDef, severity: Severity): Severity =>
	!reviewer.blocking && severity === 'must-fix' ? 'tradeoff' : severity;

// --- Verification ---

const invalidVerdicts = (output: VerifierOutput, detail: string) =>
	new AgentOutputMismatch({ step: 'verify', detail, output: JSON.stringify(output) });

/**
 * Builds the round's verified findings from the verifier's verdicts. Ship assigns ids
 * (`r<round>-<n>`) and merges duplicates into the finding they repeat, which takes the
 * highest severity among them. The verifier may lower a severity but never raise it, so
 * only a blocking reviewer's must-fix, reported or merged in, can start a fix round.
 *
 * A finding with no verdict is kept, as is a duplicate of a finding that was not kept:
 * a finding is dropped only when the verifier disproves or merges it. Likewise a previous
 * finding with no status counts as unfixed, so it is never dropped silently.
 */
export const assembleVerified = (
	input: Pick<VerifyInput, 'round' | 'findings' | 'previous'>,
	output: VerifierOutput
): Effect.Effect<Omit<VerifyResult, 'cost'>, AgentOutputMismatch> =>
	Effect.gen(function* () {
		const verdicts = new Map<number, VerifierOutput['verdicts'][number]>();
		for (const verdict of output.verdicts) {
			if (verdict.index >= input.findings.length) {
				return yield* invalidVerdicts(
					output,
					`verdict for unknown finding ${verdict.index}`
				);
			}
			if (verdicts.has(verdict.index)) {
				return yield* invalidVerdicts(output, `two verdicts for finding ${verdict.index}`);
			}
			verdicts.set(verdict.index, verdict);
		}

		/** The kept finding `index` merges into, or `null` when it is kept itself or dropped. */
		const mergeTarget = (index: number): number | null => {
			const seen = new Set<number>();
			let current = index;
			for (;;) {
				const verdict = verdicts.get(current);
				if (verdict?.verdict !== 'duplicate' || verdict.duplicateOf === undefined) break;
				if (seen.has(current)) return null;
				seen.add(current);
				current = verdict.duplicateOf;
			}
			if (current === index || current >= input.findings.length) return null;
			return verdicts.get(current)?.verdict === 'disproved' ? null : current;
		};

		const previousIds = new Set<string>(input.previous.map((finding) => finding.id));
		const kept = new Map<
			number,
			{ finding: Finding; repeats?: FindingId; severity?: Severity }
		>();
		const merged = new Map<number, Array<Finding>>();
		const disproved: Array<DisprovedFinding> = [];
		input.findings.forEach((finding, index) => {
			const verdict = verdicts.get(index);
			if (verdict?.verdict === 'disproved') {
				disproved.push({ finding, reason: verdict.reason });
				return;
			}
			if (verdict?.verdict === 'duplicate') {
				const target = mergeTarget(index);
				if (target !== null) {
					merged.set(target, [...(merged.get(target) ?? []), finding]);
					return;
				}
			}
			const repeats =
				verdict?.repeats !== undefined && previousIds.has(verdict.repeats)
					? FindingId.make(verdict.repeats)
					: undefined;
			kept.set(index, {
				finding,
				...(repeats === undefined ? {} : { repeats }),
				...(verdict?.severity === undefined ? {} : { severity: verdict.severity })
			});
		});

		let counter = 0;
		const nextId = () => {
			counter += 1;
			return FindingId.make(`r${input.round}-${counter}`);
		};
		const verified: Array<VerifiedFinding> = [];
		for (const [index, entry] of kept) {
			const duplicates = merged.get(index) ?? [];
			const reported = duplicates.reduce(
				(severity, duplicate) => mostSevere(severity, duplicate.severity),
				entry.finding.severity
			);
			const severity =
				entry.severity === undefined ? reported : leastSevere(entry.severity, reported);
			verified.push({
				...entry.finding,
				severity,
				id: nextId(),
				round: input.round,
				alsoReportedBy: [
					...new Set(duplicates.map((duplicate) => duplicate.reviewer))
				].filter((reviewer) => reviewer !== entry.finding.reviewer),
				...(entry.repeats === undefined ? {} : { repeats: entry.repeats })
			});
		}

		const statuses = new Map(output.previous.map((entry) => [entry.id, entry]));
		const repeated = new Set(verified.flatMap((finding) => finding.repeats ?? []));
		const fixed: Array<FindingId> = [];
		for (const previous of input.previous) {
			const status = statuses.get(previous.id);
			if (status?.status === 'fixed' && !repeated.has(previous.id)) {
				fixed.push(previous.id);
				continue;
			}
			if (repeated.has(previous.id)) continue;
			const finding = Struct.omit(previous, ['id', 'round', 'repeats', 'alsoReportedBy']);
			verified.push({
				...finding,
				evidence:
					status === undefined
						? finding.evidence
						: `${finding.evidence}\nStill present: ${status.evidence}`,
				id: nextId(),
				round: input.round,
				alsoReportedBy: [],
				repeats: previous.id
			});
		}
		return { verified, disproved, fixed };
	});

// --- Implementation ---

const make = (briefsDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const agent = yield* Agent;

		const fileError = (path: string) => (error: { message: string }) =>
			new ReviewerFileError({ path, detail: error.message });

		/** Parses every reviewer in `dir`; a missing `dir` has none unless `required`. */
		const readDir = Effect.fnUntraced(function* (dir: string, required: boolean) {
			const exists = yield* fs.exists(dir).pipe(Effect.mapError(fileError(dir)));
			if (!exists && required) {
				return yield* new ReviewerFileError({
					path: dir,
					detail: 'The built-in reviewers are missing; ship was packaged without them'
				});
			}
			if (!exists) return [];
			const names = yield* fs.readDirectory(dir).pipe(Effect.mapError(fileError(dir)));
			return yield* Effect.forEach(
				names.filter((name) => name.endsWith('.md')).toSorted(),
				(name) => {
					const path = `${dir}/${name}`;
					return fs.readFileString(path).pipe(
						Effect.mapError(fileError(path)),
						Effect.flatMap((text) => parseReviewerMarkdown(path, text))
					);
				}
			);
		});

		const load = Effect.fn('Reviewers.load')(function* (input: LoadReviewersInput) {
			const builtins = yield* readDir(`${briefsDir}/reviewers`, true);
			const project = yield* readDir(input.projectDir, false);
			const byName = new Map<string, ReviewerDef>();
			for (const reviewer of builtins) {
				if (!input.disable.includes(reviewer.name)) byName.set(reviewer.name, reviewer);
			}
			for (const reviewer of project) byName.set(reviewer.name, reviewer);
			return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
		});

		const route = Effect.fn('Reviewers.route')(function* (input: RouteInput) {
			const deterministic = routeDeterministic(input.reviewers, input.changes);
			const picked = new Set(deterministic.map((routed) => routed.reviewer.name));
			const candidates = input.reviewers.filter((reviewer) => !picked.has(reviewer.name));
			if (input.llm === null || candidates.length === 0) {
				return {
					reviewers: deterministic,
					costs: [],
					llmError: null
				} satisfies RouteResult;
			}
			const { llm } = input;
			const outcome = yield* agent
				.runStructured(
					{
						step: 'route',
						prompt: routerPrompt(candidates, input.changes),
						model: llm.model,
						access: 'none',
						cwd: llm.context.cwd,
						env: llm.context.env,
						timeoutMs: llm.timeoutMs,
						transcript: llm.context.transcript
					},
					RouterOutput
				)
				.pipe(Effect.result);
			if (Result.isFailure(outcome)) {
				const cost = agentErrorCost(outcome.failure);
				return {
					reviewers: deterministic,
					costs: cost === null ? [] : [cost],
					llmError: outcome.failure
				} satisfies RouteResult;
			}
			const result = outcome.success;
			const added = new Map<string, RoutedReviewer>();
			for (const pick of result.output.reviewers) {
				const reviewer = candidates.find((candidate) => candidate.name === pick.name);
				if (reviewer !== undefined && !added.has(reviewer.name)) {
					added.set(reviewer.name, { reviewer, reasons: [`llm: ${pick.reason}`] });
				}
			}
			return {
				reviewers: [...deterministic, ...added.values()],
				costs: [result.cost],
				llmError: null
			} satisfies RouteResult;
		});

		const review = Effect.fn('Reviewers.review')(function* (input: ReviewInput) {
			return yield* Effect.forEach(
				input.reviewers,
				(reviewer) =>
					Effect.gen(function* () {
						const model = reviewer.model ?? input.model;
						const result = yield* agent.runStructured(
							{
								step: 'review',
								label: reviewer.name,
								prompt: reviewerPrompt(reviewer, input),
								model,
								access: 'read-only',
								cwd: input.context.cwd,
								env: input.context.env,
								additionalDirectories: readableDirs(input),
								timeoutMs: input.timeoutMs,
								transcript: input.context.transcript
							},
							ReviewerOutput
						);
						const report: ReviewerReport = {
							reviewer: reviewer.name,
							findings: result.output.findings.map((finding) => ({
								reviewer: reviewer.name,
								...finding,
								severity: capSeverity(reviewer, finding.severity)
							})),
							cost: result.cost
						};
						yield* input.onReport(report);
						return report;
					}),
				{ concurrency: input.concurrency ?? DEFAULT_REVIEW_CONCURRENCY }
			);
		});

		const verify = Effect.fn('Reviewers.verify')(function* (input: VerifyInput) {
			if (input.findings.length === 0 && input.previous.length === 0) {
				return {
					verified: [],
					disproved: [],
					fixed: [],
					cost: null
				} satisfies VerifyResult;
			}
			const briefPath = `${briefsDir}/verifier.md`;
			const brief = yield* fs
				.readFileString(briefPath)
				.pipe(Effect.mapError(fileError(briefPath)));
			const result = yield* agent.runStructured(
				{
					step: 'verify',
					prompt: verifierPrompt(brief.trim(), input),
					model: input.model,
					access: 'read-only',
					cwd: input.context.cwd,
					env: input.context.env,
					additionalDirectories: readableDirs(input),
					timeoutMs: input.timeoutMs,
					transcript: input.context.transcript
				},
				VerifierOutput
			);
			const assembled = yield* assembleVerified(input, result.output).pipe(
				Effect.mapError(billedTo(result))
			);
			return {
				...assembled,
				cost: result.cost
			} satisfies VerifyResult;
		});

		return Reviewers.of({ load, route, review, verify });
	});

export class Reviewers extends Context.Service<Reviewers, ReviewersShape>()(
	'@ship/core/Reviewers'
) {
	/** Built-in briefs from the package. Needs `Agent` and `FileSystem`. */
	static readonly layer = Layer.effect(this, make(BUILTIN_BRIEFS_DIR));
	/** Built-in briefs from `briefsDir` instead, for tests. */
	static readonly layerWithBriefs = (briefsDir: string) => Layer.effect(this, make(briefsDir));
}
