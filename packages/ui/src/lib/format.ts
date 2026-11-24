/** How the inbox writes times, money and counts. */

/** How long before `now` the ISO time `iso` was, in whole units, e.g. `5m ago`. */
export const relTime = (iso: string, now: number): string => {
	const s = Math.round((now - Date.parse(iso)) / 1000);
	if (s < 60) return `${Math.max(s, 0)}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
};

/** The time between two ISO times, e.g. `4m 10s`. */
export const elapsed = (fromIso: string, toIso: string): string => {
	const s = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
