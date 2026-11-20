import { Context, Effect, Layer, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import type { GitRepo } from './git.ts';
import { parsePrUrl, PR_URL } from './pr-url.ts';
import { exec } from './process.ts';
import { GitSha, Url } from './values.ts';

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
	/** The PR's branch, on its head repository. */
	readonly headRef: string;
	/**
	 * The repository the PR's branch lives on, or `null` when it was deleted. It is the
	 * base repository unless `isCrossRepository`.
	 */
	readonly headRepository: { readonly owner: string; readonly name: string } | null;
	/** The PR comes from a fork. */
	readonly isCrossRepository: boolean;
	/** The base repository's maintainers may push to the PR's branch on the fork. */
	readonly maintainerCanModify: boolean;
}

/**
 * An unresolved review thread on a PR's current diff, as its first comment opened it.
 * Replies are left out: the first comment says what to fix.
 */
export interface ReviewThread {
	/** The thread's GraphQL node id, which `resolveThread` takes. */
	readonly id: string;
	/** Repo-relative path the thread is on. */
	readonly path: string;
	/** The line on the diff's new side, or `null` for a thread on the whole file. */
	readonly line: number | null;
	/** The first comment's author's login, or `null` when the account was deleted. */
	readonly author: string | null;
	/**
	 * The first comment's author owns the repository or may push to it: GitHub's
	 * `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`.
	 */
	readonly authorCanWrite: boolean;
	readonly body: string;
	/** The first comment's URL. */
	readonly url: string;
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

/**
 * The few `gh` commands ship needs: opening and reading PRs, posting reviews, and reading
 * and resolving review threads. Bodies go through stdin, never argv.
 */
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
	/**
	 * The PR's review threads that are neither resolved nor outdated, oldest first: the
	 * comments that still ask for something on the PR's current diff.
	 */
	readonly reviewThreads: (
		repo: GitRepo,
		prUrl: string
	) => Effect.Effect<ReadonlyArray<ReviewThread>, GhError>;
	/** Marks one review thread of the PR resolved; resolving a resolved thread is a no-op. */
	readonly resolveThread: (
		repo: GitRepo,
		input: { readonly prUrl: string; readonly threadId: string }
	) => Effect.Effect<void, GhError>;
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
		headRefOid: GitSha,
		headRefName: Schema.String,
		headRepository: Schema.NullOr(Schema.Struct({ name: Schema.String })),
		headRepositoryOwner: Schema.NullOr(Schema.Struct({ login: Schema.String })),
		isCrossRepository: Schema.Boolean,
		maintainerCanModify: Schema.Boolean
	})
);

const PR_VIEW_FIELDS = [
	'number',
	'url',
	'title',
	'body',
	'baseRefName',
	'headRefOid',
	'headRefName',
	'headRepository',
	'headRepositoryOwner',
	'isCrossRepository',
	'maintainerCanModify'
].join(',');

/**
 * A PR's review threads, 100 a page; `gh api graphql --paginate` follows `endCursor`.
 * Only the first comment of each thread is read.
 */
const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 1) { nodes { author { login } authorAssociation body url } }
        }
      }
    }
  }
}`;

/** The `authorAssociation`s of accounts that own a repository or may push to it. */
const WRITE_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const RESOLVE_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

/** One line of `reviewThreads`' `--jq` output: one thread. */
const ListedThread = Schema.fromJsonString(
	Schema.Struct({
		id: Schema.String,
		isResolved: Schema.Boolean,
		isOutdated: Schema.Boolean,
		path: Schema.String,
		line: Schema.NullOr(Schema.Int),
		comments: Schema.Struct({
			nodes: Schema.Array(
				Schema.Struct({
					author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
					authorAssociation: Schema.String,
					body: Schema.String,
					url: Url
				})
			)
		})
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
		const args = ['pr', 'view', ref, '--json', PR_VIEW_FIELDS];
		const view = yield* Schema.decodeUnknownEffect(PrView)(yield* run(repo, args)).pipe(
			Effect.mapError(unexpected(repo, args))
		);
		return {
			number: view.number,
			url: view.url,
			title: view.title,
			body: view.body,
			baseRef: view.baseRefName,
			headSha: view.headRefOid,
			headRef: view.headRefName,
			headRepository:
				view.headRepository === null || view.headRepositoryOwner === null
					? null
					: { owner: view.headRepositoryOwner.login, name: view.headRepository.name },
			isCrossRepository: view.isCrossRepository,
			maintainerCanModify: view.maintainerCanModify
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

	const reviewThreads = Effect.fn('Gh.reviewThreads')(function* (repo: GitRepo, prUrl: string) {
		const pr = parsePrUrl(prUrl);
		if (pr === null) return yield* Effect.die(new Error(`Not a pull request URL: ${prUrl}`));
		// `--jq` prints one thread per line, across every page `--paginate` fetches.
		const args = [
			'api',
			'graphql',
			'--hostname',
			pr.host,
			'--paginate',
			'-f',
			`query=${REVIEW_THREADS_QUERY}`,
			'-f',
			`owner=${pr.owner}`,
			'-f',
			`name=${pr.name}`,
			'-F',
			`number=${pr.number}`,
			'--jq',
			'.data.repository.pullRequest.reviewThreads.nodes[]'
		];
		const stdout = yield* run(repo, args);
		const lines = stdout.split('\n').filter((line) => line.trim() !== '');
		const threads = yield* Effect.forEach(lines, (line) =>
			Schema.decodeUnknownEffect(ListedThread)(line).pipe(
				Effect.mapError(unexpected(repo, args))
			)
		);
		return threads.flatMap((thread): ReadonlyArray<ReviewThread> => {
			const [first] = thread.comments.nodes;
			if (thread.isResolved || thread.isOutdated || first === undefined) return [];
			return [
				{
					id: thread.id,
					path: thread.path,
					line: thread.line,
					author: first.author?.login ?? null,
					authorCanWrite: WRITE_ASSOCIATIONS.has(first.authorAssociation),
					body: first.body,
					url: first.url
				}
			];
		});
	});

	const resolveThread = Effect.fn('Gh.resolveThread')(function* (
		repo: GitRepo,
		input: { readonly prUrl: string; readonly threadId: string }
	) {
		const pr = parsePrUrl(input.prUrl);
		if (pr === null)
			return yield* Effect.die(new Error(`Not a pull request URL: ${input.prUrl}`));
		yield* run(repo, [
			'api',
			'graphql',
			'--hostname',
			pr.host,
			'-f',
			`query=${RESOLVE_THREAD_MUTATION}`,
			'-f',
			`threadId=${input.threadId}`
		]);
	});

	return Gh.of({
		findPr,
		createPr,
		editPr,
		markDraft,
		viewPr,
		submitReview,
		findReview,
		reviewThreads,
		resolveThread
	});
});

/** Runs the real `gh` CLI in the caller's repo, with the caller's env. */
export class Gh extends Context.Service<Gh, GhShape>()('@ship/core/Gh') {
	static readonly layer = Layer.effect(this, make);
}
