/**
 * The browser's calls to the inbox. Arguments are checked with Effect Schema, through
 * Standard Schema; `runtime.ts` turns failures into HTTP errors.
 */
import { ActInput, DeliverableId } from '#lib/server/deliverables.ts';
import { runInbox, streamInbox } from '#lib/server/runtime.ts';
import { command, query } from '$app/server';
import { Schema } from 'effect';

/** Every deliverable, newest activity first, live. */
export const deliverables = query.live(() => streamInbox((inbox) => inbox.deliverables));

/** One deliverable in full. */
export const deliverable = query(Schema.toStandardSchemaV1(DeliverableId), (id) =>
	runInbox((inbox) => inbox.deliverable(id))
);

/** Starts an action on a deliverable; a refusal comes back as `{ ok: false }`. */
export const act = command(Schema.toStandardSchemaV1(ActInput), ({ id, action }) =>
	runInbox((inbox) => inbox.act(id, action))
);
