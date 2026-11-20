/**
 * The `ship review` machine: one review round over a pull request, run in a detached
 * worktree at the PR's pinned head. `prepare` adds the worktree, `route`, `review` and
 * `verify` reuse `ship run`'s review round, and `post` posts the findings as one
 * GitHub review when the run was started with `--post`.
 */
import { createEffectLogic, setupEffect } from '@xstate/effect';
import { Effect, Schema } from 'effect';
import type { VerifiedFinding } from './finding.ts';
import { Gh, type ReviewComment, type ReviewEvent } from './gh.ts';
import { diffTargetPath, Git } from './git.ts';
import { describeDefect, stepInput } from './pipeline.ts';
import {
	completeRound,
	reviewStep,
	routeStep,
	startRound,
	verifyStep,
	withFindings
} from './review-round.ts';
import { ReviewRunState } from './review-run.ts';
import { ChangeIntent } from './reviewers.ts';
import { runStep, StepNotReady, type StepOutcome } from './run-step.ts';

/** What `post` sends GitHub: the review's verdict, its body and its inline comments. */
export interface ReviewToPost {
	readonly event: ReviewEvent;
	readonly body: string;
	readonly comments: ReadonlyArray<ReviewComment>;
	/**
	 * How many findings the body lists, as `file:line` (or `file` when a finding has no
	 * line), because their line is not in the diff.
	 */
	readonly inBody: number;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

/**
 * The new-side line ranges of each file's hunks in a unified diff, context lines included:
 * the lines GitHub accepts a review comment on, on its right side.
 */
export const commentableLines = (
	diff: string
): ReadonlyMap<string, ReadonlyArray<readonly [number, number]>> => {
	const ranges = new Map<string, Array<readonly [number, number]>>();
	let file: string | null = null;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+++ ')) {
			file = diffTargetPath(line);
			continue;
		}
		const hunk = HUNK.exec(line);
		if (hunk === null || file === null) continue;
		const start = Number(hunk[1]);
		const count = Number(hunk[2] ?? '1');
		if (count === 0) continue;
		const fileRanges = ranges.get(file) ?? [];
		fileRanges.push([start, start + count - 1]);
		ranges.set(file, fileRanges);
	}
	return ranges;
};

const SEVERITY_LABEL: Readonly<Record<VerifiedFinding['severity'], string>> = {
	'must-fix': 'Must-fix',
	tradeoff: 'Tradeoff',
	nit: 'Nit'
};

const location = (finding: VerifiedFinding): string =>
	finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;

const describe = (finding: VerifiedFinding): string =>
	[
		`**${SEVERITY_LABEL[finding.severity]}** (${finding.reviewer}): ${finding.claim}`,
		'',
		`Evidence: ${finding.evidence}`
	].join('\n');

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The review `post` sends for `findings` over `diff`. A finding on a line in the diff
 * becomes an inline comment; the rest are listed in the body as `file:line`, or `file`
 * when the finding has no line. Verified must-fix findings request changes; anything else
 * only comments, and ship never approves.
 */
export const reviewToPost = (
	findings: ReadonlyArray<VerifiedFinding>,
	diff: string
): ReviewToPost => {
	const lines = commentableLines(diff);
	const inDiff = (finding: VerifiedFinding): finding is VerifiedFinding & { line: number } =>
		finding.line !== undefined &&
		(lines.get(finding.file) ?? []).some(
			([start, end]) =>
				finding.line !== undefined && finding.line >= start && finding.line <= end
		);
	const inline = findings.filter(inDiff);
	const rest = findings.filter((finding) => !inDiff(finding));
	const bySeverity = (severity: VerifiedFinding['severity']) =>
		findings.filter((finding) => finding.severity === severity).length;
	const mustFix = bySeverity('must-fix');
	const body = [
		`ship review found ${count(mustFix, 'must-fix finding')}, ${count(bySeverity('tradeoff'), 'tradeoff')} and ${count(bySeverity('nit'), 'nit')}.`,
		...(rest.length === 0
			? []
			: [
					'',
					'Findings outside the diff:',
					'',
					...rest.map((finding) => `- \`${location(finding)}\`: ${describe(finding)}`)
				])
	].join('\n');
	return {
		event: mustFix > 0 ? 'REQUEST_CHANGES' : 'COMMENT',
		body,
		comments: inline.map((finding) => ({
			path: finding.file,
			line: finding.line,
			body: describe(finding)
		})),
		inBody: rest.length
	};
};

/** What the reviewers check the PR against: its description. */
const prIntent = (state: ReviewRunState): ChangeIntent =>
	ChangeIntent.Description({ title: state.pr.title, body: state.pr.body });

/** The checkout the run started in, where its worktree is added and removed. */
const userRepo = (state: ReviewRunState) => ({ cwd: state.repoDir, env: state.env });

/** Adds the run's worktree at the PR's pinned head; a resumed run keeps the one it has. */
export const prepareStep = (state: ReviewRunState) =>
	runStep('prepare', state, { timeoutMs: null }, () =>
		Effect.gen(function* () {
			const git = yield* Git;
			yield* git.addWorktree(userRepo(state), { path: state.cwd, sha: state.pr.headSha });
		})
	);

/** Posts the verified findings of the round as one review on the PR's pinned head. */
export const postStep = (state: ReviewRunState) =>
	runStep('post', state, { timeoutMs: null }, (kit) =>
		Effect.gen(function* () {
			const round = state.reviewRounds.at(-1);
			if (round === undefined) {
				return yield* new StepNotReady({ reason: 'No review round to post' });
			}
			const git = yield* Git;
			const gh = yield* Gh;
			const diff = yield* git.diff(state, { from: state.baseSha, to: state.pr.headSha });
			const review = reviewToPost(round.findings, diff);
			const url = yield* gh.submitReview(userRepo(state), {
				prUrl: state.pr.url,
				commitId: state.pr.headSha,
				event: review.event,
				body: review.body,
				comments: review.comments
			});
			yield* kit.report({
				_tag: 'PrReviewPosted',
				url,
				event: review.event,
				inline: review.comments.length,
				inBody: review.inBody
			});
			return url;
		})
	);

const step = <A, R>(run: (state: ReviewRunState) => Effect.Effect<StepOutcome<A>, never, R>) =>
	createEffectLogic({ schemas: { input: ReviewRunState }, effect: ({ input }) => run(input) });

type Settled = 'route' | 'review' | 'verify' | 'post' | 'done' | 'failed';

interface Next {
	readonly target: Settled;
	readonly context: ReviewRunState;
}

const fail = (context: ReviewRunState, error: string): Next => ({
	target: 'failed',
	context: { ...context, error }
});

/** Where a step's outcome leads: any failed step fails the run. */
const settle = <A>(
	context: ReviewRunState,
	outcome: StepOutcome<A>,
	onOk: (context: ReviewRunState, output: A) => Next
): Next => {
	const spent = { ...context, costUsd: context.costUsd + outcome.spent.costUsd };
	return outcome._tag === 'Ok'
		? onOk(spent, outcome.output)
		: fail(spent, outcome.failure.message);
};

const onDefect = ({
	context,
	event
}: {
	context: ReviewRunState;
	event: { error: unknown };
}): Next => fail(context, describeDefect(event.error));

/** After `verify`: `post` when asked to and there is something to post, else `done`. */
const afterVerify = (context: ReviewRunState): Next =>
	context.post && (context.reviewRounds.at(-1)?.findings.length ?? 0) > 0
		? { target: 'post', context }
		: { target: 'done', context };

/**
 * The review machine. Like the pipeline, each working state invokes one step actor and
 * its `onDone` picks the next state; the round's states share the pipeline's names,
 * steps and reducers.
 */
export const reviewMachine = setupEffect({
	schemas: {
		input: ReviewRunState,
		context: ReviewRunState,
		events: { cancel: Schema.Struct({}) }
	},
	actors: {
		prepare: step(prepareStep),
		route: step(routeStep),
		review: step((state) => reviewStep(state, prIntent(state))),
		verify: step((state) => verifyStep(state, prIntent(state))),
		post: step(postStep)
	}
}).createMachine({
	id: 'review',
	context: ({ input }) => input,
	initial: 'prepare',
	on: { cancel: { target: '.cancelled' } },
	states: {
		prepare: {
			invoke: {
				src: 'prepare',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next) => ({ target: 'route', context: next })),
				onError: onDefect
			}
		},
		route: {
			invoke: {
				src: 'route',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, review) => ({
						target: 'review',
						context: startRound(next, review)
					})),
				onError: onDefect
			}
		},
		review: {
			invoke: {
				src: 'review',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, findings) => ({
						target: 'verify',
						context: withFindings(next, findings)
					})),
				onError: onDefect
			}
		},
		verify: {
			invoke: {
				src: 'verify',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, verified) => {
						const completed = completeRound(next, verified);
						return completed === null
							? fail(next, 'No review round is in progress')
							: afterVerify(completed);
					}),
				onError: onDefect
			}
		},
		post: {
			invoke: {
				src: 'post',
				input: stepInput,
				onDone: ({ context, event }) =>
					settle(context, event.output, (next, reviewUrl) => ({
						target: 'done',
						context: { ...next, reviewUrl }
					})),
				onError: onDefect
			}
		},
		done: { type: 'final' },
		failed: { type: 'final' },
		cancelled: { type: 'final' }
	}
});

/** The review machine's type, for the driver and the services its steps require. */
export type ReviewMachine = typeof reviewMachine;
