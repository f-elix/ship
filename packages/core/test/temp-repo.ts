import { NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Git, type GitRepo } from '../src/index.ts';

/** `Git` on real processes and files. */
export const GitLive = Git.layer.pipe(Layer.provide(NodeServices.layer));

/** A temp dir, realpath'd (macOS tmp is a symlink), deleted when the scope closes. */
export const tempDir = Effect.acquireRelease(
	Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), 'ship-core-')))),
	(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
);

/** An env isolated from the user's git config, so signing or hooks never apply. */
export const isolatedEnv = (home: string): Record<string, string> => ({
	PATH: process.env['PATH'] ?? '/usr/bin:/bin',
	HOME: home,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_AUTHOR_NAME: 'Ship Test',
	GIT_AUTHOR_EMAIL: 'ship@example.com',
	GIT_COMMITTER_NAME: 'Ship Test',
	GIT_COMMITTER_EMAIL: 'ship@example.com'
});

export interface TempRepo {
	readonly dir: string;
	/** The working repo, on a new branch `feature` at `main`'s initial commit. */
	readonly work: string;
	/** A bare repo set as the work repo's `origin`. */
	readonly origin: string;
	readonly repo: GitRepo;
	/** Runs git in the work repo and returns trimmed stdout. */
	readonly git: (...args: ReadonlyArray<string>) => string;
	readonly write: (path: string, content: string) => void;
}

const makeRepo = (dir: string, options: { readonly origin: boolean }): TempRepo => {
	const env = isolatedEnv(dir);
	const work = join(dir, 'work');
	const origin = join(dir, 'origin.git');
	const run = (cwd: string, args: ReadonlyArray<string>) =>
		execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
	const git = (...args: ReadonlyArray<string>) => run(work, args);
	const write = (path: string, content: string) => {
		mkdirSync(dirname(join(work, path)), { recursive: true });
		writeFileSync(join(work, path), content);
	};

	mkdirSync(work);
	git('init', '--quiet', '-b', 'main');
	write('README.md', 'hello\n');
	git('add', '.');
	git('commit', '--quiet', '-m', 'Initial commit');
	if (options.origin) {
		run(dir, ['init', '--quiet', '--bare', '-b', 'main', origin]);
		git('remote', 'add', 'origin', origin);
		git('push', '--quiet', '-u', 'origin', 'main');
		git('remote', 'set-head', 'origin', 'main');
	}
	git('switch', '--quiet', '-c', 'feature');
	return { dir, work, origin, repo: { cwd: work, env }, git, write };
};

/** A work repo with a bare `origin`, deleted when the scope closes. */
export const tempRepo = Effect.map(tempDir, (dir) => makeRepo(dir, { origin: true }));

/** A work repo with no remote. */
export const tempRepoWithoutOrigin = Effect.map(tempDir, (dir) => makeRepo(dir, { origin: false }));
