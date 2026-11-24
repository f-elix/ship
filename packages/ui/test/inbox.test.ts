import { DeliverableId } from '#lib/server/deliverables.ts';
import { Inbox } from '#lib/server/inbox.ts';
import { describe, expect, it } from '@effect/vitest';
import {
	InvalidRunStatus,
	PreconditionFailed,
	ReviewId,
	type RunEvent,
	RunId,
	RunNotFound,
	SnapshotNotResumable
} from '@ship/core/contract';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import {
	at,
	DaemonFake,
	FEATURE_ID,
	finding,
	fixRun,
	PR_URL,
	PROJECT,
	reviewRun,
	sha,
	shipRun,
	withInboxTest
} from './support.ts';

/** The deliverable of review, fix and recheck runs on {@link PR_URL}, which name no branch. */
const PR_ID = DeliverableId.make(`pr:${PR_URL}`);
const REVIEW = ReviewId.make('review-1');

const created: RunEvent = {
	_tag: 'RunCreated',
	at: at(1),
	projectKey: PROJECT,
	cwd: '/repo',
	planDir: '/plans/feature',
	branch: 'feature',
	baseSha: sha(1)
};
const committed: RunEvent = { _tag: 'CommitCreated', at: at(2), sha: sha(2), message: 'Add it' };

/** A stored review of the PR that was not posted, with one must-fix finding. */
const unposted = (n: number) => {
	const run = reviewRun(n);
	return {
		...run,
		summary: {
			kind: 'review' as const,
			runId: run.runId,
			status: 'done' as const,
			prUrl: PR_URL,
			reviewUrl: null,
			reviewId: REVIEW,
			costUsd: 0,
			mustFix: [finding('f1', 'must-fix')],
			tradeoffs: [],
			nits: [],
			error: null
		}
	};
};

/**
 * Forks `run` over `stream` and returns once the stream has listed: the inbox then watches
 * the daemon, so a change made next reaches it.
 */
const forkWatching = <A, E, B, E2>(
	stream: Stream.Stream<A, E>,
	run: (stream: Stream.Stream<A, E>) => Effect.Effect<B, E2>
) =>
	Effect.gen(function* () {
		const listed = yield* Deferred.make<void>();
		const fiber = yield* Effect.forkChild(
			run(Stream.tap(stream, () => Deferred.succeed(listed, undefined)))
		);
		yield* Deferred.await(listed);
		return fiber;
	});

describe('Inbox.deliverables', () => {
	it.live('lists the deliverables, then again when a run changes', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;
			yield* daemon.put(shipRun(1, { prUrl: PR_URL }));

			const fiber = yield* forkWatching(inbox.deliverables, (s) =>
				Stream.runCollect(Stream.take(s, 2))
			);
			yield* daemon.put(
				shipRun(2, {
					planDir: '/plans/other',
					branch: 'other',
					status: 'running',
					state: 'implement'
				})
			);
			const [first, second] = yield* Fiber.join(fiber);

			expect(first!.map((d) => d.id)).toEqual([FEATURE_ID]);
			expect(second!.map((d) => [d.title, d.stage])).toEqual([
				['other', 'working'],
				['feature', 'ready']
			]);
		}).pipe(withInboxTest())
	);

	it.live('fails when the daemon stops', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;

			const fiber = yield* forkWatching(inbox.deliverables, (s) =>
				Effect.flip(Stream.runDrain(s))
			);
			yield* daemon.stop;

			expect((yield* Fiber.join(fiber))._tag).toBe('DaemonUnreachable');
		}).pipe(withInboxTest())
	);

	it.live('shares one watch between subscribers, and starts another after a lost daemon', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;
			yield* daemon.put(shipRun(1, { prUrl: PR_URL }));
			const watches = Effect.map(
				daemon.calls,
				(calls) => calls.filter((call) => call.rpc === 'watch').length
			);
			const untilLost = <A, E>(s: Stream.Stream<A, E>) => Effect.flip(Stream.runDrain(s));

			const first = yield* forkWatching(inbox.deliverables, untilLost);
			// The second subscriber gets the latest list straight away.
			const second = yield* forkWatching(inbox.deliverables, untilLost);
			expect(yield* watches).toBe(1);
			yield* daemon.stop;
			expect((yield* Fiber.join(first))._tag).toBe('DaemonUnreachable');
			expect((yield* Fiber.join(second))._tag).toBe('DaemonUnreachable');

			const [again] = yield* Stream.runCollect(Stream.take(inbox.deliverables, 1));
			expect(again!.map((d) => d.id)).toEqual([FEATURE_ID]);
			expect(yield* watches).toBe(2);
		}).pipe(withInboxTest())
	);

	it.live('re-emits when the developer archives a deliverable', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;
			yield* daemon.put(shipRun(1, { prUrl: PR_URL }), [created]);

			const fiber = yield* forkWatching(inbox.deliverables, (s) =>
				Stream.runCollect(Stream.take(s, 2))
			);
			expect(yield* inbox.act(FEATURE_ID, 'archive')).toEqual({ ok: true, runId: null });
			const [before, after] = yield* Fiber.join(fiber);

			expect(before![0]!.stage).toBe('ready');
			expect(after![0]!).toMatchObject({ stage: 'closed', actions: ['unarchive'] });
		}).pipe(withInboxTest())
	);
});

describe('Inbox.deliverable', () => {
	it.effect('details the change, the findings and the history', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;
			yield* daemon.put(shipRun(1, { prUrl: PR_URL }), [created, committed]);
			yield* daemon.put(unposted(3), []);

			const detail = yield* inbox.deliverable(FEATURE_ID);

			expect(detail.summary).toMatchObject({
				stage: 'decide',
				actions: ['post', 'fix', 'recheck', 'archive']
			});
			expect(detail.findings.mustFix.map((f) => f.id)).toEqual(['f1']);
			expect(detail.commits).toEqual([{ sha: sha(2), message: 'Add it' }]);
			expect(detail.files).toEqual([{ path: 'src/feature.ts', status: 'modified' }]);
			expect(detail.runs.map((run) => run.command)).toEqual(['ship review', 'ship run']);
			expect(
				detail.runs[1]!.lines.some((line) => line.includes('commit 0000000 Add it'))
			).toBe(true);
		}).pipe(
			withInboxTest({
				git: { changedFiles: [{ path: 'src/feature.ts', status: 'modified' }] }
			})
		)
	);

	it.effect('fails for a deliverable no run makes up', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const error = yield* Effect.flip(inbox.deliverable(FEATURE_ID));
			expect(error._tag).toBe('DeliverableNotFound');
		}).pipe(withInboxTest())
	);
});

describe('Inbox.act', () => {
	it.effect('fixes the stored review from the latest run’s checkout', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;
			yield* daemon.put(shipRun(1, { prUrl: PR_URL }), []);
			yield* daemon.put({ ...unposted(2), cwd: '/checkout' }, []);

			expect(yield* inbox.act(FEATURE_ID, 'fix')).toEqual({ ok: true, runId: 'run-new' });
			expect(yield* daemon.calls).toEqual([
				{
					rpc: 'fix',
					payload: expect.objectContaining({
						source: { _tag: 'Review', reviewId: REVIEW },
						local: false,
						checks: true,
						cwd: '/checkout'
					})
				}
			]);
		}).pipe(withInboxTest())
	);

	it.effect('rechecks the stored review from the latest run’s checkout', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;
			yield* daemon.put(shipRun(1, { prUrl: PR_URL }), []);
			yield* daemon.put({ ...unposted(2), cwd: '/checkout' }, []);

			expect(yield* inbox.act(FEATURE_ID, 'recheck')).toEqual({ ok: true, runId: 'run-new' });
			expect(yield* daemon.calls).toEqual([
				{
					rpc: 'recheck',
					payload: expect.objectContaining({
						source: { _tag: 'Review', reviewId: REVIEW },
						local: false,
						cwd: '/checkout'
					})
				}
			]);
		}).pipe(withInboxTest())
	);

	// Live: an archive mark counts only when it is newer than the runs.
	it.live('unarchives an archived deliverable back to where it stood', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;
			yield* daemon.put(shipRun(1, { prUrl: PR_URL }), [created]);
			const stage = Effect.map(
				inbox.deliverable(FEATURE_ID),
				(detail) => detail.summary.stage
			);

			expect(yield* inbox.act(FEATURE_ID, 'archive')).toEqual({ ok: true, runId: null });
			expect(yield* stage).toBe('closed');
			expect(yield* inbox.act(FEATURE_ID, 'unarchive')).toEqual({ ok: true, runId: null });
			expect(yield* stage).toBe('ready');
			expect(yield* daemon.calls).toEqual([]);
		}).pipe(withInboxTest())
	);

	it.effect('posts the unposted review, and resumes or cancels the latest run', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;
			yield* daemon.put(unposted(1), []);
			expect(yield* inbox.act(PR_ID, 'post')).toEqual({ ok: true, runId: 'run-new' });

			yield* daemon.put(fixRun(2, { status: 'interrupted' }), []);
			expect(yield* inbox.act(PR_ID, 'resume')).toEqual({ ok: true, runId: 'run-2' });
			expect(yield* inbox.act(PR_ID, 'cancel')).toEqual({ ok: true, runId: 'run-2' });

			expect((yield* daemon.calls).map((call) => [call.rpc, call.payload])).toEqual([
				['post', expect.objectContaining({ review: REVIEW, cwd: '/repo' })],
				['resume', expect.objectContaining({ runId: 'run-2' })],
				['cancel', { runId: 'run-2' }]
			]);
		}).pipe(withInboxTest())
	);

	it.effect('returns the daemon’s refusal as a value', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;
			yield* daemon.put(shipRun(1, { prUrl: PR_URL }), []);
			yield* daemon.refuse(
				'fix',
				new PreconditionFailed({ reason: 'dirty-tree', detail: 'Commit or stash first.' })
			);

			expect(yield* inbox.act(FEATURE_ID, 'fix')).toEqual({
				ok: false,
				_tag: 'PreconditionFailed',
				detail: 'Commit or stash first.'
			});
		}).pipe(withInboxTest())
	);

	it.effect('returns the daemon’s refusal to resume or cancel as a value', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;
			const runId = RunId.make('run-2');
			yield* daemon.put(fixRun(2, { status: 'interrupted' }), []);

			yield* daemon.refuse('resume', new InvalidRunStatus({ runId, status: 'running' }));
			expect(yield* inbox.act(PR_ID, 'resume')).toEqual({
				ok: false,
				_tag: 'InvalidRunStatus',
				detail: 'The run is running now.'
			});
			yield* daemon.refuse(
				'resume',
				new SnapshotNotResumable({ runId, reason: 'the snapshot is from an older ship' })
			);
			expect(yield* inbox.act(PR_ID, 'resume')).toEqual({
				ok: false,
				_tag: 'SnapshotNotResumable',
				detail: 'Run run-2 cannot be resumed: the snapshot is from an older ship'
			});
			yield* daemon.refuse('resume', new RunNotFound({ runId }));
			expect(yield* inbox.act(PR_ID, 'resume')).toEqual({
				ok: false,
				_tag: 'RunNotFound',
				detail: 'No run run-2.'
			});
			yield* daemon.refuse('cancel', new InvalidRunStatus({ runId, status: 'done' }));
			expect(yield* inbox.act(PR_ID, 'cancel')).toEqual({
				ok: false,
				_tag: 'InvalidRunStatus',
				detail: 'The run is done now.'
			});
		}).pipe(withInboxTest())
	);

	it.effect('refuses an action the deliverable does not offer, or one that is gone', () =>
		Effect.gen(function* () {
			const inbox = yield* Inbox;
			const daemon = yield* DaemonFake;
			yield* daemon.put(shipRun(1, { prUrl: PR_URL }), []);

			expect(yield* inbox.act(FEATURE_ID, 'post')).toMatchObject({
				ok: false,
				_tag: 'ActionUnavailable'
			});
			expect(
				yield* inbox.act(DeliverableId.make('pr:https://github.com/a/b/pull/1'), 'fix')
			).toMatchObject({
				ok: false,
				_tag: 'DeliverableNotFound'
			});
			expect(yield* daemon.calls).toEqual([]);
		}).pipe(withInboxTest())
	);
});
