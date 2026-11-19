import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
	ClefError,
	credentialsPath,
	readCredentials,
	saveCloudflareCredentials,
	writeCredentials
} from '../src/credentials.ts';
import { ClefFake } from '../src/testing.ts';
import { tempDir } from './temp-repo.ts';

const cloudflare = { accountId: 'acct-1', apiToken: 'secret-token' };

describe('credentials file', () => {
	it.effect('reads a missing file as no credentials', () =>
		Effect.gen(function* () {
			const home = yield* tempDir;
			expect(yield* readCredentials(`${home}/nowhere`)).toEqual({});
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);

	it.effect('writes the file readable by its owner only, and reads it back', () =>
		Effect.gen(function* () {
			const home = `${yield* tempDir}/ship`;
			yield* writeCredentials(home, { cloudflare });
			const path = credentialsPath(home);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ cloudflare });
			expect(yield* readCredentials(home)).toEqual({ cloudflare });

			// Replacing it keeps the mode, even over a file others could read.
			writeFileSync(path, '{}', { mode: 0o644 });
			yield* writeCredentials(home, { cloudflare: { ...cloudflare, apiToken: 'new' } });
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect((yield* readCredentials(home)).cloudflare?.apiToken).toBe('new');
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);

	it.effect('fails on a file that is not valid credentials', () =>
		Effect.gen(function* () {
			const home = yield* tempDir;
			mkdirSync(home, { recursive: true });
			writeFileSync(credentialsPath(home), '{"cloudflare":{"accountId":""}}');
			const error = yield* Effect.flip(readCredentials(home));
			expect(error).toMatchObject({
				_tag: 'CredentialsFileError',
				path: credentialsPath(home),
				cause: { _tag: 'SchemaError' }
			});
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);
});

describe('saveCloudflareCredentials', () => {
	const services = Layer.mergeAll(ClefFake.layer, NodeServices.layer);

	it.effect('saves nothing when Clef refuses the credentials', () =>
		Effect.gen(function* () {
			const home = yield* tempDir;
			const refused = new ClefError({ status: 401, detail: 'Authentication error' });
			yield* (yield* ClefFake).fail(refused);
			const error = yield* Effect.flip(saveCloudflareCredentials(home, cloudflare));
			expect(error).toBe(refused);
			expect(existsSync(credentialsPath(home))).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(services))
	);

	it.effect('saves verified credentials with mode 0600, keeping the other ones', () =>
		Effect.gen(function* () {
			const home = yield* tempDir;
			const path = credentialsPath(home);
			writeFileSync(
				path,
				JSON.stringify({ cloudflare: { accountId: 'old', apiToken: 'old' } })
			);
			yield* saveCloudflareCredentials(home, cloudflare);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(yield* readCredentials(home)).toEqual({ cloudflare });
		}).pipe(Effect.scoped, Effect.provide(services))
	);
});
