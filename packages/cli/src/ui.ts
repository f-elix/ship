import { Console, Effect, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cliError, connectDaemon, type ShipCliError } from './connection.ts';
import { Invocation } from './invocation.ts';

/** The SvelteKit build of `packages/ui`, which tsdown copies next to the bundled CLI. */
const HANDLER = fileURLToPath(new URL('./ui/handler.js', import.meta.url));

/** Opens `url` in the default browser, best effort: the URL is printed either way. */
const openBrowser = (url: string) =>
	Effect.sync(() => {
		const [command, args] =
			process.platform === 'darwin'
				? ['open', [url]]
				: process.platform === 'win32'
					? ['cmd', ['/c', 'start', '', url]]
					: ['xdg-open', [url]];
		const child = spawn(command, args, { detached: true, stdio: 'ignore' });
		child.on('error', () => {});
		child.unref();
	});

/**
 * Loads the UI's request handler for `origin`, setting the environment it reads first:
 * `ORIGIN`, read when it is imported, makes it accept the remote calls of pages served
 * from `origin` only; `SHIP_HOME`, read on its first remote call, points it at this
 * invocation's daemon.
 */
const loadHandler = Effect.fnUntraced(function* (origin: string) {
	if (!existsSync(HANDLER)) {
		return yield* cliError(`the UI is not built: ${HANDLER} is missing; run \`pnpm build\``);
	}
	process.env['ORIGIN'] = origin;
	process.env['SHIP_HOME'] = (yield* Invocation).home;
	const module: { handler: RequestListener } = yield* Effect.tryPromise({
		try: () => import(pathToFileURL(HANDLER).href),
		catch: (cause) =>
			cliError(
				`cannot load the UI build at ${HANDLER}: ${String(cause)}; run \`pnpm build\``,
				{
					cause
				}
			)
	});
	return module.handler;
});

/** The `Host` values of a page `server` served: its address, by IP or by name. */
const hostsOf = (server: Server): ReadonlySet<string> => {
	const address = server.address();
	if (typeof address !== 'object' || address === null) return new Set();
	return new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
};

/**
 * Serves `handler` on 127.0.0.1 at `port` (0 picks a free one) until the scope closes. A
 * request naming another host is refused, so a web page cannot reach the UI through a DNS
 * name rebound to 127.0.0.1.
 */
export const serve = (handler: RequestListener, port: number) =>
	Effect.acquireRelease(
		Effect.callback<Server, ShipCliError>((resume) => {
			const server = createServer((request, response) => {
				if (hostsOf(server).has(request.headers.host ?? ''))
					return handler(request, response);
				response.writeHead(403).end();
			});
			server.once('error', (error: NodeJS.ErrnoException) =>
				resume(
					Effect.fail(
						cliError(
							error.code === 'EADDRINUSE'
								? `port ${port} is in use; pass another with --port`
								: `cannot serve the UI: ${error.message}`,
							{ cause: error }
						)
					)
				)
			);
			server.listen(port, '127.0.0.1', () => resume(Effect.succeed(server)));
		}),
		(server) =>
			Effect.callback<void>((resume) => {
				server.close(() => resume(Effect.void));
				// Open live queries would hold `close` until the browser leaves.
				server.closeAllConnections();
			})
	);

export const ui = Command.make(
	'ui',
	{
		port: Flag.Int('port').pipe(
			Flag.withDescription('The port to serve the UI on, on 127.0.0.1'),
			Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
			Flag.withDefault(4477)
		),
		noOpen: Flag.Boolean('no-open').pipe(
			Flag.withDescription('Print the URL without opening a browser'),
			Flag.withDefault(false)
		)
	},
	Effect.fn('ship.ui')(function* ({ port, noOpen }) {
		const url = `http://127.0.0.1:${port}`;
		const handler = yield* loadHandler(url);
		// Starts the daemon if needed and checks its version; the UI then only connects to it.
		yield* connectDaemon();
		yield* serve(handler, port);
		yield* Console.error(`ship: the inbox is at ${url}; Ctrl-C stops it`);
		if (!noOpen) yield* openBrowser(url);
		return yield* Effect.never;
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		'Serve a local inbox of your runs in the browser: what needs a decision, what is ready, what is in progress, with their findings and actions. Runs until Ctrl-C.'
	)
);
