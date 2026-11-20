import {
	endsFollow,
	parseFindingsSource,
	ReviewId,
	RunEventEnvelope,
	RunId,
	RunInfo,
	Summary,
	type InvalidRunStatus,
	type PreconditionFailed,
	type RunEvent,
	type RunNotFound,
	type UnknownEvent
} from '@ship/core/contract';
import { readDaemonPid } from '@ship/daemon/client';
import { Console, Effect, Option, Schema, Stream } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { resolve } from 'node:path';
import { auth } from './auth.ts';
import {
	cliError,
	connectDaemon,
	findDaemon,
	launchDaemon,
	mismatchMessage,
	stopDaemon,
	type Connection,
	type Rpc
} from './connection.ts';
import { conventions } from './conventions.ts';
import { setExitCode } from './exit-code.ts';
import { init } from './init.ts';
import { Invocation } from './invocation.ts';
import {
	exitCodeFor,
	exitCodeForSummary,
	makeEventFormatter,
	runDetails,
	runTable
} from './render.ts';

const json = (value: unknown) => JSON.stringify(value, null, 2);
const encodeSummary = Schema.encodeSync(Summary);
const encodeRunInfo = Schema.encodeSync(RunInfo);
const encodeRunInfos = Schema.encodeSync(Schema.Array(RunInfo));
const encodeEnvelope = Schema.encodeSync(RunEventEnvelope);

const runNotFound = (error: RunNotFound) => cliError(`no run ${error.runId}`);

const invalidStatus = (action: string) => (error: InvalidRunStatus) =>
	cliError(`cannot ${action} run ${error.runId}: it is ${error.status}`);

/** A precondition the daemon checks before it starts a run failed: nothing was started. */
export const preconditionMessage = (error: PreconditionFailed) =>
	`cannot start the run (${error.reason}): ${error.detail}`;

const runIdArgument = Argument.String('id').pipe(
	Argument.withDescription('Run id, as `ship run` and `ship list` print it'),
	Argument.withSchema(RunId)
);

const jsonFlag = Flag.Boolean('json').pipe(
	Flag.withDescription('Print JSON instead of text'),
	Flag.withDefault(false)
);

const forceFlag = (what: string) =>
	Flag.Boolean('force').pipe(
		Flag.withDescription(
			`${what} even while runs are active; they become interrupted, and \`ship resume <id>\` continues them`
		),
		Flag.withDefault(false)
	);

type EventFormatter = ReturnType<typeof makeEventFormatter>;

/**
 * Feeds the run's events so far to `format` without printing them, so its running totals
 * include them, and returns the last event's seq (0 when there is none).
 */
const catchUp = (rpc: Rpc, runId: RunId, format: EventFormatter) =>
	rpc.events({ runId, follow: false }).pipe(
		Stream.runFold(
			() => 0,
			(_, envelope) => {
				format(envelope.event);
				return envelope.seq;
			}
		)
	);

const detachedMessage = (runId: RunId) =>
	`ship: detached from run ${runId}; it keeps running.\n  follow it: ship logs ${runId} --follow\n  result:    ship status ${runId}\n  cancel it: ship cancel ${runId}`;

/**
 * Streams the run's events from `fromSeq` to stderr until the run ends or is interrupted,
 * then prints its summary on stdout and sets the exit code from it. Interrupting
 * this (Ctrl-C) detaches: the run keeps going, and how to get back to it goes to stderr.
 */
const follow = (
	connection: Connection,
	runId: RunId,
	fromSeq: number,
	format: EventFormatter = makeEventFormatter()
) =>
	Effect.gen(function* () {
		const { rpc } = connection;
		let last: RunEvent | UnknownEvent | undefined;
		yield* rpc.events({ runId, fromSeq }).pipe(
			Stream.runForEach((envelope) => {
				last = envelope.event;
				const line = format(envelope.event);
				return line === null ? Effect.void : Console.error(line);
			})
		);
		// The outcome comes from the event that ended the stream, without asking the daemon:
		// after `RunInterrupted` it may be stopping, and after `RunFinished` the run no longer
		// counts as active, so another terminal may stop the daemon at once.
		if (last !== undefined && endsFollow(last)) {
			switch (last._tag) {
				case 'RunInterrupted':
					yield* Console.error(
						`ship: run ${runId} was interrupted: the daemon stopped, or the run crashed (see ${connection.paths.daemonLog}). Continue it with \`ship resume ${runId}\`, or \`ship cancel ${runId}\``
					);
					return yield* setExitCode(exitCodeFor('interrupted'));
				case 'RunFinished':
					if (last.summary.status === 'failed') {
						yield* Console.error(
							`ship: run ${runId} failed. Once the cause is fixed, \`ship resume ${runId}\` runs the failed step again`
						);
					}
					yield* Console.log(json(encodeSummary(last.summary)));
					return yield* setExitCode(exitCodeForSummary(last.summary));
			}
		}
		// The replay of a run that was not running ended without such an event.
		const info = yield* rpc.status({ runId });
		if (info.summary === null) {
			yield* Console.error(`ship: run ${runId} is ${info.status}`);
			return yield* setExitCode(exitCodeFor(info.status));
		}
		yield* Console.log(json(encodeSummary(info.summary)));
		yield* setExitCode(exitCodeForSummary(info.summary));
	}).pipe(
		Effect.catchTag('RunNotFound', (error) => Effect.fail(runNotFound(error))),
		Effect.onInterrupt(() => Console.error(detachedMessage(runId)))
	);

/**
 * Starts a run with `create` and follows it like {@link follow}. A failed precondition
 * fails the command: nothing was started.
 */
const startAndFollow = (
	connection: Connection,
	create: ReturnType<
		Rpc['run' | 'review' | 'fix' | 'recheck' | 'implement' | 'checks' | 'pr' | 'post']
	>
) =>
	Effect.gen(function* () {
		const { runId } = yield* create.pipe(
			Effect.catchTag('PreconditionFailed', (error) =>
				Effect.fail(cliError(preconditionMessage(error)))
			),
			Effect.onInterrupt(() =>
				Console.error(
					'ship: interrupted before the daemon answered; `ship status` shows the run if it started'
				)
			)
		);
		yield* Console.error(`ship: run ${runId} started`);
		yield* follow(connection, runId, 1);
	});

const planDirArgument = Argument.String('plan-dir').pipe(
	Argument.withDescription('Directory holding spec.md and implementation-plan.md')
);

const run = Command.make(
	'run',
	{ planDir: planDirArgument },
	Effect.fn('ship.run')(function* ({ planDir }) {
		const invocation = yield* Invocation;
		const connection = yield* connectDaemon();
		yield* startAndFollow(
			connection,
			connection.rpc.run({
				planDir: resolve(invocation.cwd, planDir),
				cwd: invocation.cwd,
				env: invocation.env
			})
		);
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		'Start a run on the current branch: implement the plan, run checks, review, fix and open a PR. Events stream to stderr; the summary JSON goes to stdout. Exit code 0 done, 2 escalated, 1 failed, cancelled or interrupted, 130 interrupted by Ctrl-C (a started run keeps going).'
	)
);

const review = Command.make(
	'review',
	{
		pr: Argument.String('pr').pipe(
			Argument.withDescription('The pull request: its number or its GitHub URL')
		),
		post: Flag.Boolean('post').pipe(
			Flag.withDescription(
				'Post the findings as one review on the PR: changes requested when there are must-fix findings, a comment otherwise. Nothing is posted when there are no findings'
			),
			Flag.withDefault(false)
		)
	},
	Effect.fn('ship.review')(function* ({ pr, post }) {
		const invocation = yield* Invocation;
		const connection = yield* connectDaemon();
		yield* startAndFollow(
			connection,
			connection.rpc.review({ pr, post, cwd: invocation.cwd, env: invocation.env })
		);
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		"Review a pull request of the current repository: one round of ship's reviewers and verifier over its diff, checked against its title and description. Run it in a clean checkout of the PR's head (`gh pr checkout <n>`); the review is stored and its id is in the summary. Events stream to stderr; the summary JSON goes to stdout. Exit code 0 no must-fix findings, 2 must-fix findings, 1 failed, cancelled or interrupted, 130 interrupted by Ctrl-C (a started run keeps going)."
	)
);

/** A review id, a PR number or a PR URL, as `ship fix` and `ship recheck` take it. */
const sourceArgument = Argument.String('source').pipe(
	Argument.withDescription(
		'The findings: a review id, as `ship review` prints it, for its stored findings, or a PR number or URL for its unresolved review threads'
	),
	Argument.withSchema(Schema.NonEmptyString)
);

/** The findings source `argument` names; a blank one fails the command. */
const findingsSource = (argument: string) => {
	const source = parseFindingsSource(argument);
	return source === null
		? Effect.fail(cliError('the findings source is blank'))
		: Effect.succeed(source);
};

const fix = Command.make(
	'fix',
	{
		source: sourceArgument,
		local: Flag.Boolean('local').pipe(
			Flag.withDescription(
				"Keep the commits local instead of pushing them to the PR's branch"
			),
			Flag.withDefault(false)
		),
		noChecks: Flag.Boolean('no-checks').pipe(
			Flag.withDescription('Commit the fix without running the checks'),
			Flag.withDefault(false)
		)
	},
	Effect.fn('ship.fix')(function* ({ source, local, noChecks }) {
		const invocation = yield* Invocation;
		const findings = yield* findingsSource(source);
		const connection = yield* connectDaemon();
		yield* startAndFollow(
			connection,
			connection.rpc.fix({
				source: findings,
				local,
				checks: !noChecks,
				cwd: invocation.cwd,
				env: invocation.env
			})
		);
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		"Fix the must-fix findings and nits of a stored review or of a PR's review threads, run the checks, commit the fix and push it to the PR's branch. Run it in a clean checkout of the PR's head (`gh pr checkout <n>`). Events stream to stderr; the summary JSON goes to stdout. Exit code 0 done, 1 failed, cancelled or interrupted, 130 interrupted by Ctrl-C (a started run keeps going)."
	)
);

const recheck = Command.make(
	'recheck',
	{
		source: sourceArgument,
		local: Flag.Boolean('local').pipe(
			Flag.withDescription('Resolve no review thread on GitHub'),
			Flag.withDefault(false)
		)
	},
	Effect.fn('ship.recheck')(function* ({ source, local }) {
		const invocation = yield* Invocation;
		const findings = yield* findingsSource(source);
		const connection = yield* connectDaemon();
		yield* startAndFollow(
			connection,
			connection.rpc.recheck({
				source: findings,
				local,
				cwd: invocation.cwd,
				env: invocation.env
			})
		);
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		"Check whether the findings of a stored review or of a PR's review threads are fixed in the PR's head, and resolve the threads of the fixed ones. Run it in a clean checkout of the PR's head (`gh pr checkout <n>`). Events stream to stderr; the summary JSON goes to stdout. Exit code 0 every finding fixed, 2 some unfixed, 1 failed, cancelled or interrupted, 130 interrupted by Ctrl-C (a started run keeps going)."
	)
);

const STREAMS =
	'Events stream to stderr; the summary JSON goes to stdout. Exit code 0 done, 1 failed, cancelled or interrupted, 130 interrupted by Ctrl-C (a started run keeps going).';

const implement = Command.make(
	'implement',
	{
		planDir: planDirArgument,
		noChecks: Flag.Boolean('no-checks').pipe(
			Flag.withDescription('Commit the work without running the checks'),
			Flag.withDefault(false)
		)
	},
	Effect.fn('ship.implement')(function* ({ planDir, noChecks }) {
		const invocation = yield* Invocation;
		const connection = yield* connectDaemon();
		yield* startAndFollow(
			connection,
			connection.rpc.implement({
				planDir: resolve(invocation.cwd, planDir),
				checks: !noChecks,
				cwd: invocation.cwd,
				env: invocation.env
			})
		);
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		`Implement a plan on the current branch: the baseline checks, the implementer, then the checks, fixing failing ones, and a commit. No review and no PR. ${STREAMS}`
	)
);

const checks = Command.make(
	'checks',
	{},
	Effect.fn('ship.checks')(function* () {
		const invocation = yield* Invocation;
		const connection = yield* connectDaemon();
		yield* startAndFollow(
			connection,
			connection.rpc.checks({ cwd: invocation.cwd, env: invocation.env })
		);
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		`Run the checks on the files the branch changed since it left the default branch, fix failing ones, and commit the fixes. Needs a clean tree on a feature branch. ${STREAMS}`
	)
);

const pr = Command.make(
	'pr',
	{
		plan: Flag.String('plan').pipe(
			Flag.withDescription('A plan dir whose spec and plan the PR body may draw on'),
			Flag.optional
		)
	},
	Effect.fn('ship.pr')(function* ({ plan }) {
		const invocation = yield* Invocation;
		const connection = yield* connectDaemon();
		yield* startAndFollow(
			connection,
			connection.rpc.pr({
				planDir: Option.match(plan, {
					onNone: () => null,
					onSome: (dir) => resolve(invocation.cwd, dir)
				}),
				cwd: invocation.cwd,
				env: invocation.env
			})
		);
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		`Push the current branch and open or update its PR, following the \`pr\` skill. Never squashes. Needs a clean tree on a feature branch. ${STREAMS}`
	)
);

const post = Command.make(
	'post',
	{
		review: Argument.String('review-id').pipe(
			Argument.withDescription('The review to post, as `ship review` prints it'),
			Argument.withSchema(ReviewId)
		)
	},
	Effect.fn('ship.post')(function* ({ review }) {
		const invocation = yield* Invocation;
		const connection = yield* connectDaemon();
		yield* startAndFollow(
			connection,
			connection.rpc.post({ review, cwd: invocation.cwd, env: invocation.env })
		);
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		`Post a stored review on its PR: changes requested when there are must-fix findings, a comment otherwise. Run it in a checkout whose HEAD is the reviewed head. ${STREAMS}`
	)
);

const resume = Command.make(
	'resume',
	{ id: runIdArgument },
	Effect.fn('ship.resume')(function* ({ id }) {
		const invocation = yield* Invocation;
		const connection = yield* connectDaemon();
		const { rpc } = connection;
		// Only this resume's events are shown; the cost total still counts the earlier ones.
		const format = makeEventFormatter();
		const from = yield* catchUp(rpc, id, format).pipe(
			Effect.catchTag('RunNotFound', (error) => Effect.fail(runNotFound(error)))
		);
		yield* rpc.resume({ runId: id, env: invocation.env }).pipe(
			Effect.catchTags({
				RunNotFound: (error) => Effect.fail(runNotFound(error)),
				InvalidRunStatus: (error) => Effect.fail(invalidStatus('resume')(error)),
				SnapshotNotResumable: (error) =>
					Effect.fail(
						cliError(
							`${error.message}; an interrupted run can still be finished with \`ship cancel ${id}\``
						)
					)
			}),
			Effect.onInterrupt(() =>
				Console.error(
					`ship: interrupted before the daemon answered; \`ship status ${id}\` shows whether the run resumed`
				)
			)
		);
		yield* Console.error(`ship: run ${id} resumed`);
		yield* follow(connection, id, from + 1, format);
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		'Continue an interrupted run, or retry a failed one from the step that failed, with the current env, streaming and exiting like the command that started it.'
	)
);

const cancel = Command.make(
	'cancel',
	{ id: runIdArgument },
	Effect.fn('ship.cancel')(function* ({ id }) {
		const { rpc } = yield* connectDaemon();
		yield* rpc.cancel({ runId: id }).pipe(
			Effect.catchTags({
				RunNotFound: (error) => Effect.fail(runNotFound(error)),
				InvalidRunStatus: (error) => Effect.fail(invalidStatus('cancel')(error))
			})
		);
		yield* Console.error(`ship: run ${id} cancelled`);
	}, Effect.scoped)
).pipe(Command.withDescription('Stop a run; it ends as cancelled.'));

const status = Command.make(
	'status',
	{
		id: Argument.optional(runIdArgument),
		json: jsonFlag
	},
	Effect.fn('ship.status')(function* ({ id, json: asJson }) {
		const { rpc } = yield* connectDaemon();
		if (Option.isSome(id)) {
			const info = yield* rpc
				.status({ runId: id.value })
				.pipe(Effect.catchTag('RunNotFound', (error) => Effect.fail(runNotFound(error))));
			yield* Console.log(asJson ? json(encodeRunInfo(info)) : runDetails(info));
			return;
		}
		const active = yield* rpc.list({ status: ['running', 'waiting'] });
		if (asJson) yield* Console.log(json(encodeRunInfos(active)));
		else yield* Console.log(active.length === 0 ? 'No active runs.' : runTable(active));
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		"Show a run's details and summary, or the active runs when no id is given."
	)
);

const list = Command.make(
	'list',
	{
		limit: Flag.Int('limit').pipe(
			Flag.withDescription('How many runs to show'),
			Flag.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
			Flag.withDefault(20)
		),
		json: jsonFlag
	},
	Effect.fn('ship.list')(function* ({ limit, json: asJson }) {
		const { rpc } = yield* connectDaemon();
		const runs = yield* rpc.list({ limit });
		if (asJson) yield* Console.log(json(encodeRunInfos(runs)));
		else yield* Console.log(runs.length === 0 ? 'No runs yet.' : runTable(runs));
	}, Effect.scoped)
).pipe(Command.withDescription('List recent runs, most recently updated first.'));

const logs = Command.make(
	'logs',
	{
		id: runIdArgument,
		follow: Flag.Boolean('follow').pipe(
			Flag.withAlias('f'),
			Flag.withDescription('Keep printing new events until the run ends'),
			Flag.withDefault(false)
		),
		json: Flag.Boolean('json').pipe(
			Flag.withDescription('Print each event as one line of JSON'),
			Flag.withDefault(false)
		)
	},
	Effect.fn('ship.logs')(function* ({ id, follow: following, json: asJson }) {
		const { rpc } = yield* connectDaemon();
		const format = makeEventFormatter();
		yield* rpc.events({ runId: id, follow: following }).pipe(
			Stream.runForEach((envelope) => {
				if (asJson) return Console.log(JSON.stringify(encodeEnvelope(envelope)));
				const line = format(envelope.event);
				return line === null ? Effect.void : Console.log(line);
			}),
			Effect.catchTag('RunNotFound', (error) => Effect.fail(runNotFound(error)))
		);
	}, Effect.scoped)
).pipe(Command.withDescription("Print a run's event log."));

const daemonStatus = Command.make(
	'status',
	{},
	Effect.fn('ship.daemon.status')(function* () {
		const connection = yield* connectDaemon({ allowMismatch: true });
		const pid = yield* readDaemonPid(connection.paths);
		const lines = [
			`ship daemon ${connection.daemonVersion}${pid === null ? '' : ` (pid ${pid})`}`,
			`socket: ${connection.paths.socket}`,
			`log: ${connection.paths.daemonLog}`,
			`active runs: ${connection.activeRuns}`
		];
		yield* Console.log(lines.join('\n'));
		if (connection.mismatch !== null) {
			yield* Console.error(`ship: ${mismatchMessage(connection.mismatch)}`);
		}
	}, Effect.scoped)
).pipe(Command.withDescription('Show the daemon, starting it if it is not running.'));

const daemonStop = Command.make(
	'stop',
	{ force: forceFlag('Stop') },
	Effect.fn('ship.daemon.stop')(function* ({ force }) {
		const connection = yield* findDaemon({ allowMismatch: true });
		if (connection === null) {
			yield* Console.error('ship: no daemon is running');
			return;
		}
		yield* stopDaemon(connection, force);
		yield* Console.error('ship: daemon stopped');
	}, Effect.scoped)
).pipe(Command.withDescription('Stop the daemon; refused while runs are active, unless --force.'));

const daemonRestart = Command.make(
	'restart',
	{ force: forceFlag('Restart') },
	Effect.fn('ship.daemon.restart')(function* ({ force }) {
		const running = yield* findDaemon({ allowMismatch: true });
		if (running !== null) yield* stopDaemon(running, force);
		const connection = yield* launchDaemon();
		yield* Console.error(`ship: daemon ${connection.daemonVersion} started`);
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		'Restart the daemon, e.g. after upgrading ship or editing lock permits; refused while runs are active, unless --force.'
	)
);

const daemon = Command.make('daemon').pipe(
	Command.withDescription('Manage the background daemon that hosts the runs.'),
	Command.withSubcommands([daemonStatus, daemonStop, daemonRestart])
);

/** The `ship` command tree. `ship daemon serve` is not part of it: the entry handles it. */
export const ship = Command.make('ship').pipe(
	Command.withDescription(
		'Run the scripted part of a coding-agent workflow: implement, checks, review, fix, PR.'
	),
	Command.withSubcommands([
		run,
		review,
		fix,
		recheck,
		implement,
		checks,
		pr,
		post,
		resume,
		cancel,
		status,
		list,
		logs,
		daemon,
		init,
		conventions,
		auth
	])
);
