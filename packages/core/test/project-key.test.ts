import { describe, expect, it } from '@effect/vitest';
import {
	normalizeRemoteUrl,
	ProjectKey,
	projectKeyOf,
	projectKeySegments,
	RunId,
	shipPaths
} from '../src/index.ts';

describe('normalizeRemoteUrl', () => {
	it.each([
		'git@github.com:f-elix/ship.git',
		'git@github.com:f-elix/ship',
		'github.com:f-elix/ship.git/',
		'ssh://git@github.com/f-elix/ship.git',
		'ssh://git@github.com:22/f-elix/ship',
		'https://github.com/f-elix/ship.git',
		'https://github.com/f-elix/ship',
		'https://github.com/f-elix/ship/',
		'https://user:token@GitHub.com/f-elix/ship.git',
		'http://github.com:8080/f-elix/ship.git',
		'git://github.com/f-elix/ship.git',
		'  https://github.com/f-elix/ship.git\n'
	])('normalizes %s', (url) => {
		expect(normalizeRemoteUrl(url)).toBe('github.com/f-elix/ship');
	});

	it('keeps nested paths and path case', () => {
		expect(normalizeRemoteUrl('git@gitlab.com:Group/Sub/Repo.git')).toBe(
			'gitlab.com/Group/Sub/Repo'
		);
	});

	it('turns local remotes into their path', () => {
		expect(normalizeRemoteUrl('/srv/git/ship.git')).toBe('/srv/git/ship');
		expect(normalizeRemoteUrl('file:///srv/git/ship.git/')).toBe('/srv/git/ship');
	});
});

describe('projectKeyOf', () => {
	it('uses the remote, else the repo root', () => {
		expect(
			projectKeyOf({ remoteUrl: 'git@github.com:f-elix/ship.git', repoRoot: '/code/ship' })
		).toBe('github.com/f-elix/ship');
		expect(projectKeyOf({ remoteUrl: null, repoRoot: '/code/ship' })).toBe('/code/ship');
		expect(projectKeyOf({ remoteUrl: '', repoRoot: '/code/ship' })).toBe('/code/ship');
	});
});

describe('shipPaths', () => {
	const paths = shipPaths('/home/me/.ship');

	it('nests project files by key segments', () => {
		const key = ProjectKey.make('github.com/f-elix/ship');
		expect(paths.projectConfig(key)).toBe(
			'/home/me/.ship/projects/github.com/f-elix/ship.json'
		);
		expect(paths.projectReviewers(key)).toBe(
			'/home/me/.ship/projects/github.com/f-elix/ship/reviewers'
		);
		expect(paths.projectConfig(ProjectKey.make('/code/ship'))).toBe(
			'/home/me/.ship/projects/code/ship.json'
		);
	});

	it('never leaves the projects directory', () => {
		expect(projectKeySegments(ProjectKey.make('host/../../etc/./passwd'))).toEqual([
			'host',
			'etc',
			'passwd'
		]);
	});

	it('places run files under runs/<id>', () => {
		const runId = RunId.make('20261117-153012-a1b2c3');
		expect(paths.transcripts(runId)).toBe(
			'/home/me/.ship/runs/20261117-153012-a1b2c3/transcripts'
		);
		expect(paths.globalConfig).toBe('/home/me/.ship/config.json');
	});
});
