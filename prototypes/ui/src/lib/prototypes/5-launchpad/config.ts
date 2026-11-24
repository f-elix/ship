import type { CheckConfig, Project } from '#lib';

export const SCHEMA_BASE = 'https://raw.githubusercontent.com/f-elix/ship/main/packages/cli/schemas';

export const MODEL_STEPS = ['implement', 'fix', 'review', 'reviewTrivial', 'reviewRisky', 'verify', 'pr'] as const;
export type ModelStep = (typeof MODEL_STEPS)[number];

export const TIMEOUT_KEYS = [
	'baseline',
	'implement',
	'checks',
	'fixChecks',
	'review',
	'verify',
	'fix',
	'escalate',
	'pr'
] as const;
export type TimeoutKey = (typeof TIMEOUT_KEYS)[number];

export const MODELS = ['opus', 'sonnet', 'haiku'] as const;

/** What `config.schema.json` defaults to when ~/.ship/config.json says nothing. */
export const SCHEMA_TIMEOUT_DEFAULTS: Record<TimeoutKey, string> = {
	baseline: '30 minutes',
	implement: '1 hour',
	checks: '30 minutes',
	fixChecks: '20 minutes',
	review: '20 minutes',
	verify: '15 minutes',
	fix: '30 minutes',
	escalate: '10 minutes',
	pr: '10 minutes'
};

export const STEP_HINTS: Record<ModelStep, string> = {
	implement: 'Writes the change from the plan',
	fix: 'Fixes must-fix findings and failing checks',
	review: 'Reviewers on a routine change',
	reviewTrivial: 'Reviewers when Clef rates the change trivial',
	reviewRisky: 'Reviewers when Clef rates the change risky',
	verify: 'Traces each finding before triage',
	pr: 'Writes the PR title and body'
};

export interface ProjectConfig {
	checks: CheckConfig[];
	format: string;
	disable: string[];
	clef: boolean;
	pr: { draft: boolean; squash: boolean };
	/** '' inherits the global config. */
	models: Record<ModelStep, string>;
	caps: { checkFixAttempts: number | null; reviewRounds: number | null };
	/** '' inherits the global config. */
	timeouts: Record<TimeoutKey, string>;
}

const emptyRecord = <K extends string>(keys: readonly K[]) =>
	Object.fromEntries(keys.map((k) => [k, ''])) as Record<K, string>;

export const configFromProject = (p: Project): ProjectConfig => ({
	checks: p.checks.map((c) => ({ ...c })),
	format: p.format ?? '',
	disable: [...p.reviewersDisabled],
	clef: p.clef,
	pr: { ...p.pr },
	models: { ...emptyRecord(MODEL_STEPS), ...p.models },
	caps: { ...p.caps },
	timeouts: { ...emptyRecord(TIMEOUT_KEYS), ...(p.name === 'billing-api' ? { implement: '45 minutes' } : {}) }
});

export const blankConfig = (): ProjectConfig => ({
	checks: [],
	format: '',
	disable: [],
	clef: true,
	pr: { draft: true, squash: true },
	models: emptyRecord(MODEL_STEPS),
	caps: { checkFixAttempts: null, reviewRounds: null },
	timeouts: emptyRecord(TIMEOUT_KEYS)
});

export const cloneConfig = (c: ProjectConfig): ProjectConfig => JSON.parse(JSON.stringify(c));

/** The file `ship init --write` saves, with only what differs from the defaults. */
export const toJson = (c: ProjectConfig): Record<string, unknown> => {
	const out: Record<string, unknown> = { $schema: `${SCHEMA_BASE}/project.schema.json` };
	out.checks = c.checks.map((ch) => {
		const row: Record<string, string> = { name: ch.name, run: ch.run };
		if (ch.fix) row.fix = ch.fix;
		row.lock = ch.lock || 'cpu';
		return row;
	});
	if (c.format.trim()) out.format = c.format;
	if (c.disable.length) out.reviewers = { disable: [...c.disable].sort() };
	if (!c.clef) out.clef = false;
	if (!c.pr.draft || !c.pr.squash) out.pr = { draft: c.pr.draft, squash: c.pr.squash };
	const models = Object.fromEntries(Object.entries(c.models).filter(([, v]) => v));
	if (Object.keys(models).length) out.models = models;
	const caps = Object.fromEntries(Object.entries(c.caps).filter(([, v]) => v !== null));
	if (Object.keys(caps).length) out.caps = caps;
	const timeouts = Object.fromEntries(Object.entries(c.timeouts).filter(([, v]) => v.trim()));
	if (Object.keys(timeouts).length) out.timeouts = timeouts;
	return out;
};

const DURATION = /^\d+(?:\.\d+)?\s+(?:seconds?|minutes?|hours?)$/;
const LOCK = /^[a-z][a-z0-9-]*$/;

export interface Issue {
	path: string;
	message: string;
	level: 'error' | 'warning';
}

/** Mirrors what `ship init --write` reports before it saves. */
export const validate = (c: ProjectConfig, lockPermits: Record<string, number>): Issue[] => {
	const issues: Issue[] = [];
	const seen = new Set<string>();
	c.checks.forEach((ch, i) => {
		const at = `checks[${i}]`;
		if (!ch.name.trim()) issues.push({ path: `${at}.name`, message: 'must not be empty', level: 'error' });
		else if (seen.has(ch.name)) issues.push({ path: `${at}.name`, message: `duplicate check name "${ch.name}"`, level: 'error' });
		seen.add(ch.name);
		if (!ch.run.trim()) issues.push({ path: `${at}.run`, message: 'must not be empty', level: 'error' });
		const lock = ch.lock || 'cpu';
		if (!LOCK.test(lock))
			issues.push({ path: `${at}.lock`, message: `"${lock}" must match ^[a-z][a-z0-9-]*$`, level: 'error' });
		else if (!(lock in lockPermits))
			issues.push({
				path: `${at}.lock`,
				message: `no permits for "${lock}" in ~/.ship/config.json; add it under "locks" and restart the daemon`,
				level: 'error'
			});
		if (ch.run.includes('{files}'))
			issues.push({
				path: `${at}.run`,
				message: `${ch.name || 'this check'} uses {files}, so the baseline and ship init skip it`,
				level: 'warning'
			});
	});
	if (c.checks.length === 0) issues.push({ path: 'checks', message: 'no checks: runs will go straight to review', level: 'warning' });
	for (const [k, v] of Object.entries(c.timeouts))
		if (v.trim() && !DURATION.test(v.trim()))
			issues.push({ path: `timeouts.${k}`, message: `"${v}" is not a duration like "20 minutes"`, level: 'error' });
	if (c.caps.reviewRounds !== null && c.caps.reviewRounds < 1)
		issues.push({ path: 'caps.reviewRounds', message: 'must be at least 1', level: 'error' });
	if (c.caps.checkFixAttempts !== null && c.caps.checkFixAttempts < 0)
		issues.push({ path: 'caps.checkFixAttempts', message: 'must be 0 or more', level: 'error' });
	return issues;
};

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Pretty JSON with token spans for the preview panes. */
export const highlight = (value: unknown): string =>
	escape(JSON.stringify(value, null, 2)).replace(
		/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g,
		(_m, str: string | undefined, colon: string | undefined, lit: string | undefined, num: string | undefined) => {
			if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
			if (lit) return `<span class="b">${lit}</span>`;
			return `<span class="n">${num}</span>`;
		}
	);

/** `~/.ship/projects/github.com/acme/storefront.json` */
export const configPath = (key: string) => `~/.ship/projects/${key}.json`;
