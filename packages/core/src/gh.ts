import { Context, Effect, Layer, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import type { GitRepo } from './git.ts';
import { GitSha, Url } from './primitives.ts';
import { exec } from './process.ts';
import { normalizeRemoteUrl } from './project-key.ts';

/** An open pull request. */
export interface PullRequest {
	readonly url: string;
	readonly number: number;
	readonly isDraft: boolean;
}

export interface CreatePrInput {
	/** The branch to merge into, normally the default branch. */
	readonly base: string;
	readonly head: string;
	readonly title: string;
	readonly body: string;
	readonly draft: boolean;
}

/** A pull request as `ship review` reads it. */
export interface PrDetails {
	readonly number: number;
	readonly url: string;
	readonly title: string;
	readonly body: string;
	/** The branch the PR merges into. */
	readonly baseRef: string;
	readonly headSha: GitSha;
}

/** What a posted review says about the PR; GitHub never gets an `APPROVE` from ship. */
export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES';

/** A review comment on one line of the PR's diff, on its new side. */
export interface ReviewComment {
	readonly path: string;
	readonly line: number;
	readonly body: string;
}

/** One review to post on a pull request: its verdict, its body and its inline comments. */
export interface SubmitReviewInput {
	/** The PR's URL, as `viewPr` returned it; the review goes to its repository. */
	readonly prUrl: string;
	/** The commit the review is about; comments anchor to its diff. */
	readonly commitId: GitSha;
	readonly event: ReviewEvent;
	readonly body: string;
	readonly comments: ReadonlyArray<ReviewComment>;
}

const PR_URL = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/u;

/** The parts of a pull request URL, or `null` when `url` is not one. */
export const parsePrUrl = (
	url: string
): {
	readonly host: string;
	readonly owner: string;
	readonly name: string;
	readonly number: number;
} | null => {
	const match = PR_URL.exec(url.trim());
	if (match === null) return null;
	const [, host = '', owner = '', name = '', number = ''] = match;
	return { host: host.toLowerCase(), owner, name, number: Number(number) };
};

/**
 * The repository of a pull request URL, normalized like a remote URL so it compares with
 * a project key: `https://github.com/f-elix/ship/pull/3` gives `github.com/f-elix/ship`.
 * `null` when `url` is not a pull request URL.
 */
export const prRepoKey = (url: string): string | null => {
	const parts = parsePrUrl(url);
	return parts === null
		? null
		: normalizeRemoteUrl(`https://${parts.host}/${parts.owner}/${parts.name}`);
};

/** A `gh` command failed. `exitCode` is `null` when `gh` could not be started at all. */
export class GhError extends Schema.TaggedError<GhError>()('GhError', {
	args: Schema.Array(Schema.String),
	cwd: Schema.String,
	exitCode: Schema.NullOr(Schema.Int),
	stderr: Schema.String
}) {
	override get message(): string {
		const status = this.exitCode === null ? 'could not run' : `exited with ${this.exitCode}`;
		return `gh ${this.args.join(' ')} ${status} in ${this.cwd}: ${this.stderr.trim()}`;
	}
}

/** The few `gh` commands the PR step needs. Bodies go through stdin, never argv. */
export interface GhShape {
	/** The open PR whose head is `branch`, or `null`. */
	readonly findPr: (repo: GitRepo, branch: string) => Effect.Effect<PullRequest | null, GhError>;
	/** Opens a PR and returns its URL. */
	readonly createPr: (repo: GitRepo, input: CreatePrInput) => Effect.Effect<string, GhError>;
	readonly editPr: (
		repo: GitRepo,
		input: { readonly url: string; readonly title: string; readonly body: string }
	) => Effect.Effect<void, GhError>;
	/** Turns a ready PR back into a draft. */
	readonly markDraft: (repo: GitRepo, url: string) => Effect.Effect<void, GhError>;
	/** The PR `ref` names: a number in `repo`'s GitHub repository, or a PR URL. */
	readonly viewPr: (repo: GitRepo, ref: string) => Effect.Effect<PrDetails, GhError>;
	/** Posts one review on a PR and returns the review's URL. */
	readonly submitReview: (
		repo: GitRepo,
		input: SubmitReviewInput
	) => Effect.Effect<string, GhError>;
	/**
	 * The URL of the PR's first review whose body contains `marker`, or `null`. It is how
	 * a resumed run finds a review it posted before it could record posting it.
	 */
	readonly findReview: (
		repo: GitRepo,
		input: { readonly prUrl: string; readonly marker: string }
	) => Effect.Effect<string | null, GhError>;
}

const PrList = Schema.fromJsonString(
	Schema.Array(
		Schema.Struct({
			url: Schema.String,
			number: Schema.Int,
			isDraft: Schema.Boolean,
			isCrossRepository: Schema.Boolean
		})
	)
);

const PrView = Schema.fromJsonString(
	Schema.Struct({
		number: Schema.Int,
		url: Schema.String.check(Schema.isPattern(PR_URL, { expected: 'a pull request URL' })),
		title: Schema.String,
		body: Schema.String,
		baseRefName: Schema.String,
		headRefOid: GitSha
	})
);

const PostedReview = Schema.fromJsonString(Schema.Struct({ html_url: Url }));

/** One line of `findReview`'s `--jq` output: a review's URL and body. */
const ListedReview = Schema.fromJsonString(
	Schema.Struct({ html_url: Url, body: Schema.NullOr(Schema.String) })
);

const make = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const encoder = new TextEncoder();

	const run = (repo: GitRepo, args: ReadonlyArray<string>, stdin?: string) =>
		exec(
			ChildProcess.make('gh', args, {
				cwd: repo.cwd,
				env: { ...repo.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
				extendEnv: false,
				stdin: stdin === undefined ? 'ignore' : Stream.make(encoder.encode(stdin))
			})
		).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			Effect.mapError(
				(error) =>
					new GhError({ args, cwd: repo.cwd, exitCode: null, stderr: error.message })
			),
			Effect.flatMap((output) =>
				output.exitCode === 0
					? Effect.succeed(output.stdout)
					: Effect.fail(
							new GhError({
								args,
								cwd: repo.cwd,
								exitCode: output.exitCode,
								stderr: output.stderr
							})
						)
			)
		);

	const findPr = Effect.fn('Gh.findPr')(function* (repo: GitRepo, branch: string) {
		const args = [
			'pr',
			'list',
			'--head',
			branch,
			'--state',
			'open',
			'--json',
			'url,number,isDraft,isCrossRepository'
		];
		const stdout = yield* run(repo, args);
		const prs = yield* Schema.decodeUnknownEffect(PrList)(stdout).pipe(
			Effect.mapError(
				(error) =>
					new GhError({
						args,
						cwd: repo.cwd,
						exitCode: 0,
						stderr: `Unexpected output: ${error.message}`
					})
			)
		);
		// `--head` matches the branch name only, so a fork's PR from a same-named branch
		// would match too; only a PR from this repository's branch is ship's.
		const own = prs.find((pr) => !pr.isCrossRepository);
		return own === undefined
			? null
			: { url: own.url, number: own.number, isDraft: own.isDraft };
	});

	const createPr = Effect.fn('Gh.createPr')(function* (repo: GitRepo, input: CreatePrInput) {
		const args = [
			'pr',
			'create',
			'--base',
			input.base,
			'--head',
			input.head,
			'--title',
			input.title,
			'--body-file',
			'-',
			...(input.draft ? ['--draft'] : [])
		];
		const stdout = yield* run(repo, args, input.body);
		// `gh pr create` prints the new PR's URL as its last line.
		const url = stdout.trim().split('\n').at(-1)?.trim() ?? '';
		if (!Schema.is(Url)(url)) {
			return yield* new GhError({
				args,
				cwd: repo.cwd,
				exitCode: 0,
				stderr: `Expected the new PR's URL, got "${url}"`
			});
		}
		return url;
	});

	const editPr = Effect.fn('Gh.editPr')(function* (
		repo: GitRepo,
		input: { readonly url: string; readonly title: string; readonly body: string }
	) {
		yield* run(
			repo,
			['pr', 'edit', input.url, '--title', input.title, '--body-file', '-'],
			input.body
		);
	});

	const markDraft = Effect.fn('Gh.markDraft')(function* (repo: GitRepo, url: string) {
		yield* run(repo, ['pr', 'ready', url, '--undo']);
	});

	const unexpected = (repo: GitRepo, args: ReadonlyArray<string>) => (error: Error) =>
		new GhError({
			args,
			cwd: repo.cwd,
			exitCode: 0,
			stderr: `Unexpected output: ${error.message}`
		});

	const viewPr = Effect.fn('Gh.viewPr')(function* (repo: GitRepo, ref: string) {
		const args = ['pr', 'view', ref, '--json', 'number,url,title,body,baseRefName,headRefOid'];
		const view = yield* Schema.decodeUnknownEffect(PrView)(yield* run(repo, args)).pipe(
			Effect.mapError(unexpected(repo, args))
		);
		return {
			number: view.number,
			url: view.url,
			title: view.title,
			body: view.body,
			baseRef: view.baseRefName,
			headSha: view.headRefOid
		} satisfies PrDetails;
	});

	const submitReview = Effect.fn('Gh.submitReview')(function* (
		repo: GitRepo,
		input: SubmitReviewInput
	) {
		const pr = parsePrUrl(input.prUrl);
		// `viewPr` decodes only pull request URLs.
		if (pr === null)
			return yield* Effect.die(new Error(`Not a pull request URL: ${input.prUrl}`));
		const args = [
			'api',
			'--hostname',
			pr.host,
			'--method',
			'POST',
			`repos/${pr.owner}/${pr.name}/pulls/${pr.number}/reviews`,
			'--input',
			'-'
		];
		const payload = JSON.stringify({
			commit_id: input.commitId,
			event: input.event,
			body: input.body,
			comments: input.comments.map((comment) => ({ ...comment, side: 'RIGHT' }))
		});
		const posted = yield* Schema.decodeUnknownEffect(PostedReview)(
			yield* run(repo, args, payload)
		).pipe(Effect.mapError(unexpected(repo, args)));
		return posted.html_url;
	});

	const findReview = Effect.fn('Gh.findReview')(function* (
		repo: GitRepo,
		input: { readonly prUrl: string; readonly marker: string }
	) {
		const pr = parsePrUrl(input.prUrl);
		if (pr === null)
			return yield* Effect.die(new Error(`Not a pull request URL: ${input.prUrl}`));
		// `--jq` prints one review per line, across every page `--paginate` fetches.
		const args = [
			'api',
			'--hostname',
			pr.host,
			'--paginate',
			`repos/${pr.owner}/${pr.name}/pulls/${pr.number}/reviews`,
			'--jq',
			'.[] | {html_url, body}'
		];
		const stdout = yield* run(repo, args);
		const lines = stdout.split('\n').filter((line) => line.trim() !== '');
		const reviews = yield* Effect.forEach(lines, (line) =>
			Schema.decodeUnknownEffect(ListedReview)(line).pipe(
				Effect.mapError(unexpected(repo, args))
			)
		);
		return (
			reviews.find((review) => review.body?.includes(input.marker) ?? false)?.html_url ?? null
		);
	});

	return Gh.of({ findPr, createPr, editPr, markDraft, viewPr, submitReview, findReview });
});

/** Runs the real `gh` CLI in the caller's repo, with the caller's env. */
export class Gh extends Context.Service<Gh, GhShape>()('@ship/core/Gh') {
	static readonly layer = Layer.effect(this, make);
}
