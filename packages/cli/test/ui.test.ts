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

/** The status of a GET to `port` with `host` as the `Host` header, or with none for `null`. */
const statusFor = (port: number, host: string | null) =>
	Effect.callback<number>((resume) => {
		const req = request(
			{
				host: '127.0.0.1',
				port,
				setHost: host !== null,
				headers: host === null ? {} : { host }
			},
			(response) => {
				response.resume();
				resume(Effect.succeed(response.statusCode ?? 0));
			}
		);
		req.on('error', (error) => resume(Effect.die(error)));
		req.end();
	});

describe('ship ui', () => {
	it.live('serves pages that name its own address, and refuses any other host', () =>
		Effect.gen(function* () {
			const port = portOf(yield* serve(ok, 0));

			expect(yield* statusFor(port, `127.0.0.1:${port}`)).toBe(200);
			expect(yield* statusFor(port, `localhost:${port}`)).toBe(200);
			// A DNS name rebound to 127.0.0.1, the right host on another port, and no host.
			expect(yield* statusFor(port, `evil.example:${port}`)).toBe(403);
			expect(yield* statusFor(port, `127.0.0.1:${port + 1}`)).toBe(403);
			expect(yield* statusFor(port, '127.0.0.1')).toBe(403);
			// Node answers a request without a host itself, before the UI sees it.
			expect(yield* statusFor(port, null)).toBe(400);
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
