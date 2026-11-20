import { describe, expect, it } from '@effect/vitest';
import {
	AgentSdkError,
	DaemonBusy,
	FindingId,
	RunId,
	RunStatus,
	shipPaths,
	type GitSha
} from '@ship/core';
import { AgentFake, GhFake, opensPr, type AgentScript } from '@ship/core/testing';
import {
	addsFeature,
	client,
	cloneOfExample,
	daemon,
	daemonProcess,
	eventually,
	fakes,
	fixture,
	hangingFakes,
	reachState,
	scriptHappyRun,
	tempDir,
	VERSION,
	type Fakes,
	type Fixture
} from '@ship/daemon/testing';
import { ConfigProvider, Context, Duration, Effect, Exit, Fiber, Scope } from 'effect';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { busyMessage } from '../src/connection.ts';
import { Invocation } from '../src/invocation.ts';
import { DETACHED_EXIT_CODE, exitCodeFor, exitCodeForSummary } from '../src/render.ts';
import { cli, fakeDaemonLauncher, testTimeouts, type Captured } from './support.ts';

const TIMEOUT = 60_000;

/** `ship <args>` run from the fixture's repo, with its env. */
const shipIn = (fx: Fixture, args: ReadonlyArray<string>, captured?: Captured) =>
	cli(args, { home: fx.home, cwd: fx.work, env: fx.env, ...(captured ? { captured } : {}) });

/** A daemon on fakes whose implementer never ends, so its runs stay active. */
const hangingDaemon = (fx: Fixture) =>
	Effect.gen(function* () {
		yield* daemon(fx.home, yield* hangingFakes);
		return yield* client(fx.home);
	});

const parseSummary = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

/** A fix call that rewrites `src/feature.ts`, as a real agent would. */
const addsFeatureFix: AgentScript = (input) =>
	Effect.sync(() => {
		writeFileSync(join(input.cwd, 'src/feature.ts'), 'export const feature = () => 1;\n');
		return { costUsd: 0.4 };
	});

describe('exit codes', () => {
	it('maps how a run ended to 0 done, 2 escalated, 1 otherwise', () => {
		const codes = Object.fromEntries(
			RunStatus.literals.map((status) => [status, exitCodeFor(status)])
		);
		expect(codes).toEqual({
			running: 1,
			waiting: 1,
			done: 0,
			escalated: 2,
			failed: 1,
			cancelled: 1,
			interrupted: 1
		});
		expect(DETACHED_EXIT_CODE).toBe(130);
	});

	it('exits a finished review 2 when it verified must-fix findings and 0 otherwise', () => {
		const mustFix = {
			id: FindingId.make('r1-1'),
			round: 1,
			alsoReportedBy: [],
			reviewer: 'standards',
			file: 'src/a.ts',
			line: 1,
			severity: 'must-fix' as const,
			claim: 'Broken',
			evidence: 'a'
		};
		const review = (
			status: 'done' | 'failed' | 'cancelled',
			found: ReadonlyArray<typeof mustFix>
		) =>
			exitCodeForSummary({
				kind: 'review',
				runId: RunId.make('20261117-120000-abcdef'),
				status,
				prUrl: 'https://github.com/f-elix/example/pull/1',
				reviewUrl: null,
				costUsd: 0,
				mustFix: found,
				tradeoffs: [],
				nits: [],
				error: null
			});

		expect(review('done', [])).toBe(0);
		expect(review('done', [mustFix])).toBe(2);
		expect(review('failed', [mustFix])).toBe(1);
		expect(review('cancelled', [])).toBe(1);
	});

	const runId = RunId.make('20261120-120000-abcdef');
	const prUrl = 'https://github.com/f-elix/example/pull/1';
	const finding = {
		id: FindingId.make('t1'),
		round: 1,
		alsoReportedBy: [],
		reviewer: 'github:octocat',
		file: 'src/a.ts',
		severity: 'must-fix' as const,
		claim: 'Broken',
		evidence: `${prUrl}#discussion_r1`
	};

	it('exits a finished recheck 2 while a finding is unfixed and 0 once all are fixed', () => {
		const recheck = (status: 'done' | 'failed', statuses: ReadonlyArray<'fixed' | 'unfixed'>) =>
			exitCodeForSummary({
				kind: 'recheck',
				runId,
				status,
				prUrl,
				findings: statuses.map((found) => ({ finding, status: found, evidence: 'Seen' })),
				resolvedThreads: [],
				ignoredThreads: [],
				costUsd: 0,
				error: null
			});

		expect(recheck('done', ['fixed', 'fixed'])).toBe(0);
		expect(recheck('done', ['fixed', 'unfixed'])).toBe(2);
		expect(recheck('failed', ['fixed'])).toBe(1);
		// A recheck that failed before it found anything is a failure, not a pass.
		expect(recheck('failed', [])).toBe(1);
	});

	it('exits a fix like a run: 0 done, 1 failed or cancelled', () => {
		const fix = (status: 'done' | 'failed' | 'cancelled') =>
			exitCodeForSummary({
				kind: 'fix',
				runId,
				status,
				prUrl,
				findings: [finding],
				ignoredThreads: [],
				commits: [],
				pushed: false,
				checks: [],
				costUsd: 0,
				error: null
			});

		expect([fix('done'), fix('failed'), fix('cancelled')]).toEqual([0, 1, 1]);
	});
});

describe('stop refusal', () => {
	const busy = (activeRuns: number, activeCheckPasses: number) =>
		busyMessage(new DaemonBusy({ activeRuns, activeCheckPasses }));

	it('names the active runs and check passes, and what --force does', () => {
		expect(busy(2, 0)).toBe(
			'2 runs are active: the daemon is not stopped until they finish, unless you pass --force, which interrupts them (`ship resume <id>` continues them).'
		);
		expect(busy(0, 1)).toBe(
			'1 check pass in progress: the daemon is not stopped until it finishes, unless you pass --force, which interrupts it.'
		);
		expect(busy(0, 2)).toBe(
			'2 check passes in progress: the daemon is not stopped until they finish, unless you pass --force, which interrupts them.'
		);
		expect(busy(1, 1)).toBe(
			'1 run is active and 1 check pass in progress: the daemon is not stopped until they finish, unless you pass --force, which interrupts them (`ship resume <id>` continues the runs).'
		);
	});
});

describe('invocation', () => {
	it.effect(
		'resolves a relative SHIP_HOME against the cwd, for the daemon spawned elsewhere',
		() =>
			Effect.gen(function* () {
				const invocation = yield* Invocation;
				expect(invocation.home).toBe(resolve('relative-home'));
			}).pipe(
				Effect.provide(Invocation.fromProcess('1.0.0')),
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromEnv({ env: { SHIP_HOME: 'relative-home' } })
					)
				)
			)
	);
});

describe('command parsing', () => {
	it.live('prints the bare version and help without a daemon', () =>
		Effect.gen(function* () {
			const home = join(yield* tempDir, 'home');
			const version = yield* cli(['--version'], { home });
			expect(version).toEqual({ code: 0, stdout: VERSION, stderr: '' });

			const help = yield* cli(['--help'], { home });
			expect(help.code).toBe(0);
			for (const command of [
				'run',
				'review',
				'fix',
				'recheck',
				'resume',
				'cancel',
				'status',
				'list',
				'logs',
				'daemon',
				'init'
			]) {
				expect(help.stdout).toMatch(new RegExp(`^  ${command} `, 'mu'));
			}
			expect(help.stdout).not.toContain('serve');
			expect(help.stdout).not.toContain('--wizard');

			const daemonHelp = yield* cli(['daemon', '--help'], { home });
			expect(daemonHelp.stdout).toMatch(/^ {2}status /mu);
			expect(daemonHelp.stdout).toMatch(/^ {2}restart /mu);
			// Nothing above needed a daemon.
			expect(existsSync(home)).toBe(false);
		}).pipe(Effect.scoped)
	);

	it.live('rejects bad invocations with exit code 1', () =>
		Effect.gen(function* () {
			const home = join(yield* tempDir, 'home');
			for (const args of [
				['bogus'],
				['run'],
				['fix'],
				['recheck'],
				['fix', '1', '--bogus'],
				['resume'],
				['list', '--limit', '0'],
				['list', '--limit', 'many'],
				['logs', 'some-id', '--bogus'],
				['daemon', 'serve']
			]) {
				const result = yield* cli(args, { home });
				expect(result.code, args.join(' ')).toBe(1);
				expect(result.stderr, args.join(' ')).toContain('ERROR');
			}
		}).pipe(Effect.scoped)
	);
});

describe('ship run', () => {
	it.live(
		'streams events to stderr, prints only the summary on stdout and exits 0 when done',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				yield* scriptHappyRun(services);
				yield* daemon(fx.home, services);

				// A relative plan dir resolves against the caller's cwd.
				const result = yield* shipIn(fx, ['run', '.plans/feature']);

				expect(result.code).toBe(0);
				const summary = parseSummary(result.stdout);
				expect(summary).toMatchObject({
					status: 'done',
					prUrl: 'https://github.com/f-elix/example/pull/1',
					rounds: 1,
					costUsd: 0.65,
					unresolvedMustFix: [],
					escalationReason: null,
					error: null
				});
				expect(Object.keys(summary).sort()).toEqual(
					[
						'kind',
						'runId',
						'status',
						'prUrl',
						'rounds',
						'checks',
						'costUsd',
						'unresolvedMustFix',
						'tradeoffs',
						'nits',
						'escalationReason',
						'error'
					].sort()
				);
				const lines = result.stderr.split('\n');
				expect(lines[0]).toBe(`ship: run ${String(summary['runId'])} started`);
				for (const expected of [
					/ baseline check caller-env passed /u,
					/ state implement -> checks\.running$/u,
					/ check caller-env passed /u,
					/ review round 1 of \w{7}\.\.\w{7}: standards$/u,
					/ implement cost \$0\.50 \(total \$0\.50\)$/u,
					/ PR opened: https:\/\/github\.com\/f-elix\/example\/pull\/1$/u,
					/ run done: https:\/\/github\.com\/f-elix\/example\/pull\/1$/u
				]) {
					expect(
						lines.some((line) => expected.test(line)),
						String(expected)
					).toBe(true);
				}
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'exits 2 when the run escalates with a draft PR',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				fx.configure(
					{ locks: { cpu: 2 } },
					{
						checks: [{ name: 'no-feature', run: 'test ! -f src/feature.ts' }],
						caps: { checkFixAttempts: 0 }
					}
				);
				const services = yield* fakes;
				const agent = Context.get(services, AgentFake);
				yield* agent.script({ step: 'implement' }, addsFeature);
				yield* agent.script(
					{ step: 'escalate' },
					yield* opensPr({
						title: 'Add the feature',
						body: '## Summary\n\nStuck.',
						costUsd: 0.05
					}).pipe(Effect.provide(services))
				);
				yield* daemon(fx.home, services);

				const result = yield* shipIn(fx, ['run', fx.planDir]);

				expect(result.code).toBe(2);
				expect(parseSummary(result.stdout)).toMatchObject({
					status: 'escalated',
					escalationReason: 'check-fix-cap'
				});
				expect(result.stderr).toContain('escalated: check-fix-cap');
				expect(result.stderr).toMatch(/draft PR opened: /u);
				expect((yield* Context.get(services, GhFake).prs).map((pr) => pr.draft)).toEqual([
					true
				]);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'exits 1 when the run fails',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				fx.configure(
					{ locks: { cpu: 2 } },
					{ checks: [{ name: 'broken', run: 'exit 3' }] }
				);
				yield* daemon(fx.home, yield* fakes);

				const result = yield* shipIn(fx, ['run', fx.planDir]);

				expect(result.code).toBe(1);
				expect(parseSummary(result.stdout)).toMatchObject({ status: 'failed' });
				expect(result.stderr).toMatch(/ baseline check broken failed with exit code 3 /u);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'reports failed preconditions and starts nothing',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				yield* daemon(fx.home, yield* fakes);

				const missing = yield* shipIn(fx, ['run', 'no-such-plan']);
				expect(missing).toEqual({
					code: 1,
					stdout: '',
					stderr: `ship: cannot start the run (missing-plan-files): ${join(fx.work, 'no-such-plan')} has no spec.md or implementation-plan.md`
				});

				fx.git('switch', '--quiet', 'main');
				const onMain = yield* shipIn(fx, ['run', fx.planDir]);
				expect(onMain).toEqual({
					code: 1,
					stdout: '',
					stderr: 'ship: cannot start the run (on-default-branch): main is the default branch; switch to a feature branch first'
				});

				fx.git('switch', '--quiet', 'feature');
				fx.write('README.md', 'changed\n');
				const dirty = yield* shipIn(fx, ['run', fx.planDir]);
				expect(dirty.code).toBe(1);
				expect(dirty.stderr).toBe(
					`ship: cannot start the run (dirty-tree): ${fx.work} has uncommitted changes; commit or stash them first`
				);

				const runs = yield* shipIn(fx, ['list', '--json']);
				expect(JSON.parse(runs.stdout)).toEqual([]);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'detaches when interrupted, leaving the run going',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const rpc = yield* hangingDaemon(fx);
				const captured: Captured = { stdout: [], stderr: [] };

				const fiber = yield* Effect.forkChild(shipIn(fx, ['run', fx.planDir], captured));
				yield* eventually(
					Effect.sync(() => captured.stderr.some((line) => line.includes('started')))
				);
				const [run] = yield* rpc.list({});
				if (run === undefined) return expect.fail('no run');
				yield* reachState(rpc, run.runId, 'implement');
				const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));

				expect(Exit.hasInterrupts(exit)).toBe(true);
				expect(captured.stdout).toEqual([]);
				expect(captured.stderr.at(-1)).toBe(
					[
						`ship: detached from run ${run.runId}; it keeps running.`,
						`  follow it: ship logs ${run.runId} --follow`,
						`  result:    ship status ${run.runId}`,
						`  cancel it: ship cancel ${run.runId}`
					].join('\n')
				);
				expect((yield* rpc.status({ runId: run.runId })).status).toBe('running');
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'tells how to continue the run when the daemon stops under it',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				// A separate process, so stopping it does not stop this test's own daemon code.
				const daemonChild = yield* daemonProcess(fx.home);
				const rpc = yield* client(fx.home);
				const captured: Captured = { stdout: [], stderr: [] };

				const fiber = yield* Effect.forkChild(shipIn(fx, ['run', fx.planDir], captured));
				yield* eventually(
					Effect.sync(() => captured.stderr.some((line) => line.includes('started')))
				);
				const [run] = yield* rpc.list({});
				if (run === undefined) return expect.fail('no run');
				yield* reachState(rpc, run.runId, 'implement');
				yield* rpc.stop({ force: true });
				yield* daemonChild.exited;
				const result = yield* Fiber.join(fiber);

				expect(result.code).toBe(1);
				expect(result.stdout).toBe('');
				expect(captured.stderr.at(-1)).toBe(
					`ship: run ${run.runId} was interrupted: the daemon stopped, or the run crashed (see ${shipPaths(fx.home).daemonLog}). Continue it with \`ship resume ${run.runId}\`, or \`ship cancel ${run.runId}\``
				);
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});

/** PR 1 of `github.com/f-elix/example`, which the GitHub fake answers for. */
const PR = 'https://github.com/f-elix/example/pull/1';

/**
 * Adds PR 1, at `headSha`, to the GitHub fake and scripts one finding of `severity`, which
 * the verifier confirms.
 */
const scriptReview = (services: Fakes, severity: 'must-fix' | 'nit', headSha?: GitSha) =>
	Effect.gen(function* () {
		yield* Context.get(services, GhFake).addPr({
			base: 'main',
			head: 'feature',
			title: 'Add the feature',
			body: 'Adds src/feature.ts.',
			draft: false,
			...(headSha === undefined ? {} : { headSha })
		});
		const agent = Context.get(services, AgentFake);
		yield* agent.script(
			{ step: 'review', label: 'standards' },
			{
				output: {
					findings: [
						{
							file: 'src/feature.ts',
							line: 1,
							severity,
							claim: 'The feature is unused',
							evidence: 'export const feature = 1;'
						}
					]
				},
				costUsd: 0.25
			}
		);
		yield* agent.script(
			{ step: 'verify' },
			{
				output: {
					verdicts: [{ index: 0, verdict: 'confirmed', reason: 'Seen' }],
					previous: []
				},
				costUsd: 0.5
			}
		);
	});

describe('ship review', () => {
	it.live(
		'posts with --post, prints the review summary on stdout and exits 2 on a must-fix finding',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const { head, env } = cloneOfExample(fx);
				const services = yield* fakes;
				yield* scriptReview(services, 'must-fix', head);
				yield* daemon(fx.home, services);

				const result = yield* cli(['review', PR, '--post'], {
					home: fx.home,
					cwd: fx.work,
					env
				});

				expect(result.code).toBe(2);
				const reviews = yield* Context.get(services, GhFake).reviews;
				expect(reviews).toMatchObject([{ event: 'REQUEST_CHANGES' }]);
				expect(parseSummary(result.stdout)).toMatchObject({
					kind: 'review',
					status: 'done',
					prUrl: PR,
					reviewUrl: reviews[0]?.url,
					reviewId: expect.stringMatching(/-r1$/u),
					costUsd: 0.75,
					mustFix: [{ file: 'src/feature.ts', line: 1 }],
					nits: []
				});
				const runId = result.stderr
					.split('\n')[0]
					?.match(/^ship: run (\S+) started$/u)?.[1];
				expect(runId).toBeDefined();
				// The stored review's id is in the event stream, before it is posted.
				const stderr = result.stderr.split('\n');
				const stored = stderr.findIndex((line) =>
					line.endsWith(` review stored as ${runId}-r1`)
				);
				expect(stored).toBeGreaterThan(0);
				expect(
					stderr.findIndex((line) => line.includes(' review posted '))
				).toBeGreaterThan(stored);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'posts nothing without --post and exits 0 when no finding is must-fix',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const { head, env } = cloneOfExample(fx);
				const services = yield* fakes;
				yield* scriptReview(services, 'nit', head);
				yield* daemon(fx.home, services);

				const result = yield* cli(['review', '1'], { home: fx.home, cwd: fx.work, env });

				expect(result.code).toBe(0);
				expect(yield* Context.get(services, GhFake).reviews).toEqual([]);
				expect(parseSummary(result.stdout)).toMatchObject({
					kind: 'review',
					status: 'done',
					reviewUrl: null,
					mustFix: [],
					nits: [{ file: 'src/feature.ts', line: 1 }]
				});
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'reports a failed precondition, exits 1 and starts nothing',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				yield* scriptReview(services, 'must-fix');
				yield* daemon(fx.home, services);

				// The fake's PRs belong to github.com/f-elix/example, not to this repo's origin.
				const result = yield* shipIn(fx, ['review', PR, '--post']);

				expect(result.code).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toMatch(
					/^ship: cannot start the run \(pr-other-repo\): https:\/\/github\.com\/f-elix\/example\/pull\/1 belongs to /u
				);
				expect(JSON.parse((yield* shipIn(fx, ['list', '--json'])).stdout)).toEqual([]);
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});

describe('ship fix and ship recheck', () => {
	it.live(
		"fixes a PR's threads with --local --no-checks, keeping the commit local, and exits 0",
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const { head, env } = cloneOfExample(fx);
				const services = yield* fakes;
				const gh = Context.get(services, GhFake);
				yield* gh.addPr({
					base: 'main',
					head: 'feature',
					title: 'Add the feature',
					body: '',
					draft: false,
					headSha: head
				});
				yield* gh.addThread({
					prUrl: PR,
					path: 'src/feature.ts',
					line: 1,
					author: 'octocat',
					body: 'Export a function.'
				});
				yield* Context.get(services, AgentFake).script({ step: 'fix' }, addsFeatureFix);
				yield* daemon(fx.home, services);

				const result = yield* cli(['fix', '1', '--local', '--no-checks'], {
					home: fx.home,
					cwd: fx.work,
					env
				});

				expect(result.code).toBe(0);
				const fixed = fx.git('rev-parse', 'HEAD');
				expect(parseSummary(result.stdout)).toMatchObject({
					kind: 'fix',
					status: 'done',
					prUrl: PR,
					commits: [fixed],
					pushed: false,
					checks: []
				});
				expect(result.stderr).toContain('fix of 1 finding on');
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'rechecks with --local, resolving nothing, and exits 2 while a finding is unfixed',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const { head, env } = cloneOfExample(fx);
				const services = yield* fakes;
				const gh = Context.get(services, GhFake);
				yield* gh.addPr({
					base: 'main',
					head: 'feature',
					title: 'Add the feature',
					body: '',
					draft: false,
					headSha: head
				});
				yield* gh.addThread({
					prUrl: PR,
					path: 'src/feature.ts',
					line: 1,
					author: 'octocat',
					body: 'Export a function.'
				});
				yield* Context.get(services, AgentFake).script(
					{ step: 'verify' },
					{
						output: {
							verdicts: [],
							previous: [
								{ id: 'PRRT_1', status: 'unfixed', evidence: 'Still a const' }
							]
						},
						costUsd: 0.2
					}
				);
				yield* daemon(fx.home, services);

				const result = yield* cli(['recheck', PR, '--local'], {
					home: fx.home,
					cwd: fx.work,
					env
				});

				expect(result.code).toBe(2);
				expect(parseSummary(result.stdout)).toMatchObject({
					kind: 'recheck',
					status: 'done',
					findings: [
						{ finding: { id: 'PRRT_1' }, status: 'unfixed', evidence: 'Still a const' }
					],
					resolvedThreads: []
				});
				expect(yield* gh.resolveCalls).toEqual([]);
				expect(result.stderr).toContain('rechecked 1 finding: 0 fixed, 1 unfixed');
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'reports a refused source, exits 1 and starts nothing',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				yield* daemon(fx.home, yield* fakes);

				const result = yield* shipIn(fx, ['recheck', 'no-such-review']);

				expect(result.code).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toMatch(
					/^ship: cannot start the run \(review-not-found\): /u
				);
				expect(JSON.parse((yield* shipIn(fx, ['list', '--json'])).stdout)).toEqual([]);
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});

describe('ship implement, ship checks, ship pr and ship post', () => {
	it.live(
		'implements a plan with --no-checks, commits it and exits 0',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				yield* Context.get(services, AgentFake).script({ step: 'implement' }, addsFeature);
				yield* daemon(fx.home, services);

				const result = yield* shipIn(fx, ['implement', '.plans/feature', '--no-checks']);

				expect(result.code).toBe(0);
				expect(parseSummary(result.stdout)).toMatchObject({
					kind: 'implement',
					status: 'done',
					commits: [fx.git('rev-parse', 'HEAD')],
					checks: []
				});
				expect(fx.git('log', '-1', '--format=%s')).toBe('Implement feature');
				expect(result.stderr).toContain('implement created on feature');
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'reports a refused post, exits 1 and starts nothing',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				yield* daemon(fx.home, yield* fakes);

				const result = yield* shipIn(fx, ['post', 'no-such-review']);

				expect(result.code).toBe(1);
				expect(result.stderr).toMatch(
					/^ship: cannot start the run \(review-not-found\): /u
				);
				expect(JSON.parse((yield* shipIn(fx, ['list', '--json'])).stdout)).toEqual([]);
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});

describe('ship resume', () => {
	it.live(
		"streams only the resumed run's events and exits like ship run",
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const first = yield* Scope.make();
				// Implemented (cost $0.50), then stuck in review until the daemon stops.
				const stuck = yield* fakes;
				const agent = Context.get(stuck, AgentFake);
				yield* agent.script({ step: 'implement' }, addsFeature);
				yield* agent.script({ step: 'review', label: 'standards' }, () => Effect.never);
				yield* daemon(fx.home, stuck).pipe(Scope.provide(first));
				const before = yield* client(fx.home).pipe(Scope.provide(first));
				const { runId } = yield* before.run(fx.request);
				yield* eventually(
					Effect.map(before.status({ runId }), (info) => info.state.startsWith('review'))
				);
				yield* Scope.close(first, Exit.void);

				const services = yield* fakes;
				yield* scriptHappyRun(services);
				yield* daemon(fx.home, services);

				const result = yield* shipIn(fx, ['resume', runId]);

				expect(result.code).toBe(0);
				expect(parseSummary(result.stdout)).toMatchObject({ runId, status: 'done' });
				const lines = result.stderr.split('\n');
				expect(lines[0]).toBe(`ship: run ${runId} resumed`);
				expect(lines[1]).toMatch(/ run resumed$/u);
				expect(result.stderr).not.toContain('run created');
				expect(result.stderr).not.toContain('run interrupted');
				// The running total includes the cost from before the resume.
				expect(result.stderr).toContain('review cost $0.10 (total $0.60)');

				const again = yield* shipIn(fx, ['resume', runId]);
				expect(again).toMatchObject({
					code: 1,
					stdout: '',
					stderr: `ship: cannot resume run ${runId}: it is done`
				});
				const unknown = yield* shipIn(fx, ['resume', 'no-such-run']);
				expect(unknown).toMatchObject({ code: 1, stderr: 'ship: no run no-such-run' });
			}).pipe(Effect.scoped),
		TIMEOUT
	);
	it.live(
		'retries a failed run from the step that failed',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				// The reviewer fails once, as on a false-positive safeguard flag.
				yield* Context.get(services, AgentFake).script(
					{ step: 'review', label: 'standards' },
					new AgentSdkError({
						step: 'review',
						reason: 'exception',
						detail: 'API Error: safeguards flagged this message'
					})
				);
				yield* scriptHappyRun(services);
				yield* daemon(fx.home, services);

				const failed = yield* shipIn(fx, ['run', fx.planDir]);

				expect(failed.code).toBe(1);
				const runId = String(parseSummary(failed.stdout)['runId']);
				expect(failed.stderr).toContain(
					`ship: run ${runId} failed. Once the cause is fixed, \`ship resume ${runId}\` runs the failed step again`
				);

				const resumed = yield* shipIn(fx, ['resume', runId]);

				expect(resumed.code).toBe(0);
				expect(parseSummary(resumed.stdout)).toMatchObject({ runId, status: 'done' });
				// Only the review runs again: the implementation is not redone.
				expect(resumed.stderr).not.toContain('implement cost');
				expect(resumed.stderr).toContain('review cost $0.10 (total $0.60)');
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});

describe('ship cancel, status, list and logs', () => {
	it.live(
		'cancel stops an active run; status shows it',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const rpc = yield* hangingDaemon(fx);
				const { runId } = yield* rpc.run(fx.request);
				yield* reachState(rpc, runId, 'implement');

				const active = yield* shipIn(fx, ['status']);
				expect(active.code).toBe(0);
				expect(active.stdout.split('\n')[0]).toMatch(
					/^RUN\s+KIND\s+STATUS\s+STATE\s+SUBJECT\s+UPDATED\s+PR$/u
				);
				expect(active.stdout).toMatch(
					new RegExp(`^${runId}\\s+ship\\s+running\\s+implement\\s+feature\\s`, 'mu')
				);

				expect(yield* shipIn(fx, ['cancel', runId])).toEqual({
					code: 0,
					stdout: '',
					stderr: `ship: run ${runId} cancelled`
				});
				expect(yield* shipIn(fx, ['cancel', runId])).toEqual({
					code: 1,
					stdout: '',
					stderr: `ship: cannot cancel run ${runId}: it is cancelled`
				});

				expect((yield* shipIn(fx, ['status'])).stdout).toBe('No active runs.');
				const details = yield* shipIn(fx, ['status', runId]);
				expect(details.stdout).toContain(`run: ${runId}\nkind: ship\nstatus: cancelled\n`);
				const asJson = JSON.parse((yield* shipIn(fx, ['status', runId, '--json'])).stdout);
				expect(asJson).toMatchObject({
					runId,
					status: 'cancelled',
					branch: 'feature',
					summary: { status: 'cancelled' }
				});
				expect(yield* shipIn(fx, ['status', 'no-such-run'])).toMatchObject({
					code: 1,
					stderr: 'ship: no run no-such-run'
				});
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'list and logs show finished runs',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const services = yield* fakes;
				yield* scriptHappyRun(services);
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);
				const first = (yield* rpc.run(fx.request)).runId;
				yield* eventually(
					Effect.map(rpc.status({ runId: first }), (info) => info.status === 'done')
				);
				yield* scriptHappyRun(services);
				const second = (yield* rpc.run(fx.request)).runId;
				yield* eventually(
					Effect.map(rpc.status({ runId: second }), (info) => info.status === 'done')
				);

				const table = (yield* shipIn(fx, ['list'])).stdout.split('\n');
				expect(table).toHaveLength(3);
				expect(table[1]).toMatch(
					new RegExp(`^${second}\\s+ship\\s+done\\s+done\\s+feature\\s.*/pull/1$`, 'u')
				);
				expect(table[2]).toMatch(new RegExp(`^${first}\\s+ship\\s+done\\s`, 'u'));
				const limited = JSON.parse(
					(yield* shipIn(fx, ['list', '--limit', '1', '--json'])).stdout
				);
				expect(limited.map((run: { runId: string }) => run.runId)).toEqual([second]);

				const logs = yield* shipIn(fx, ['logs', first]);
				expect(logs.code).toBe(0);
				expect(logs.stderr).toBe('');
				const lines = logs.stdout.split('\n');
				expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d run created on feature at \w{7}$/u);
				expect(lines.at(-1)).toMatch(/ run done: .*\/pull\/1$/u);

				const raw = (yield* shipIn(fx, ['logs', first, '--json', '--follow'])).stdout
					.split('\n')
					.map((line) => JSON.parse(line));
				expect(raw[0]).toMatchObject({
					runId: first,
					seq: 1,
					event: { _tag: 'RunCreated' }
				});
				expect(raw.at(-1)).toMatchObject({ event: { _tag: 'RunFinished' } });
				expect(raw.map((envelope: { seq: number }) => envelope.seq)).toEqual(
					raw.map((_: unknown, index: number) => index + 1)
				);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'logs without --follow ends after the events so far',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const rpc = yield* hangingDaemon(fx);
				const { runId } = yield* rpc.run(fx.request);
				yield* reachState(rpc, runId, 'implement');

				const logs = yield* shipIn(fx, ['logs', runId]);
				expect(logs.code).toBe(0);
				expect(logs.stdout.split('\n').at(-1)).toMatch(
					/ state baseline\.running -> implement$/u
				);
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});

describe('version handshake', () => {
	it.live(
		'tells the user to restart a daemon of another version',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const rpc = yield* hangingDaemon(fx);
				const other = { home: fx.home, cwd: fx.work, env: fx.env, version: '9.9.9' };

				const idle = yield* cli(['list'], other);
				expect(idle).toEqual({
					code: 1,
					stdout: '',
					stderr: `ship: this ship is 9.9.9 but the running daemon is ${VERSION}. Run \`ship daemon restart\` to switch the daemon to 9.9.9. No runs are active.`
				});

				const { runId } = yield* rpc.run(fx.request);
				yield* reachState(rpc, runId, 'implement');
				const busy = yield* cli(['run', fx.planDir], other);
				expect(busy.code).toBe(1);
				expect(busy.stderr).toContain(
					'1 run is active: the restart is refused until they finish, unless you pass --force'
				);

				// `daemon status` still reports the daemon.
				const status = yield* cli(['daemon', 'status'], other);
				expect(status.code).toBe(0);
				expect(status.stdout).toContain(`ship daemon ${VERSION}`);
				expect(status.stdout).toContain('active runs: 1');
				expect(status.stderr).toContain('Run `ship daemon restart`');
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});

describe('daemon auto-start and control', () => {
	it.live(
		'starts a daemon when none runs, then reuses it',
		() =>
			Effect.gen(function* () {
				const home = join(yield* tempDir, 'home');
				const { launcher, launched } = yield* fakeDaemonLauncher();
				const paths = shipPaths(home);

				const first = yield* cli(['daemon', 'status'], { home, launcher });
				expect(first.code).toBe(0);
				expect(first.stdout).toMatch(
					new RegExp(`^ship daemon ${VERSION} \\(pid \\d+\\)$`, 'mu')
				);
				expect(first.stdout).toContain(`socket: ${paths.socket}`);
				expect(first.stdout).toContain(`log: ${paths.daemonLog}`);
				expect(launched()).toBe(1);

				expect(yield* cli(['list'], { home, launcher })).toMatchObject({
					code: 0,
					stdout: 'No runs yet.'
				});
				expect(launched()).toBe(1);

				expect(yield* cli(['daemon', 'stop'], { home, launcher })).toEqual({
					code: 0,
					stdout: '',
					stderr: 'ship: daemon stopped'
				});
				expect(existsSync(paths.pidFile)).toBe(false);
				expect(existsSync(paths.socket)).toBe(false);
				expect(yield* cli(['daemon', 'stop'], { home, launcher })).toMatchObject({
					code: 0,
					stderr: 'ship: no daemon is running'
				});
				expect(launched()).toBe(1);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'points at the log when a spawned daemon never answers',
		() =>
			Effect.gen(function* () {
				const home = join(yield* tempDir, 'home');
				const launcher = { launch: () => Effect.void };
				const timeouts = { ...testTimeouts, start: Duration.seconds(1) };
				const result = yield* cli(['list'], { home, launcher, timeouts });
				expect(result).toEqual({
					code: 1,
					stdout: '',
					stderr: `ship: the ship daemon did not answer within 1s; see ${shipPaths(home).daemonLog}`
				});
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'stop and restart are refused while runs are active, unless forced',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const paths = shipPaths(fx.home);
				const { launcher, launched } = yield* fakeDaemonLauncher();
				const running = yield* daemonProcess(fx.home);
				const rpc = yield* client(fx.home);
				const { runId } = yield* rpc.run(fx.request);
				yield* reachState(rpc, runId, 'implement');
				const ship = (args: ReadonlyArray<string>) =>
					cli(args, { home: fx.home, cwd: fx.work, env: fx.env, launcher });

				const refused =
					'ship: 1 run is active: the daemon is not stopped until they finish, unless you pass --force, which interrupts them (`ship resume <id>` continues them).';
				expect(yield* ship(['daemon', 'stop'])).toEqual({
					code: 1,
					stdout: '',
					stderr: refused
				});
				expect(yield* ship(['daemon', 'restart'])).toEqual({
					code: 1,
					stdout: '',
					stderr: refused
				});
				expect(launched()).toBe(0);

				expect(yield* ship(['daemon', 'restart', '--force'])).toEqual({
					code: 0,
					stdout: '',
					stderr: `ship: daemon ${VERSION} started`
				});
				expect((yield* running.exited).signal).toBe(null);
				expect(launched()).toBe(1);
				const after = yield* ship(['status', runId, '--json']);
				expect(JSON.parse(after.stdout)).toMatchObject({ status: 'interrupted' });

				// The interrupted run no longer counts as active, so a plain stop is allowed.
				expect((yield* ship(['daemon', 'status'])).stdout).toContain('active runs: 0');
				expect(yield* ship(['daemon', 'stop'])).toMatchObject({ code: 0 });
				expect(existsSync(paths.pidFile)).toBe(false);
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});
