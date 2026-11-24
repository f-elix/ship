import { describe, expect, it } from '@effect/vitest';
import { tempDir } from '@ship/daemon/testing';
import { Effect } from 'effect';
import { existsSync } from 'node:fs';
import { createServer, request, type RequestListener, type Server } from 'node:http';
import { join } from 'node:path';
import { serve } from '../src/ui.ts';
import { cli } from './support.ts';

const ok: RequestListener = (_request, response) => response.writeHead(200).end('inbox');

const portOf = (server: Server) => {
	const address = server.address();
	if (typeof address !== 'object' || address === null) throw new Error('not listening');
	return address.port;
};

interface Answer {
	readonly status: number;
	readonly location: string | undefined;
	readonly setCookie: ReadonlyArray<string>;
}

/**
 * A GET of `path` on `port`, with `headers`. `host` is the `Host` header, `null` for none,
 * and `127.0.0.1:<port>` by default.
 */
const get = (
	port: number,
	path: string,
	{ host = `127.0.0.1:${port}`, cookie }: { host?: string | null; cookie?: string } = {}
) =>
	Effect.callback<Answer>((resume) => {
		const req = request(
			{
				host: '127.0.0.1',
				port,
				path,
				setHost: host !== null,
				headers: {
					...(host === null ? {} : { host }),
					...(cookie === undefined ? {} : { cookie })
				}
			},
			(response) => {
				response.resume();
				resume(
					Effect.succeed({
						status: response.statusCode ?? 0,
						location: response.headers.location,
						setCookie: response.headers['set-cookie'] ?? []
					})
				);
			}
		);
		req.on('error', (error) => resume(Effect.die(error)));
		req.end();
	});

/** The launch token in a URL that `serve` returned. */
const tokenOf = (url: string) => new URL(url).searchParams.get('token') ?? '';

describe('ship ui', () => {
	it.live('opens through the launch URL, which trades its token for a cookie', () =>
		Effect.gen(function* () {
			const { url, port } = yield* serve(ok, 0);
			const token = tokenOf(url);
			expect(url).toBe(`http://127.0.0.1:${port}/?token=${token}`);
			expect(token).toMatch(/^[\w-]{43}$/);

			const opened = yield* get(port, `/?item=pr%3A7&token=${token}`);

			expect(opened).toEqual({
				status: 303,
				location: `http://127.0.0.1:${port}/?item=pr%3A7`,
				setCookie: [`ship-ui-${port}=${token}; HttpOnly; SameSite=Strict; Path=/`]
			});
			const cookie = `other=1; ship-ui-${port}=${token}`;
			expect((yield* get(port, '/?item=pr%3A7', { cookie })).status).toBe(200);
			// The remote functions' endpoints are behind the same cookie.
			expect((yield* get(port, '/_app/remote/x', { cookie })).status).toBe(200);
		}).pipe(Effect.scoped)
	);

	it.live('refuses a request with neither the token nor its cookie', () =>
		Effect.gen(function* () {
			const { url, port } = yield* serve(ok, 0);
			const token = tokenOf(url);
			const other = tokenOf((yield* serve(ok, 0)).url);

			expect(yield* get(port, '/')).toMatchObject({ status: 403, setCookie: [] });
			expect((yield* get(port, '/_app/remote/x')).status).toBe(403);
			// Another launch's token, a truncated one, and the right one in a cookie of another port.
			expect((yield* get(port, `/?token=${other}`)).status).toBe(403);
			expect((yield* get(port, `/?token=${token.slice(1)}`)).status).toBe(403);
			expect((yield* get(port, '/', { cookie: `ship-ui-${port}=${other}` })).status).toBe(
				403
			);
			expect((yield* get(port, '/', { cookie: `ship-ui-${port + 1}=${token}` })).status).toBe(
				403
			);
		}).pipe(Effect.scoped)
	);

	it.live('sends localhost to 127.0.0.1, the origin its remote calls are accepted from', () =>
		Effect.gen(function* () {
			const { url, port } = yield* serve(ok, 0);
			const path = `/?item=x&token=${tokenOf(url)}`;

			expect(yield* get(port, path, { host: `localhost:${port}` })).toEqual({
				status: 307,
				location: `http://127.0.0.1:${port}${path}`,
				setCookie: []
			});
		}).pipe(Effect.scoped)
	);

	it.live('refuses any other host, and never redirects off 127.0.0.1', () =>
		Effect.gen(function* () {
			const { url, port } = yield* serve(ok, 0);
			const token = tokenOf(url);

			// A DNS name rebound to 127.0.0.1, the right host on another port, and no port.
			for (const host of [`evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1']) {
				expect((yield* get(port, `/?token=${token}`, { host })).status, host).toBe(403);
			}
			// Node answers a request without a host itself, before the UI sees it.
			expect((yield* get(port, '/', { host: null })).status).toBe(400);
			// A request target that names another host still redirects to 127.0.0.1.
			for (const path of [
				`//evil.example/?token=${token}`,
				`http://evil.example/?token=${token}`
			]) {
				expect((yield* get(port, path)).location, path).toBe(`http://127.0.0.1:${port}/`);
			}
		}).pipe(Effect.scoped)
	);

	it.live('says to pass another port when the port is in use', () =>
		Effect.gen(function* () {
			const taken = yield* Effect.acquireRelease(
				Effect.callback<Server>((resume) => {
					const server = createServer();
					server.listen(0, '127.0.0.1', () => resume(Effect.succeed(server)));
				}),
				(server) =>
					Effect.callback<void>((resume) => {
						server.close(() => resume(Effect.void));
					})
			);
			const port = portOf(taken);

			const error = yield* Effect.flip(serve(ok, port));

			expect(error.message).toBe(`port ${port} is in use; pass another with --port`);
		}).pipe(Effect.scoped)
	);

	it.live('fails without a daemon when the UI is not built', () =>
		Effect.gen(function* () {
			const home = join(yield* tempDir, 'home');

			// Run from the sources, where no build sits next to the command.
			const result = yield* cli(['ui', '--no-open'], { home });

			expect(result.code).toBe(1);
			expect(result.stderr).toContain('the UI is not built');
			expect(existsSync(home)).toBe(false);
		}).pipe(Effect.scoped)
	);

	it.live('rejects a port outside 1–65535, or one that is not a number', () =>
		Effect.gen(function* () {
			const home = join(yield* tempDir, 'home');
			for (const [port, expected] of [
				['0', 'Expected a value between 1 and 65535'],
				['65536', 'Expected a value between 1 and 65535'],
				['any', 'Expected a string representing a finite number']
			] as const) {
				const result = yield* cli(['ui', '--port', port], { home });
				expect(result.code, port).toBe(1);
				expect(result.stderr, port).toContain(`Invalid value for flag --port: "${port}"`);
				expect(result.stderr, port).toContain(expected);
			}
			// Refused before the daemon starts.
			expect(existsSync(home)).toBe(false);
		}).pipe(Effect.scoped)
	);
});
