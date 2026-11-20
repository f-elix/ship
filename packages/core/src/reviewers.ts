import { Context, Effect, FileSystem, Layer, Result, Schema, Struct } from 'effect';
import { fileURLToPath } from 'node:url';
import {
	Agent,
	AgentOutputMismatch,
	billedTo,
	type AgentCallCost,
	type AgentError,
	type TranscriptTarget
} from './agent.ts';
import { Clef, type ClefError, type CloudflareCredentials } from './clef.ts';
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

/**
 * What the change sets out to do, which the reviewers check it against: the plan ship
 * implemented (`ship run`), or the description of a PR ship did not write (`ship review`).
 */
export const ChangeIntent = Schema.TaggedUnion({
	/** Absolute paths of the plan's `spec.md` and `implementation-plan.md`. */
	Plan: { specPath: Schema.String, planPath: Schema.String },
	/** The PR's title and body. */
	Description: { title: Schema.String, body: Schema.String }
});
export type ChangeIntent = typeof ChangeIntent.Type;

/** What reviewers and the verifier are told about the work under review. */
export interface ReviewSubject {
	/** The unified diff of the reviewed range. */
	readonly diff: string;
	/** Commits in the reviewed range, oldest first. */
	readonly commits: ReadonlyArray<Commit>;
	readonly intent: ChangeIntent;
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
	/**
	 * What routing looks at. Round 1: `base..HEAD`. Later rounds: `lastReviewedSha..HEAD`,
	 * the fix commits, so only reviewers the fix touched are routed again.
	 */
	readonly changes: ReviewDelta;
	/**
	 * Clef, when the project's `reviewers.clef` is on and Cloudflare credentials are saved;
	 * `null` routes with the deterministic triggers only.
	 */
	readonly clef: null | { readonly credentials: CloudflareCredentials };
}

export interface RouteResult {
	/** Deterministic picks first, then Clef's additions. */
	readonly reviewers: ReadonlyArray<RoutedReviewer>;
	/**
	 * Why Clef failed, if it did. Routing then keeps the deterministic picks: Clef may
	 * only add reviewers, so its failure must not block the review.
	 */
	readonly clefError: ClefError | null;
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
	 * Verified findings from earlier rounds to check again: the must-fix findings and nits
	 * the last fix step was given. The verifier says which are fixed; an unfixed one comes
	 * back as a finding of this round that `repeats` it. A repeated must-fix is a stall.
	 */
	readonly previous: ReadonlyArray<VerifiedFinding>;
	/**
	 * Earlier rounds' tradeoffs, already listed for the PR. Used only to match repeats: a
	 * tradeoff of this round that repeats one is dropped, so the PR lists it once.
	 */
	readonly knownTradeoffs: ReadonlyArray<VerifiedFinding>;
	readonly model: string;
	readonly timeoutMs: number;
	readonly context: AgentContext;
}

/** What the verifier found of one previous finding. */
export interface PreviousStatus {
	readonly id: FindingId;
	readonly status: 'fixed' | 'unfixed';
	/** The verifier's evidence; a fallback note when it gave the finding no status. */
	readonly evidence: string;
}

export interface VerifyResult {
	readonly verified: ReadonlyArray<VerifiedFinding>;
	readonly disproved: ReadonlyArray<DisprovedFinding>;
	/**
	 * One entry per previous finding, in input order: whether it is fixed, with the
	 * verifier's evidence. A previous finding this round repeats is unfixed, whatever the
	 * verifier said of it.
	 */
	readonly previous: ReadonlyArray<PreviousStatus>;
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
	 * Picks the reviewers for `changes`: every one whose triggers match, then the ones Clef
	 * adds. Clef never removes a deterministic pick.
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
			/** For `confirmed`: the id of the previous finding or known tradeoff it is the same problem as. */
			repeats: Schema.optionalKey(Schema.String),
			/** For `confirmed`: `nit` for a must-fix that is only a formatter, linter or taste remark. */
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

/** The stated intent: the plan's files to read, or the PR's description quoted in full. */
const intentLines = (intent: ChangeIntent): ReadonlyArray<string> =>
	ChangeIntent.match(intent, {
		Plan: ({ specPath, planPath }) => [
			`- Spec: ${specPath}`,
			`- Implementation plan: ${planPath}`
		],
		Description: ({ title, body }) => [
			'The stated intent is the pull request description:',
			'',
			`Title: ${title}`,
			'',
			'Body:',
			'',
			'````markdown',
			body.trim() === '' ? '(empty)' : body,
			'````'
		]
	});

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
		...intentLines(subject.intent),
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
- Report problems this change introduces or makes worse. Older problems count only when the change newly exposes them.
- Try to disprove each finding before reporting it: read the surrounding code, callers and tests, confirm what you call missing is missing, and confirm any helper or API you suggest exists.
- Severity:
  - \`must-fix\`: a defect shown by concrete evidence, such as a traced failing path, a quoted requirement or a quoted written project rule. Suspicion, preference or a missing best practice is never must-fix.
  - \`nit\`: style or wording with no effect on behaviour.
  - \`tradeoff\`: the change deviates from the stated intent (the plan, or the PR description), or has an impact it did not foresee. State what it gives up, and its cost.

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

const findingLine = (finding: Finding) =>
	`${finding.reviewer} | ${finding.severity} | ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`} | ${finding.claim} | evidence: ${finding.evidence}`;

const findingList = (findings: ReadonlyArray<VerifiedFinding>): ReadonlyArray<string> =>
	findings.length === 0
		? ['(none)']
		: findings.map((finding) => `${finding.id}. ${findingLine(finding)}`);

export const verifierPrompt = (
	brief: string,
	input: Pick<VerifyInput, 'findings' | 'previous' | 'knownTradeoffs'> & ReviewSubject
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
		"The last round's must-fix findings and nits, which the latest fix was meant to resolve. One per line: `id. reviewer | severity | location | claim | evidence`.",
		'',
		...findingList(input.previous),
		'',
		'## Known tradeoffs',
		'',
		'Tradeoffs from earlier rounds, already listed for the PR. Use them only to match repeats. One per line: `id. reviewer | severity | location | claim | evidence`.',
		'',
		...findingList(input.knownTradeoffs),
		'',
		'## Output',
		'',
		'Give one verdict per finding, by index: `confirmed`, `disproved` or `duplicate` (with `duplicateOf`, the index of the finding it repeats), and a reason. Mark a duplicate only between findings of the same kind: a tradeoff with a tradeoff, or a must-fix or nit with a must-fix or nit. For a confirmed finding that is the same problem as a previous finding, or the same tradeoff as a known one, set `repeats` to that id. Set `severity` to `nit` only to lower a must-fix that is a formatter, linter or taste remark; never move a finding into or out of `tradeoff`. A kept finding takes the highest severity among the duplicates merged into it; its `severity` lowers that merged result. Then give each previous finding, by id, a status, `fixed` or `unfixed`, with evidence.'
	].join('\n');

/**
 * What reviewers and the verifier may read outside the repo: the plan, when the intent is
 * one, and the conventions.
 */
const readableDirs = (subject: ReviewSubject) => [
	...(subject.intent._tag === 'Plan' ? planDirs(subject.intent) : []),
	subject.conventions.dir
];

// --- Severity ---

/**
 * `tradeoff` is a kind of finding, not a level: only must-fix and nit are ranked, and
 * duplicates merge only within a kind, so a tradeoff is never compared with either.
 */
const mostSevere = (a: Severity, b: Severity): Severity => (a === 'must-fix' ? a : b);

/** Whether `a` and `b` are the same kind of finding: both tradeoffs, or neither. */
const sameKind = (a: Severity, b: Severity): boolean => (a === 'tradeoff') === (b === 'tradeoff');

// --- Verification ---

const invalidVerdicts = (output: VerifierOutput, detail: string) =>
	new AgentOutputMismatch({ step: 'verify', detail, output: JSON.stringify(output) });

type Verdict = VerifierOutput['verdicts'][number];

/**
 * Builds the round's verified findings from the verifier's verdicts. Ship assigns ids
 * (`r<round>-<n>`) and merges duplicates into the finding they repeat, which takes the
 * highest severity among them. The verifier may lower a must-fix to a nit and nothing
 * else: any other `severity` is ignored, so a finding never moves into or out of
 * `tradeoff`.
 *
 * A finding with no verdict is kept, as is a duplicate of a finding that was not kept or
 * of another kind (a tradeoff and a must-fix or nit): a finding is dropped only when the
 * verifier disproves or merges it, or when it is a tradeoff that repeats a known one,
 * which the PR already lists. Likewise a previous finding with no status counts as
 * unfixed, so it is never dropped silently.
 */
export const assembleVerified = (
	input: Pick<VerifyInput, 'round' | 'findings' | 'previous' | 'knownTradeoffs'>,
	output: VerifierOutput
): Effect.Effect<Omit<VerifyResult, 'cost'>, AgentOutputMismatch> =>
	Effect.gen(function* () {
		const verdicts = new Map<number, Verdict>();
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
		// A duplicate of another kind counts as no verdict, so the finding is kept.
		for (const [index, verdict] of verdicts) {
			const target =
				verdict.verdict === 'duplicate' && verdict.duplicateOf !== undefined
					? input.findings[verdict.duplicateOf]
					: undefined;
			const finding = input.findings[index];
			if (
				target !== undefined &&
				finding !== undefined &&
				!sameKind(finding.severity, target.severity)
			) {
				verdicts.delete(index);
			}
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

		/** The earlier finding `verdict` says `finding` repeats, when it is of the same kind. */
		const previousIds = new Set<string>(input.previous.map((finding) => finding.id));
		const knownTradeoffIds = new Set<string>(input.knownTradeoffs.map((finding) => finding.id));
		const repeatsOf = (
			finding: Finding,
			verdict: Verdict | undefined
		): FindingId | undefined => {
			if (verdict?.repeats === undefined) return undefined;
			const ids = finding.severity === 'tradeoff' ? knownTradeoffIds : previousIds;
			return ids.has(verdict.repeats) ? FindingId.make(verdict.repeats) : undefined;
		};

		const kept = new Map<number, { finding: Finding; repeats?: FindingId; lowered: boolean }>();
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
			const repeats = repeatsOf(finding, verdict);
			kept.set(index, {
				finding,
				...(repeats === undefined ? {} : { repeats }),
				lowered: verdict?.severity === 'nit'
			});
		});

		let counter = 0;
		const nextId = () => {
			counter += 1;
			return FindingId.make(`r${input.round}-${counter}`);
		};
		const verified: Array<VerifiedFinding> = [];
		for (const [index, entry] of kept) {
			// Already listed for the PR under the known tradeoff's id.
			if (entry.finding.severity === 'tradeoff' && entry.repeats !== undefined) continue;
			const duplicates = merged.get(index) ?? [];
			const reported = duplicates.reduce(
				(severity, duplicate) => mostSevere(severity, duplicate.severity),
				entry.finding.severity
			);
			const severity = entry.lowered && reported === 'must-fix' ? 'nit' : reported;
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
		const previousStatuses: Array<PreviousStatus> = [];
		for (const previous of input.previous) {
			const status = statuses.get(previous.id);
			const fixed = status?.status === 'fixed' && !repeated.has(previous.id);
			previousStatuses.push({
				id: previous.id,
				status: fixed ? 'fixed' : 'unfixed',
				evidence: status?.evidence ?? NO_STATUS
			});
			if (fixed || repeated.has(previous.id)) continue;
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
		return { verified, disproved, previous: previousStatuses };
	});

/** The evidence of a previous finding the verifier gave no status. */
const NO_STATUS = 'The verifier gave no status for this finding, so it counts as unfixed.';

// --- Implementation ---

const make = (briefsDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const agent = yield* Agent;
		const clef = yield* Clef;

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
			if (input.clef === null || candidates.length === 0) {
				return { reviewers: deterministic, clefError: null } satisfies RouteResult;
			}
			const outcome = yield* clef
				.pick({
					candidates,
					changes: input.changes,
					credentials: input.clef.credentials
				})
				.pipe(Effect.result);
			if (Result.isFailure(outcome)) {
				return {
					reviewers: deterministic,
					clefError: outcome.failure
				} satisfies RouteResult;
			}
			const added = outcome.success.flatMap((pick): ReadonlyArray<RoutedReviewer> => {
				const reviewer = candidates.find((candidate) => candidate.name === pick.name);
				return reviewer === undefined
					? []
					: [{ reviewer, reasons: [`clef: p=${pick.probability.toFixed(2)}`] }];
			});
			return {
				reviewers: [...deterministic, ...added],
				clefError: null
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
								...finding
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
					previous: [],
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
	/** Built-in briefs from the package. Needs `Agent`, `Clef` and `FileSystem`. */
	static readonly layer = Layer.effect(this, make(BUILTIN_BRIEFS_DIR));
	/** Built-in briefs from `briefsDir` instead, for tests. */
	static readonly layerWithBriefs = (briefsDir: string) => Layer.effect(this, make(briefsDir));
}
