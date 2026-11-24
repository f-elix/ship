import type { Run, RunStatus, Severity } from '#lib';

const STATE_WORDS: Record<string, string> = {
	baseline: 'baseline',
	implement: 'implementing',
	checks: 'checks',
	review: 'in review',
	triage: 'triage',
	fix: 'fixing',
	pr: 'opening PR',
	recheck: 'rechecking'
};

export const statusWord = (run: Run): string => {
	if (run.status === 'running') return STATE_WORDS[run.state.split('.')[0]] ?? 'running';
	return run.status;
};

export const tone = (s: RunStatus): 'green' | 'red' | 'amber' | 'blue' | 'muted' => {
	switch (s) {
		case 'running':
			return 'blue';
		case 'done':
			return 'green';
		case 'failed':
			return 'red';
		case 'escalated':
		case 'waiting':
		case 'interrupted':
			return 'amber';
		case 'cancelled':
			return 'muted';
	}
};

export const severityTone: Record<Severity, 'red' | 'amber' | 'muted'> = {
	'must-fix': 'red',
	tradeoff: 'amber',
	nit: 'muted'
};

/** The verifier's reason starts with how it checked: `traced`, `structural` or `code reading`. */
export const verdictMethod = (verdict: string): { method: string; rest: string } => {
	const m = verdict.match(/^(traced|structural|code reading|disproved)[.:]?\s*/);
	if (!m) return { method: 'verified', rest: verdict };
	return { method: m[1], rest: verdict.slice(m[0].length) };
};
