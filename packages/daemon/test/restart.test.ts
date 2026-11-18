import { describe, expect, it } from '@effect/vitest';
import { InvalidRunStatus, shipPaths } from '@ship/core';
import { AgentFake, GhFake } from '@ship/core/testing';
import { Context, Effect } from 'effect';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
	allEvents,
	client,
	daemon,
	daemonProcess,
	fakes,
	fixture,
	reachState,
	scriptHappyRun
} from '../src/testing.ts';

const TIMEOUT = 60_000;

const stopIn = (child: ChildProcess, signal: NodeJS.Signals) =>
	Effect.sync(() => child.kill(signal));

describe('daemon restart', () => {
	it.live(
		'marks the runs of a killed daemon interrupted; they can be resumed or cancelled',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const paths = shipPaths(fx.home);
				const killed = yield* daemonProcess(fx.home);
				const before = yield* client(fx.home);
				const { runId: resumed } = yield* before.run(fx.request);
				yield* reachState(before, resumed, 'implement');
				const { runId: cancelled } = yield* before.run(fx.request);
				yield* reachState(before, cancelled, 'implement');

				yield* stopIn(killed.child, 'SIGKILL');
				expect((yield* killed.exited).signal).toBe('SIGKILL');
				// Left behind by the killed daemon; the next one takes it over.
				expect(existsSync(paths.socket)).toBe(true);

				const services = yield* fakes;
				yield* scriptHappyRun(Context.get(services, AgentFake));
				yield* daemon(fx.home, services);
				const rpc = yield* client(fx.home);
				expect((yield* rpc.status({ runId: resumed })).status).toBe('interrupted');
				expect((yield* rpc.status({ runId: cancelled })).status).toBe('interrupted');
				expect(yield* rpc.list({ status: ['interrupted'] })).toHaveLength(2);

				yield* rpc.resume({ runId: resumed, env: fx.env });
				const events = yield* allEvents(rpc, resumed);
				expect(events).toContain('RunInterrupted');
				expect(events).toContain('RunResumed');
				expect(events.at(-1)).toBe('RunFinished');
				const done = yield* rpc.status({ runId: resumed });
				expect(done.status).toBe('done');
				expect(done.summary?.prUrl).toBe('https://github.com/f-elix/example/pull/1');
				expect((yield* Context.get(services, GhFake).prs).length).toBe(1);

				yield* rpc.cancel({ runId: cancelled });
				const stopped = yield* rpc.status({ runId: cancelled });
				expect(stopped.status).toBe('cancelled');
				expect(stopped.summary).toMatchObject({ status: 'cancelled', prUrl: null });
				expect((yield* allEvents(rpc, cancelled)).slice(-2)).toEqual([
					'RunCancelled',
					'RunFinished'
				]);
				const again = yield* Effect.flip(rpc.resume({ runId: cancelled, env: fx.env }));
				expect(again).toBeInstanceOf(InvalidRunStatus);
			}).pipe(Effect.scoped),
		TIMEOUT
	);

	it.live(
		'shuts down on SIGTERM like a forced stop',
		() =>
			Effect.gen(function* () {
				const fx = yield* fixture;
				const paths = shipPaths(fx.home);
				const stopped = yield* daemonProcess(fx.home);
				const before = yield* client(fx.home);
				const { runId } = yield* before.run(fx.request);
				yield* reachState(before, runId, 'implement');

				yield* stopIn(stopped.child, 'SIGTERM');
				// It exits on its own rather than being killed by the signal.
				expect((yield* stopped.exited).signal).toBe(null);
				expect(existsSync(paths.socket)).toBe(false);
				expect(existsSync(paths.pidFile)).toBe(false);

				yield* daemon(fx.home, yield* fakes);
				const rpc = yield* client(fx.home);
				expect((yield* rpc.status({ runId })).status).toBe('interrupted');
				const events = yield* allEvents(rpc, runId);
				// Interrupted once, by the stopping daemon; the next one found nothing to mark.
				expect(events.filter((tag) => tag === 'RunInterrupted')).toHaveLength(1);
			}).pipe(Effect.scoped),
		TIMEOUT
	);
});
