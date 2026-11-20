import { Duration, Record, Schema, SchemaGetter, SchemaTransformation, Struct } from 'effect';
import { withDefault } from './defaults.ts';
import { Millis, ModelId, NonNegativeInt, PositiveInt, type Step } from './primitives.ts';
import { ReviewerName } from './reviewer.ts';

/** Decode options for config files: unknown keys are errors, so typos do not pass silently. */
export const configParseOptions = { onExcessProperty: 'error' } as const;

const SchemaRef = Schema.optionalKey(
	Schema.String.annotate({ description: 'JSON Schema reference for editor completion' })
);

// --- Locks ---

export const LockResource = Schema.String.check(
	Schema.isPattern(/^[a-z][a-z0-9-]*$/u, { expected: 'a lowercase lock resource name' })
);

export const DEFAULT_LOCK_RESOURCE = 'cpu';

const LockPermits = Schema.Record(LockResource, PositiveInt);

/**
 * Permits per lock resource. `cpu` always exists (2 permits unless overridden),
 * so declaring `{ "db": 1 }` keeps the default `cpu` resource.
 */
export const LockPermitsConfig = LockPermits.pipe(
	Schema.decodeTo(
		LockPermits,
		SchemaTransformation.transform<typeof LockPermits.Type, typeof LockPermits.Type>({
			decode: (permits) => ({ [DEFAULT_LOCK_RESOURCE]: 2, ...permits }),
			encode: (permits) => permits
		})
	),
	withDefault(
		{},
		'Concurrent check permits per lock resource; `cpu` defaults to 2 when not declared'
	)
);

// --- Check ---

export const Check = Schema.Struct({
	name: Schema.NonEmptyString,
	run: Schema.NonEmptyString.annotate({
		description: 'Shell command; `{files}` expands to the changed files'
	}),
	fix: Schema.optionalKey(
		Schema.NonEmptyString.annotate({
			description:
				'Shell command run just before the check on every pass except the baseline, so an LLM fix only sees what it leaves failing; `{files}` expands to the changed files'
		})
	),
	lock: LockResource.pipe(
		withDefault(DEFAULT_LOCK_RESOURCE, 'Lock resource held while the check runs')
	)
});
export interface Check extends Schema.Schema.Type<typeof Check> {}

// --- Models, caps, timeouts ---
// Each group has field schemas without defaults (reused for project overrides)
// and a global struct that fills every field.

// `checks` runs its agent calls through `fixChecks`, which resumes the implementer
// session with the `fix` model; `escalate` opens its PR with the `pr` model.
// `baseline`, `route` and `triage` run no agent: `route` asks Cloudflare Clef.
const modelFields = {
	implement: ModelId,
	fix: ModelId,
	review: ModelId,
	verify: ModelId,
	pr: ModelId
};

export const Models = Schema.Struct(
	Struct.evolve(modelFields, {
		implement: withDefault('opus'),
		fix: withDefault('opus'),
		review: withDefault('sonnet'),
		verify: withDefault('sonnet'),
		pr: withDefault('sonnet')
	})
);
export interface Models extends Schema.Schema.Type<typeof Models> {}

const capFields = {
	checkFixAttempts: NonNegativeInt.annotate({
		description: 'Check-fix attempts per round before escalating (M)'
	}),
	reviewRounds: PositiveInt.annotate({ description: 'Review rounds before escalating (N)' })
};

export const Caps = Schema.Struct(
	Struct.evolve(capFields, {
		checkFixAttempts: withDefault(3),
		reviewRounds: withDefault(10)
	})
);
export interface Caps extends Schema.Schema.Type<typeof Caps> {}

const TIMEOUT_PATTERN = /^\d+(?:\.\d+)?\s+(?:seconds?|minutes?|hours?)$/u;

const formatTimeout = (duration: Duration.Duration): string => {
	const ms = Duration.toMillis(duration);
	const [amount, unit] =
		ms % 3_600_000 === 0
			? [ms / 3_600_000, 'hour']
			: ms % 60_000 === 0
				? [ms / 60_000, 'minute']
				: [ms / 1000, 'second'];
	return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
};

/**
 * A step timeout written as `"<amount> <unit>"` with unit seconds, minutes or hours,
 * e.g. `"20 minutes"`. Decodes to a `Duration` and encodes back to the largest whole unit.
 */
export const Timeout = Schema.String.check(
	Schema.isPattern(TIMEOUT_PATTERN, {
		expected: 'a duration such as "90 seconds", "20 minutes" or "1 hour"'
	})
).pipe(
	Schema.decodeTo(
		Schema.Duration.check(
			Schema.makeFilter((d: Duration.Duration) => Duration.isPositive(d), {
				expected: 'a positive duration'
			})
		),
		new SchemaTransformation.Transformation(
			SchemaTransformation.durationFromString.decode,
			SchemaGetter.transform(formatTimeout)
		)
	)
);

// Every step has a timeout except the deterministic `triage` and `route`, whose Clef call
// has a fixed one (`CLEF_TIMEOUT`), and `post`, `resolve`, `commit` and `push`, which only
// run git and gh. `recheck` is one verifier call, which `verify` limits.
// `prepare` has none: no run reports it, and it stays a step only so that old logs decode.
// `fixChecks` and `verify` limit the agent calls inside `checks` and `review`; `review`
// limits each reviewer call.
const timeoutFields = {
	baseline: Timeout,
	implement: Timeout,
	checks: Timeout,
	fixChecks: Timeout,
	review: Timeout,
	verify: Timeout,
	fix: Timeout,
	escalate: Timeout,
	pr: Timeout
} satisfies Record<
	Exclude<
		Step,
		'triage' | 'route' | 'prepare' | 'post' | 'recheck' | 'resolve' | 'commit' | 'push'
	>,
	typeof Timeout
>;

export const Timeouts = Schema.Struct(
	Struct.evolve(timeoutFields, {
		baseline: withDefault('30 minutes'),
		implement: withDefault('1 hour'),
		checks: withDefault('30 minutes'),
		fixChecks: withDefault('20 minutes'),
		review: withDefault('20 minutes'),
		verify: withDefault('15 minutes'),
		fix: withDefault('30 minutes'),
		escalate: withDefault('10 minutes'),
		pr: withDefault('10 minutes')
	})
);
export interface Timeouts extends Schema.Schema.Type<typeof Timeouts> {}

const MODELS_DESCRIPTION = 'Agent model per step';
const CAPS_DESCRIPTION = 'Loop caps before escalating';
const TIMEOUTS_DESCRIPTION =
	'Timeout per step. baseline and checks apply to each check command and review to each reviewer call; time spent waiting for a lock does not count';

// --- Global config: ~/.ship/config.json ---

export const GlobalConfig = Schema.Struct({
	$schema: SchemaRef,
	locks: LockPermitsConfig,
	models: Models.pipe(withDefault({}, MODELS_DESCRIPTION)),
	caps: Caps.pipe(withDefault({}, CAPS_DESCRIPTION)),
	timeouts: Timeouts.pipe(withDefault({}, TIMEOUTS_DESCRIPTION))
}).annotate({ title: 'ship global config', description: '~/.ship/config.json' });
export interface GlobalConfig extends Schema.Schema.Type<typeof GlobalConfig> {}

// --- Project config: ~/.ship/projects/<project>.json ---

export const ReviewersConfig = Schema.Struct({
	disable: Schema.Array(ReviewerName).pipe(
		withDefault([], 'Built-in reviewers to disable, by name')
	),
	clef: Schema.Boolean.pipe(
		withDefault(
			true,
			'Ask Cloudflare Clef to add reviewers after the deterministic triggers; needs `ship auth cloudflare`'
		)
	)
});
export interface ReviewersConfig extends Schema.Schema.Type<typeof ReviewersConfig> {}

export const PrConfig = Schema.Struct({
	draft: Schema.Boolean.pipe(
		withDefault(true, 'Open the PR as a draft; always a draft when escalated')
	),
	squash: Schema.Boolean.pipe(withDefault(true, 'Squash to one commit before opening the PR'))
});
export interface PrConfig extends Schema.Schema.Type<typeof PrConfig> {}

const uniqueCheckNames = Schema.makeFilter(
	(checks: ReadonlyArray<Check>) =>
		new Set(checks.map((check) => check.name)).size === checks.length,
	{ expected: 'checks with unique names' }
);

export const ProjectConfig = Schema.Struct({
	$schema: SchemaRef,
	checks: Schema.Array(Check).check(uniqueCheckNames).pipe(withDefault([])),
	format: Schema.optionalKey(
		Schema.NonEmptyString.annotate({
			description:
				'Shell command run on the changed files after every agent step, before checks; `{files}` expands to the changed files'
		})
	),
	reviewers: ReviewersConfig.pipe(withDefault({})),
	pr: PrConfig.pipe(withDefault({})),
	models: Schema.optionalKey(
		Schema.Struct(Struct.map(modelFields, Schema.optionalKey)).annotate({
			description: `${MODELS_DESCRIPTION}; overrides the global config`
		})
	),
	caps: Schema.optionalKey(
		Schema.Struct(Struct.map(capFields, Schema.optionalKey)).annotate({
			description: `${CAPS_DESCRIPTION}; overrides the global config`
		})
	),
	timeouts: Schema.optionalKey(
		Schema.Struct(Struct.map(timeoutFields, Schema.optionalKey)).annotate({
			description: `${TIMEOUTS_DESCRIPTION}; overrides the global config`
		})
	)
}).annotate({ title: 'ship project config', description: '~/.ship/projects/<project>.json' });
export interface ProjectConfig extends Schema.Schema.Type<typeof ProjectConfig> {}

// --- Resolved config: what a run uses ---

/**
 * The global config with the project's overrides applied, stored in `RunState` when a
 * run is created so a later config edit does not change a run in flight.
 *
 * Lock permits are left out: they belong to the daemon's semaphores, not to a run.
 * Timeouts are milliseconds, so the value stays the same through the snapshot's JSON.
 */
export const ResolvedConfig = Schema.Struct({
	models: Schema.Struct(modelFields),
	caps: Schema.Struct(capFields),
	timeouts: Schema.Struct(Record.map(timeoutFields, () => Millis)),
	checks: Schema.Array(Check),
	format: Schema.NullOr(Schema.NonEmptyString),
	reviewers: ReviewersConfig,
	pr: PrConfig
});
export interface ResolvedConfig extends Schema.Schema.Type<typeof ResolvedConfig> {}

/** Applies the project's overrides to the global config. */
export const resolveConfig = (global: GlobalConfig, project: ProjectConfig): ResolvedConfig => {
	const timeouts = { ...global.timeouts, ...project.timeouts };
	return {
		models: { ...global.models, ...project.models },
		caps: { ...global.caps, ...project.caps },
		timeouts: Record.map(timeouts, Duration.toMillis),
		checks: project.checks,
		format: project.format ?? null,
		reviewers: project.reviewers,
		pr: project.pr
	};
};

export const decodeGlobalConfig = (input: unknown) =>
	Schema.decodeUnknownEffect(GlobalConfig, configParseOptions)(input);

/** Reports every issue, not only the first, so one edit can fix them all. */
export const decodeProjectConfig = (input: unknown) =>
	Schema.decodeUnknownEffect(ProjectConfig, { ...configParseOptions, errors: 'all' })(input);

/**
 * Checks whose lock resource has no permits in the global config. A config loader
 * reports these, since a check on an undeclared resource could never acquire its lock.
 */
export const checksWithUnknownLock = (
	global: GlobalConfig,
	project: ProjectConfig
): ReadonlyArray<Check> =>
	project.checks.filter((check) => !Object.hasOwn(global.locks, check.lock));
