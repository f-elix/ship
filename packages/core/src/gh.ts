import { Context, Effect, Layer, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import type { GitRepo } from './git.ts';
import { Url } from './primitives.ts';
import { exec } from './process.ts';

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

	return Gh.of({ findPr, createPr, editPr, markDraft });
});

/** Runs the real `gh` CLI in the caller's repo, with the caller's env. */
export class Gh extends Context.Service<Gh, GhShape>()('@ship/core/Gh') {
	static readonly layer = Layer.effect(this, make);
}
