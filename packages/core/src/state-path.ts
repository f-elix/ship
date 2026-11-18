/**
 * Turns an XState state value into a dotted path: `'review'` stays as is, and
 * `{ checks: 'waiting' }` becomes `checks.waiting`. Parallel regions are joined with `,`.
 */
export const statePath = (value: unknown): string => {
	if (typeof value === 'string') return value;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return '';
	return Object.entries(value)
		.map(([key, child]) => {
			const rest = statePath(child);
			return rest === '' ? key : `${key}.${rest}`;
		})
		.join(',');
};
