import { ActInput, DeliverableId } from '#lib/server/deliverables.ts';
import { DaemonUnreachable, DeliverableNotFound, Inbox } from '#lib/server/inbox.ts';
import { makeInboxRunner } from '#lib/server/runtime.ts';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Logger, Schema, Stream } from 'effect';

const GONE = DeliverableId.make('branch:gone');

/** An inbox that fails each way the runner tells apart; failures are not logged. */
const failing = Layer.mergeAll(
	Layer.succeed(Inbox, {
		deliverables: Stream.concat(
			Stream.make([]),
			Stream.fail(new DaemonUnreachable({ detail: 'socket closed' }))
		),
		deliverable: (id) =>
			id === GONE
				? Effect.fail(new DeliverableNotFound({ id }))
				: Effect.fail(new DaemonUnreachable({ detail: 'socket closed' })),
		act: () => Effect.die(new Error('the archive is corrupt'))
	}),
	Logger.layer([])
);

const { runInbox, streamInbox } = makeInboxRunner(failing);

describe('the inbox runner', () => {
	it('answers a lost daemon with 503, which the UI shows while it reconnects', async () => {
		await expect(
			runInbox((inbox) => inbox.deliverable(DeliverableId.make('branch:feature')))
		).rejects.toMatchObject({
			status: 503,
			body: { message: 'The ship daemon is unreachable; any ship command starts it again.' }
		});
	});

	it('answers a deliverable that is gone with 404', async () => {
		await expect(runInbox((inbox) => inbox.deliverable(GONE))).rejects.toMatchObject({
			status: 404,
			body: { message: 'No such deliverable.' }
		});
	});

	it('answers anything else with 500, without its details', async () => {
		await expect(runInbox((inbox) => inbox.act(GONE, 'fix'))).rejects.toMatchObject({
			status: 500,
			body: { message: 'The inbox failed; see the ship ui output.' }
		});
	});

	it('streams until the daemon is lost, then answers with 503', async () => {
		const stream = streamInbox((inbox) => inbox.deliverables);

		expect(await stream.next()).toEqual({ done: false, value: [] });
		await expect(stream.next()).rejects.toMatchObject({ status: 503 });
	});
});

describe('ActInput', () => {
	const validate = (input: unknown) =>
		Schema.toStandardSchemaV1(ActInput)['~standard'].validate(input);

	it('takes a deliverable and an action the inbox knows', async () => {
		expect(await validate({ id: 'branch:feature', action: 'resume' })).toEqual({
			value: { id: 'branch:feature', action: 'resume' }
		});
	});

	it('rejects an unknown action or an empty id', async () => {
		expect(await validate({ id: 'branch:feature', action: 'merge' })).toHaveProperty('issues');
		expect(await validate({ id: '', action: 'fix' })).toHaveProperty('issues');
	});
});
