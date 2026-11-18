import { NodeServices } from '@effect/platform-node';
import {
	BUILTIN_BRIEFS_DIR,
	projectKeyOf,
	shipPaths,
	type AgentRunInput,
	type RunId
} from '@ship/core';
import { AgentFake, GhFake, type AgentReply, type AgentScript } from '@ship/core/testing';
import { Context, Effect, Layer, References, Schedule, Stream } from 'effect';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DaemonClient, startDaemon } from '../src/index.ts';

export const VERSION = '1.2.3-test';

/** A temp dir, realpath'd (macOS tmp is a symlink), deleted when the scope closes. */
export const tempDir = Effect.acquireRelease(
	Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), 'ship-daemon-')))),
	(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
);

/** An env isolated from the user's git config, so signing or hooks never apply. */
const isolatedEnv = (home: string): Record<string, string> => ({
	PATH: process.env['PATH'] ?? '/usr/bin:/bin',
	HOME: home,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_AUTHOR_NAME: 'Ship Test',
	GIT_AUTHOR_EMAIL: 'ship@example.com',
	GIT_COMMITTER_NAME: 'Ship Test',
	GIT_COMMITTER_EMAIL: 'ship@example.com',
	// Only the caller has it; the project's check fails without it.
	SHIP_CALLER: 'yes'
});

export interface Fixture {
	readonly dir: string;
	/** Ship's home, with a global config and the repo's project config. */
	readonly home: string;
	/** The work repo, on branch `feature`, with a bare `origin`. */
	readonly work: string;
	/** Inside the repo and untracked, as plan dirs usually are. */
	readonly planDir: string;
	/** The caller's env. */
	readonly env: Record<string, string>;
	readonly git: (...args: ReadonlyArray<string>) => string;
	readonly write: (path: string, content: string) => void;
	/** Rewrites the global config and the project config. */
	readonly configure: (global: unknown, project: unknown) => void;
	/** The `run` payload for this repo and plan. */
	readonly request: {
		readonly planDir: string;
		readonly cwd: string;
		readonly env: Record<string, string>;
	};
}

/** Built-in reviewers other than `standards`, disabled to keep agent scripts short. */
const otherReviewers = readdirSync(join(BUILTIN_BRIEFS_DIR, 'reviewers'))
	.map((file) => file.replace(/\.md$/u, ''))
	.filter((name) => name !== 'standards');

/** A temp home, a temp repo with a plan, and the project config the daemon needs. */
export const fixture = Effect.gen(function* () {
	const dir = yield* tempDir;
	const home = join(dir, 'home');
	const work = join(dir, 'work');
	const origin = join(dir, 'origin.git');
	const env = isolatedEnv(dir);
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
	run(dir, ['init', '--quiet', '--bare', '-b', 'main', origin]);
	git('remote', 'add', 'origin', origin);
	git('push', '--quiet', '-u', 'origin', 'main');
	git('remote', 'set-head', 'origin', 'main');
	git('switch', '--quiet', '-c', 'feature');

	const planDir = join(work, '.plans/feature');
	write('.plans/feature/spec.md', '# Spec\n');
	write('.plans/feature/implementation-plan.md', '# Plan\n');

	const paths = shipPaths(home);
	const projectKey = projectKeyOf({ remoteUrl: origin, repoRoot: work });
	mkdirSync(dirname(paths.projectConfig(projectKey)), { recursive: true });
	const configure = (global: unknown, project: unknown) => {
		writeFileSync(paths.globalConfig, JSON.stringify(global));
		writeFileSync(paths.projectConfig(projectKey), JSON.stringify(project));
	};
	configure(
		{ locks: { cpu: 2 } },
		{
			checks: [{ name: 'caller-env', run: 'test "$SHIP_CALLER" = yes' }],
			reviewers: { disable: otherReviewers, llmRouter: false }
		}
	);

	return {
		dir,
		home,
		work,
		planDir,
		env,
		git,
		write,
		configure,
		request: { planDir, cwd: work, env }
	} satisfies Fixture;
});

/** Fake Agent SDK and GitHub, built once so tests can script and inspect them. */
export const fakes = Layer.build(Layer.mergeAll(AgentFake.layer, GhFake.layer));
export type Fakes = Effect.Success<typeof fakes>;

/** Starts a daemon in the current scope, in `home`, on the given fakes. */
export const daemon = (home: string, services: Fakes, version = VERSION) =>
	startDaemon({ home, version, services: Layer.succeedContext(services) }).pipe(
		Effect.provide(NodeServices.layer),
		Effect.provideService(References.MinimumLogLevel, 'Warn')
	);

/** An RPC client of the daemon in `home`, connected until the current scope closes. */
export const client = (home: string) =>
	Effect.map(Layer.build(DaemonClient.layer(shipPaths(home).socket)), (context) =>
		Context.get(context, DaemonClient)
	);

/** Every event of the run, replayed and followed until the stream ends. */
export const allEvents = (rpc: DaemonClient['Service'], runId: RunId) =>
	rpc.events({ runId }).pipe(
		Stream.map((envelope) => envelope.event._tag),
		Stream.runCollect,
		Effect.map((tags) => Array.from(tags))
	);

/** An implementer call that adds `src/feature.ts`, as a real agent would. */
export const addsFeature = (input: AgentRunInput): Effect.Effect<AgentReply> =>
	Effect.sync(() => {
		mkdirSync(join(input.cwd, 'src'), { recursive: true });
		writeFileSync(join(input.cwd, 'src/feature.ts'), 'export const feature = 1;\n');
		return { costUsd: 0.5 };
	});

/** Implementer, reviewer and PR answers for a run that ends with a PR. */
export const scriptHappyRun = (
	agent: Context.Service.Shape<typeof AgentFake>,
	implement: AgentScript = addsFeature
) =>
	Effect.all([
		agent.script({ step: 'implement' }, implement),
		agent.script(
			{ step: 'review', label: 'standards' },
			{ output: { findings: [] }, costUsd: 0.1 }
		),
		agent.script(
			{ step: 'pr' },
			{ output: { title: 'Add the feature', body: '## Summary\n\nAdds it.' }, costUsd: 0.05 }
		)
	]);

/** Polls `check` until it holds. */
export const eventually = <E, R>(check: Effect.Effect<boolean, E, R>) =>
	check.pipe(
		Effect.filterOrFail(
			(ok) => ok,
			() => 'not yet' as const
		),
		Effect.retry({ schedule: Schedule.spaced('25 millis'), times: 400 })
	);
