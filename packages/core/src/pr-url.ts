/** Pull request URLs, parsed without `gh`. */
import { normalizeRemoteUrl } from './project-key.ts';

/** Matches a pull request URL: host, owner, repository name, then number. */
export const PR_URL = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/u;

/** The parts of a pull request URL, or `null` when `url` is not one. */
export const parsePrUrl = (
	url: string
): {
	readonly host: string;
	readonly owner: string;
	readonly name: string;
	readonly number: number;
} | null => {
	const match = PR_URL.exec(url.trim());
	if (match === null) return null;
	const [, host = '', owner = '', name = '', number = ''] = match;
	return { host: host.toLowerCase(), owner, name, number: Number(number) };
};

/**
 * The repository of a pull request URL, normalized like a remote URL so it compares with
 * a project key: `https://github.com/f-elix/ship/pull/3` gives `github.com/f-elix/ship`.
 * `null` when `url` is not a pull request URL.
 */
export const prRepoKey = (url: string): string | null => {
	const parts = parsePrUrl(url);
	return parts === null
		? null
		: normalizeRemoteUrl(`https://${parts.host}/${parts.owner}/${parts.name}`);
};
