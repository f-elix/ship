import { Schema } from 'effect';

export const RunId = Schema.NonEmptyString.pipe(Schema.brand('RunId'));
export type RunId = typeof RunId.Type;

/** Normalized git remote URL, or the repo root path when there is no remote. */
export const ProjectKey = Schema.NonEmptyString.pipe(Schema.brand('ProjectKey'));
export type ProjectKey = typeof ProjectKey.Type;

/** A full SHA-1 or SHA-256 commit hash in lowercase hex. */
export const GitSha = Schema.String.check(
	Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, { expected: 'a full git commit sha' })
).pipe(Schema.brand('GitSha'));
export type GitSha = typeof GitSha.Type;

export const AbsolutePath = Schema.String.check(
	Schema.isPattern(/^\//u, { expected: 'an absolute path' })
);

/**
 * A process environment (`PATH`, etc.). Checks and agents run with the caller's, not the
 * daemon's.
 */
export const Env = Schema.Record(Schema.String, Schema.String);
export type Env = typeof Env.Type;

export const Url = Schema.String.check(
	Schema.isPattern(/^https?:\/\/\S+$/u, { expected: 'an http(s) URL' })
);

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const Millis = NonNegativeInt.annotate({ description: 'A duration in milliseconds' });

export const CostUsd = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const Timestamp = Schema.DateTimeUtcFromString;

/** A model id or alias passed to the Agent SDK, e.g. `opus` or `claude-sonnet-4-5`. */
export const ModelId = Schema.NonEmptyString;

export const SessionId = Schema.NonEmptyString.pipe(Schema.brand('SessionId'));
export type SessionId = typeof SessionId.Type;

/** Pipeline steps, named after the machine states that run them. */
export const Step = Schema.Literals([
	'baseline',
	'implement',
	'checks',
	'fixChecks',
	'route',
	'review',
	'verify',
	'triage',
	'fix',
	'escalate',
	'pr',
	'prepare',
	'post'
]);
export type Step = typeof Step.Type;
