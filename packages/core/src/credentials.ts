import { Effect, FileSystem, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { shipPaths } from './ship-paths.ts';

/** A Cloudflare account and an API token with the Workers AI permission. */
export const CloudflareCredentials = Schema.Struct({
	accountId: Schema.NonEmptyString,
	apiToken: Schema.NonEmptyString
});
export interface CloudflareCredentials extends Schema.Schema.Type<typeof CloudflareCredentials> {}

/**
 * `~/.ship/credentials.json`: secrets ship calls other services with. It is the only
 * source for them; `ship auth cloudflare` writes it, and deleting it removes them.
 */
export const Credentials = Schema.Struct({
	cloudflare: Schema.optionalKey(CloudflareCredentials)
});
export interface Credentials extends Schema.Schema.Type<typeof Credentials> {}

/**
 * The credentials file could not be read, decoded or written. `cause` is the file system or
 * decoding error.
 */
export class CredentialsFileError extends Schema.TaggedError<CredentialsFileError>()(
	'CredentialsFileError',
	{ path: Schema.String, detail: Schema.String, cause: Schema.Defect() }
) {
	override get message(): string {
		return `Cannot use the credentials file ${this.path}: ${this.detail}`;
	}
}

/** Where the credentials of ship's `home` are saved. */
export const credentialsPath = (home: string): string => shipPaths(home).credentials;

const fileError = (path: string) => (error: PlatformError | Schema.SchemaError) =>
	new CredentialsFileError({ path, detail: error.message, cause: error });

const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(Credentials));
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(Credentials));

/** The saved credentials; a missing file has none. */
export const readCredentials = Effect.fn('readCredentials')(function* (home: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = credentialsPath(home);
	const fail = fileError(path);
	if (!(yield* fs.exists(path).pipe(Effect.mapError(fail)))) return {} satisfies Credentials;
	const text = yield* fs.readFileString(path).pipe(Effect.mapError(fail));
	return yield* decodeCredentials(text).pipe(Effect.mapError(fail));
});

/**
 * Replaces the credentials file with `credentials`, readable by its owner only (mode
 * 0600). It writes a temp file with that mode and renames it into place, so the file is
 * never partly written nor briefly readable by others.
 */
export const writeCredentials = Effect.fn('writeCredentials')(function* (
	home: string,
	credentials: Credentials
) {
	const fs = yield* FileSystem.FileSystem;
	const path = credentialsPath(home);
	const temp = `${path}.${process.pid}.tmp`;
	const fail = fileError(path);
	const text = yield* encodeCredentials(credentials).pipe(Effect.orDie);
	yield* fs.makeDirectory(home, { recursive: true }).pipe(Effect.mapError(fail));
	yield* fs.remove(temp, { force: true }).pipe(Effect.mapError(fail));
	yield* fs.writeFileString(temp, `${text}\n`, { mode: 0o600 }).pipe(Effect.mapError(fail));
	yield* fs.rename(temp, path).pipe(
		Effect.mapError(fail),
		Effect.onError(() => Effect.ignore(fs.remove(temp, { force: true })))
	);
});
