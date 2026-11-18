import { NodeServices } from '@effect/platform-node';
import { assert, describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Queue, Schedule } from 'effect';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	Checks,
	CheckSpawnError,
	CheckTimeout,
	expandFiles,
	filesForChecks,
	Locks,
	type Check,
	type CheckEvent,
	type CheckPass,
	type RunChecksInput
} from '../src/index.ts';
import { tempDir } from './temp-repo.ts';

const layerWith = (outputTail?: { maxLines: number; maxBytes: number }) =>
	Checks.layerWith(outputTail === undefined ? {} : { outputTail }).pipe(
		Layer.provideMerge(Locks.layer({ cpu: 1, db: 1 })),
		Layer.provide(NodeServices.layer)
	);
const ChecksLive = layerWith();

const pass: CheckPass = { baseline: false, round: 1, attempt: 0 };
const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', SHIP_TEST: 'caller' };

const check = (name: string, run: string, extra: Partial<Check> = {}): Check => ({
	name,
	run,
	lock: 'cpu',
	...extra
});

/** Runs the checks in `cwd` and returns the round and every event, as `tag:check:command`. */
const runChecks = (
	input: Omit<RunChecksInput, 'env' | 'pass' | 'onEvent'> & Partial<RunChecksInput>
) =>
	Effect.gen(function* () {
		const checks = yield* Checks;
		const events: Array<CheckEvent> = [];
		const round = yield* checks.run({
			env,
			pass,
			onEvent: (event) => Effect.sync(() => events.push(event)),
			...input
		});
		return { round, events };
	});

const describeEvent = (event: CheckEvent): string =>
	event._tag === 'CheckStarted' || event._tag === 'CheckFinished'
		? `${event._tag}:${event.check}:${event.command}`
		: `${event._tag}:${event.check}`;

describe('Checks', () => {
	it.live('times each command once it holds its lock, not while it waits', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const locks = yield* Locks;
			const held = yield* Deferred.make<void>();
			const holder = yield* locks
				.withPermit(
					'cpu',
					Effect.andThen(Deferred.succeed(held, undefined), Effect.sleep('400 millis'))
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(held);

			// Waits about 400ms for the lock, longer than its 300ms limit, then runs at once.
			const { round } = yield* runChecks({
				cwd: dir,
				files: [],
				checks: [check('quick', 'true')],
				timeoutMs: 300
			});
			expect(round.results.map((result) => result.exitCode)).toEqual([0]);
			yield* Fiber.join(holder);

			const error = yield* Effect.flip(
				runChecks({
					cwd: dir,
					files: [],
					checks: [check('slow', 'sleep 5')],
					timeoutMs: 100
				})
			);
			expect(error).toBeInstanceOf(CheckTimeout);
			expect(error).toMatchObject({ check: 'slow', commandLine: 'sleep 5', timeoutMs: 100 });
		}).pipe(Effect.scoped, Effect.provide(ChecksLive))
	);

	it.live('runs with the caller env and cwd, never the daemon env', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			process.env['SHIP_DAEMON_ONLY'] = 'leaked';
			const { events } = yield* runChecks({
				cwd: dir,
				files: [],
				checks: [
					check(
						'env',
						'printf "%s|%s|%s" "$SHIP_TEST" "${SHIP_DAEMON_ONLY-unset}" "$(pwd -P)"'
					)
				]
			}).pipe(Effect.ensuring(Effect.sync(() => delete process.env['SHIP_DAEMON_ONLY'])));
			const finished = events.find((event) => event._tag === 'CheckFinished');
			assert(finished?._tag === 'CheckFinished');
			expect(finished.outputTail).toBe(`caller|unset|${dir}`);
			expect(finished.exitCode).toBe(0);
		}).pipe(Effect.scoped, Effect.provide(ChecksLive))
	);

	it.live('expands {files} shell-quoted and skips the check when no files changed', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const files = ['a b.ts', "it's.ts", '-rf.ts', '$(touch pwned)'];
			const checks = [check('list', "printf '%s\\n' {files}; exit 1"), check('all', 'true')];

			const { round } = yield* runChecks({ cwd: dir, files, checks });
			expect(round.results[0]?.outputTail).toBe("a b.ts\nit's.ts\n./-rf.ts\n$(touch pwned)");
			expect(existsSync(join(dir, 'pwned'))).toBe(false);

			const skipped = yield* runChecks({ cwd: dir, files: [], checks });
			expect(skipped.round.results.map((result) => result.name)).toEqual(['all']);
			expect(skipped.events.map(describeEvent)).not.toContain('CheckStarted:list:run');
		}).pipe(Effect.scoped, Effect.provide(ChecksLive))
	);

	it.live('runs the fix command first, under the lock, except for the baseline', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const checks = [check('fmt', 'test -f fixed', { fix: 'touch fixed', lock: 'db' })];

			const baseline = yield* runChecks({
				cwd: dir,
				files: [],
				checks,
				pass: { baseline: true, round: 0, attempt: 0 }
			});
			expect(baseline.round).toEqual({
				baseline: true,
				round: 0,
				attempt: 0,
				results: [
					{ name: 'fmt', exitCode: 1, durationMs: expect.any(Number), outputTail: '' }
				]
			});

			const { round, events } = yield* runChecks({ cwd: dir, files: [], checks });
			expect(round.results).toEqual([
				{ name: 'fmt', exitCode: 0, durationMs: expect.any(Number) }
			]);
			expect(events.map(describeEvent)).toEqual([
				'LockAcquired:fmt',
				'CheckStarted:fmt:fix',
				'CheckFinished:fmt:fix',
				'CheckStarted:fmt:run',
				'CheckFinished:fmt:run',
				'LockReleased:fmt'
			]);
			expect(events[0]).toMatchObject({ resource: 'db', waitedMs: 0 });
			expect(events[1]).toMatchObject({ commandLine: 'touch fixed', round: 1, attempt: 0 });
		}).pipe(Effect.scoped, Effect.provide(ChecksLive))
	);

	it.live('runs every check after a failure and keeps output only for failures', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const { round } = yield* runChecks({
				cwd: dir,
				files: [],
				checks: [
					check('lint', 'echo "3 problems" >&2; exit 2'),
					check('test', 'echo ok'),
					check('missing', 'definitely-not-a-command-ship')
				]
			});
			expect(round.results.map(({ name, exitCode }) => [name, exitCode])).toEqual([
				['lint', 2],
				['test', 0],
				['missing', 127]
			]);
			expect(round.results[0]?.outputTail).toBe('3 problems');
			expect(round.results[1]).not.toHaveProperty('outputTail');
			expect(round.results[2]?.outputTail).toMatch(/not found/);
		}).pipe(Effect.scoped, Effect.provide(ChecksLive))
	);

	it.live('trims the output tail by lines, then bytes, and strips colours', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const failing = (command: string) => [check('c', `${command}; exit 1`)];

			const byLines = yield* runChecks({
				cwd: dir,
				files: [],
				checks: failing('seq 1 100')
			}).pipe(Effect.provide(layerWith({ maxLines: 3, maxBytes: 10_000 })));
			expect(byLines.round.results[0]?.outputTail).toBe('…\n98\n99\n100');

			const byBytes = yield* runChecks({
				cwd: dir,
				files: [],
				checks: failing("printf 'aaaaaaaaaa\\nbbbb\\nccc\\n'")
			}).pipe(Effect.provide(layerWith({ maxLines: 100, maxBytes: 10 })));
			expect(byBytes.round.results[0]?.outputTail).toBe('…\nbbbb\nccc');

			const colours = yield* runChecks({
				cwd: dir,
				files: [],
				checks: failing("printf '\\033[31mred\\033[0m\\r\\nplain\\n'")
			});
			expect(colours.round.results[0]?.outputTail).toBe('red\nplain');
		}).pipe(Effect.scoped, Effect.provide(ChecksLive))
	);

	it.live('waits for a busy lock and reports the wait', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const locks = yield* Locks;
			const checks = yield* Checks;
			const events = yield* Queue.unbounded<CheckEvent>();
			const held = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const holder = yield* locks
				.withPermit(
					'cpu',
					Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release))
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(held);

			const running = yield* checks
				.run({
					cwd: dir,
					env,
					files: [],
					pass,
					checks: [check('slow', 'true')],
					onEvent: (event) => Queue.offer(events, event).pipe(Effect.asVoid)
				})
				.pipe(Effect.forkChild);
			const waiting = yield* Queue.take(events);
			expect(waiting).toMatchObject({
				_tag: 'LockWaiting',
				resource: 'cpu',
				check: 'slow',
				position: 1
			});

			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(holder);
			const round = yield* Fiber.join(running);
			expect(round.results[0]?.exitCode).toBe(0);
			const acquired = yield* Queue.take(events);
			expect(acquired._tag).toBe('LockAcquired');
		}).pipe(Effect.scoped, Effect.provide(ChecksLive))
	);

	it.live('kills the whole process tree when interrupted', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const checks = yield* Checks;
			const pidFile = join(dir, 'grandchild.pid');
			const fiber = yield* checks
				.run({
					cwd: dir,
					env,
					files: [],
					pass,
					checks: [check('hang', `sh -c 'sleep 60 & echo $! > ${pidFile}; wait'`)]
				})
				.pipe(Effect.forkChild);

			const readPid = Effect.suspend(() =>
				existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''
					? Effect.succeed(Number(readFileSync(pidFile, 'utf8').trim()))
					: Effect.fail('not yet')
			);
			const pid = yield* readPid.pipe(Effect.retry(Schedule.spaced('20 millis')));
			expect(isAlive(pid)).toBe(true);

			yield* Fiber.interrupt(fiber);
			const stopped = Effect.suspend(() =>
				isAlive(pid) ? Effect.fail('alive') : Effect.succeed(true)
			);
			expect(
				yield* stopped.pipe(
					Effect.retry({ schedule: Schedule.spaced('20 millis'), times: 50 })
				)
			).toBe(true);
		}).pipe(Effect.scoped, Effect.provide(ChecksLive))
	);

	it.live('fails with CheckSpawnError when the shell cannot start', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const error = yield* Effect.flip(
				runChecks({ cwd: join(dir, 'missing'), files: [], checks: [check('a', 'true')] })
			);
			assert.instanceOf(error, CheckSpawnError);
			expect(error.cwd).toBe(join(dir, 'missing'));
		}).pipe(Effect.scoped, Effect.provide(ChecksLive))
	);
});

describe('Checks.format', () => {
	it.live('runs the format command without a lock and skips it with no files', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const checks = yield* Checks;
			const locks = yield* Locks;
			const input = { cwd: dir, env, command: 'touch {files} && echo formatted' };

			// Holding every cpu permit does not block formatting.
			const result = yield* locks.withPermit(
				'cpu',
				checks.format({ ...input, files: ['one.ts', 'two words.ts'] })
			);
			expect(result).toEqual({
				commandLine: "touch 'one.ts' 'two words.ts' && echo formatted",
				exitCode: 0,
				durationMs: expect.any(Number),
				outputTail: 'formatted'
			});
			expect(existsSync(join(dir, 'two words.ts'))).toBe(true);
			expect(yield* checks.format({ ...input, files: [] })).toBeNull();
			expect(
				(yield* checks.format({ ...input, command: 'exit 4', files: [] }))?.exitCode
			).toBe(4);
		}).pipe(Effect.scoped, Effect.provide(ChecksLive))
	);
});

describe('{files} helpers', () => {
	it('expands every placeholder and leaves commands without one alone', () => {
		expect(expandFiles('eslint {files} && prettier -c {files}', ['a.ts'])).toBe(
			"eslint 'a.ts' && prettier -c 'a.ts'"
		);
		expect(expandFiles('vitest run', [])).toBe('vitest run');
		expect(expandFiles('eslint {files}', [])).toBeNull();
	});

	it('leaves deleted files out', () => {
		expect(
			filesForChecks([
				{ path: 'a.ts', status: 'modified' },
				{ path: 'b.ts', status: 'deleted' },
				{ path: 'c.ts', status: 'renamed', oldPath: 'old.ts' }
			])
		).toEqual(['a.ts', 'c.ts']);
	});
});

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
