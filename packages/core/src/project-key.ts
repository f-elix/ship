import { ProjectKey } from './values.ts';

// `user@host:path`, the scp-like syntax git accepts for ssh remotes.
const SCP_LIKE = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/u;

const trimPath = (path: string): string =>
	path
		.replace(/\/+$/u, '')
		.replace(/\.git$/u, '')
		.replace(/\/+$/u, '');

/**
 * Normalizes a git remote URL so the ssh and https forms of one repository give the same
 * key: `git@github.com:f-elix/ship.git`, `ssh://git@github.com:22/f-elix/ship` and
 * `https://user:token@GitHub.com/f-elix/ship.git/` all become `github.com/f-elix/ship`.
 *
 * Credentials, ports and a trailing `.git` or `/` are dropped and the host is lowercased;
 * the path keeps its case. A local path or `file://` remote becomes its path.
 */
export const normalizeRemoteUrl = (url: string): string => {
	const trimmed = url.trim();
	const scp = SCP_LIKE.exec(trimmed);
	if (scp !== null && !trimmed.includes('://')) {
		const [, host = '', path = ''] = scp;
		return `${host.toLowerCase()}/${trimPath(path.replace(/^\/+/u, ''))}`;
	}
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol === 'file:') return trimPath(decodeURIComponent(parsed.pathname));
		const path = trimPath(decodeURIComponent(parsed.pathname).replace(/^\/+/u, ''));
		return `${parsed.hostname.toLowerCase()}/${path}`;
	} catch {
		return trimPath(trimmed);
	}
};

/**
 * The key a project's config lives under: the normalized `origin` remote URL, or the repo
 * root path when the repo has no `origin`.
 */
export const projectKeyOf = (input: {
	readonly remoteUrl: string | null;
	readonly repoRoot: string;
}): ProjectKey => {
	const key = input.remoteUrl === null ? '' : normalizeRemoteUrl(input.remoteUrl);
	return ProjectKey.make(key === '' ? input.repoRoot : key);
};

/**
 * The key as relative path segments, for files under `~/.ship/projects/`. Empty, `.` and
 * `..` segments are dropped so a key never points outside that directory.
 */
export const projectKeySegments = (key: ProjectKey): ReadonlyArray<string> =>
	key.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
