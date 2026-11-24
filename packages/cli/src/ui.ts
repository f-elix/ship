import { Console, Effect, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
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

/** A new launch token: 256 random bits, URL-safe. */
const newToken = () => randomBytes(32).toString('base64url');

/** Whether `candidate` is `token`, compared in constant time. */
const isToken = (candidate: string | null, token: string): boolean => {
	if (candidate === null) return false;
	const given = Buffer.from(candidate);
	const expected = Buffer.from(token);
	return given.length === expected.length && timingSafeEqual(given, expected);
};

/** The value of cookie `name` in a `Cookie` header, or `null` when it is not there. */
const cookieOf = (header: string | undefined, name: string): string | null => {
	for (const pair of (header ?? '').split(';')) {
		const separator = pair.indexOf('=');
		if (separator !== -1 && pair.slice(0, separator).trim() === name) {
			return pair.slice(separator + 1).trim();
		}
	}
	return null;
};

const redirect = (response: ServerResponse, status: 303 | 307, location: URL) =>
	response.writeHead(status, { location: location.href }).end();

/**
 * Answers one request to the UI served on 127.0.0.1, letting only the browser that opened
 * the launch URL through to `handler`:
 *
 * - A `Host` that names `localhost` is redirected to the same path on 127.0.0.1, the only
 *   origin the UI accepts remote calls from. Any other host is refused, so a web page
 *   cannot reach the UI through a DNS name rebound to 127.0.0.1.
 * - A request whose `token` parameter is `token` gets it back as an `HttpOnly`,
 *   `SameSite=Strict` cookie, and is redirected to the same URL without the parameter,
 *   which keeps the token out of the history and the address bar.
 * - A request with that cookie reaches `handler`; any other is refused.
 *
 * The cookie's name holds the port, because cookies ignore ports: two `ship ui` would
 * otherwise overwrite each other's.
 */
const gate =
	(handler: RequestListener, token: string): RequestListener =>
	(request, response) => {
		const port = request.socket.localPort;
		const origin = `http://127.0.0.1:${port}`;
		const url = URL.parse(request.url ?? '/', origin);
		if (url === null) return response.writeHead(400).end();
		// The path and query alone, so a target in absolute form, or a path that starts with
		// `//`, cannot redirect off 127.0.0.1.
		const here = new URL(origin);
		here.pathname = url.pathname;
		here.search = url.search;
		switch (request.headers.host) {
			case `localhost:${port}`:
				return redirect(response, 307, here);
			case `127.0.0.1:${port}`:
				break;
			default:
				return response.writeHead(403).end();
		}
		const cookie = `ship-ui-${port}`;
		if (isToken(here.searchParams.get('token'), token)) {
			here.searchParams.delete('token');
			response.setHeader(
				'set-cookie',
				`${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/`
			);
			return redirect(response, 303, here);
		}
		if (isToken(cookieOf(request.headers.cookie, cookie), token)) {
			return handler(request, response);
		}
		response.writeHead(403).end();
	};

/** A running UI: the URL that opens it, which carries the launch token, and its port. */
export interface Launch {
	readonly url: string;
	readonly port: number;
}

/**
 * Serves `handler` on 127.0.0.1 at `port` (0 picks a free one) until the scope closes,
 * behind a new launch token; see {@link gate}.
 */
export const serve = Effect.fnUntraced(function* (handler: RequestListener, port: number) {
	const token = newToken();
	const server = yield* Effect.acquireRelease(
		Effect.callback<Server, ShipCliError>((resume) => {
			const server = createServer(gate(handler, token));
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
	const address = server.address();
	// A server listening on a TCP port reports its address as an object.
	if (typeof address !== 'object' || address === null) {
		return yield* Effect.die(new Error(`the UI server reports no port: ${String(address)}`));
	}
	return {
		url: `http://127.0.0.1:${address.port}/?token=${token}`,
		port: address.port
	} satisfies Launch;
});

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
		const handler = yield* loadHandler(`http://127.0.0.1:${port}`);
		// Starts the daemon if needed and checks its version; the UI then only connects to it.
		yield* connectDaemon();
		const { url } = yield* serve(handler, port);
		yield* Console.error(`ship: the inbox is at ${url}; Ctrl-C stops it`);
		if (!noOpen) yield* openBrowser(url);
		return yield* Effect.never;
	}, Effect.scoped)
).pipe(
	Command.withDescription(
		'Serve a local inbox of your runs in the browser: what needs a decision, what is ready, what is in progress, with their findings and actions. Runs until Ctrl-C.'
	)
);
