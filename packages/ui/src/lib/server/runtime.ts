/**
 * Runs the inbox for the remote functions. A failure is logged, then answered as an HTTP
 * error: 503 when the daemon is unreachable, which the UI shows as a banner while it
 * reconnects, 404 for a deliverable that is gone, 500 for anything else.
 */
import { NodeServices } from '@effect/platform-node';
import { ShipHome, shipPaths } from '@ship/core/contract';
import { DaemonClient, shipHomeDir } from '@ship/daemon/client';
import { error } from '@sveltejs/kit';
import { Cause, Effect, Layer, ManagedRuntime, Predicate, Stream } from 'effect';
import { resolve } from 'node:path';
import { DaemonUnreachable, Inbox } from './inbox.ts';

/**
 * The inbox over the daemon of ship's home, `SHIP_HOME` or `~/.ship`. `ship ui` has
 * started that daemon before it serves the UI, so the UI only connects to it.
 */
const InboxLive = Layer.unwrap(
	Effect.map(shipHomeDir, (dir) => {
		const home = resolve(dir);
		return Inbox.layer.pipe(
			Layer.provide([DaemonClient.layer(shipPaths(home).socket), ShipHome.layer(home)]),
			Layer.provide(NodeServices.layer)
		);
	})
);

/** The HTTP error a failure, already logged, is answered with. */
const httpError = (failure: unknown): never => {
	if (Predicate.isTagged(failure, 'DaemonUnreachable')) {
		return error(503, 'The ship daemon is unreachable; any ship command starts it again.');
	}
	if (Predicate.isTagged(failure, 'DeliverableNotFound')) {
		return error(404, 'No such deliverable.');
	}
	return error(500, 'The inbox failed; see the ship ui output.');
};

/**
 * A lost daemon is expected, and the UI says so: a warning, with the transport error when
 * there is one. Anything else is logged in full.
 */
const logFailure = (cause: Cause.Cause<unknown>) => {
	const failure = Cause.squash(cause);
	if (failure instanceof DaemonUnreachable) {
		const transport = failure.cause === undefined ? [] : [failure.cause];
		return Effect.logWarning(failure.message, ...transport);
	}
	return Effect.logError('Inbox call failed', cause);
};

/** Runs the remote functions' calls on the inbox `layer` builds, once, on the first call. */
export const makeInboxRunner = <E>(layer: Layer.Layer<Inbox, E>) => {
	const runtime = ManagedRuntime.make(layer);

	/** Runs `use` on the inbox for a `query` or a `command`. */
	const runInbox = async <A, E2>(
		use: (inbox: Inbox['Service']) => Effect.Effect<A, E2>
	): Promise<A> => {
		const exit = await runtime.runPromiseExit(Inbox.use(use).pipe(Effect.tapCause(logFailure)));
		return exit._tag === 'Success' ? exit.value : httpError(Cause.squash(exit.cause));
	};

	/** Streams `use` of the inbox for a `query.live`. */
	async function* streamInbox<A, E2>(
		use: (inbox: Inbox['Service']) => Stream.Stream<A, E2>
	): AsyncGenerator<A> {
		const stream = Stream.unwrap(Inbox.useSync(use)).pipe(Stream.tapCause(logFailure));
		try {
			// The iterator throws the squashed failure.
			yield* Stream.toAsyncIterableWith(stream, await runtime.context());
		} catch (failure) {
			httpError(failure);
		}
	}

	return { runInbox, streamInbox };
};

export const { runInbox, streamInbox } = makeInboxRunner(InboxLive);
