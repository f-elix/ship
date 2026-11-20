import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import {
	FindingId,
	Gh,
	parsePrUrl,
	Pr,
	prRepoKey,
	renderPrBody,
	type OpenPrInput,
	type VerifiedFinding
} from '../src/index.ts';
import { AgentFake, fakeSha, GhFake } from '../src/testing.ts';
import { tempDir } from './temp-repo.ts';

const PrTest = Pr.layer.pipe(Layer.provideMerge(Layer.mergeAll(AgentFake.layer, GhFake.layer)));

const finding = (
	n: number,
	severity: VerifiedFinding['severity'],
	claim: string
): VerifiedFinding => ({
	id: FindingId.make(`r1-${n}`),
	round: 1,
	reviewer: 'security',
	alsoReportedBy: n === 1 ? ['standards'] : [],
	file: 'src/a.ts',
	line: n,
	severity,
	claim,
	evidence: 'const a = 1;'
});

const unresolved = {
	mustFix: [finding(1, 'must-fix', 'Injection.')],
	tradeoffs: [finding(2, 'tradeoff', 'Extra query.')],
	nits: [finding(3, 'nit', 'Naming.')]
};

const input: OpenPrInput = {
	repo: { cwd: '/repo', env: { PATH: '/bin' } },
	branch: 'feature',
	base: 'main',
	diff: '+const a = 1;',
	commits: [{ sha: fakeSha(1), subject: 'Add a' }],
	specPath: '/plans/feature/spec.md',
	planPath: '/plans/feature/implementation-plan.md',
	checks: [
		{
			baseline: false,
			round: 1,
			attempt: 0,
			results: [{ name: 'test', exitCode: 0, durationMs: 5 }]
		}
	],
	unresolved: { ...unresolved, mustFix: [] },
	escalation: null,
	draft: false,
	model: 'haiku',
	timeoutMs: 60_000
};

const scriptBody = Effect.gen(function* () {
	yield* (yield* AgentFake).script(
		{ step: 'pr' },
		{ output: { title: 'Add a', body: '## Summary\n\nAdds a.' }, costUsd: 0.02 }
	);
	yield* (yield* AgentFake).script(
		{ step: 'escalate' },
		{ output: { title: 'Add a', body: '## Summary\n\nAdds a.' }, costUsd: 0.02 }
	);
});

describe('Pr.open', () => {
	it.effect('writes the body with an agent and opens a ready PR', () =>
		Effect.gen(function* () {
			yield* scriptBody;
			const result = yield* (yield* Pr).open(input);
			expect(result).toEqual({
				url: 'https://github.com/f-elix/example/pull/1',
				draft: false,
				created: true,
				cost: { step: 'pr', model: 'haiku', sessionId: 'fake-session-1', costUsd: 0.02 }
			});
			const [pr] = yield* (yield* GhFake).prs;
			expect(pr).toMatchObject({
				base: 'main',
				head: 'feature',
				title: 'Add a',
				draft: false
			});
			expect(pr?.body).toContain('## Summary\n\nAdds a.');
			expect(pr?.body).toContain('## Tradeoffs');
			expect(pr?.body).not.toContain('Unresolved must-fix');
			expect(pr?.body).not.toContain('Naming.');

			const [call] = yield* (yield* AgentFake).calls;
			expect(call).toMatchObject({ step: 'pr', model: 'haiku', access: 'read-only' });
			expect(call?.prompt).toContain('## Merge Danger');
			expect(call?.prompt).toContain('- test: passed');
			expect(call?.prompt).toContain('+const a = 1;');
		}).pipe(Effect.provide(PrTest))
	);

	it.effect('honours pr.draft', () =>
		Effect.gen(function* () {
			yield* scriptBody;
			const result = yield* (yield* Pr).open({ ...input, draft: true });
			expect(result.draft).toBe(true);
			expect((yield* (yield* GhFake).prs)[0]?.draft).toBe(true);
		}).pipe(Effect.provide(PrTest))
	);

	it.effect(
		'always opens a draft listing unresolved must-fix findings and nits when escalated',
		() =>
			Effect.gen(function* () {
				yield* scriptBody;
				const result = yield* (yield* Pr).open({
					...input,
					unresolved,
					escalation: 'stall'
				});
				expect(result).toMatchObject({
					draft: true,
					created: true,
					cost: { step: 'escalate' }
				});
				const [pr] = yield* (yield* GhFake).prs;
				expect(pr?.draft).toBe(true);
				expect(pr?.body).toMatch(/^> \[!WARNING\]\n> ship escalated this run/u);
				expect(pr?.body).toContain(
					'## Unresolved must-fix findings\n\n- `src/a.ts:1` (security, standards): Injection.'
				);
				expect(pr?.body).toContain('## Unresolved nits');
				expect(pr?.body).toContain('Naming.');
			}).pipe(Effect.provide(PrTest))
	);

	it.effect(
		'updates the open PR instead of opening a second one, turning it back into a draft when escalated',
		() =>
			Effect.gen(function* () {
				yield* scriptBody;
				const gh = yield* GhFake;
				const existing = yield* gh.addPr({
					base: 'main',
					head: 'feature',
					title: 'Old',
					body: 'Old body',
					draft: false
				});
				const result = yield* (yield* Pr).open({
					...input,
					unresolved,
					escalation: 'review-cap'
				});
				expect(result).toMatchObject({ url: existing.url, draft: true, created: false });
				const prs = yield* gh.prs;
				expect(prs).toHaveLength(1);
				expect(prs[0]).toMatchObject({ title: 'Add a', draft: true });
				expect(prs[0]?.body).toContain('Unresolved must-fix findings');
			}).pipe(Effect.provide(PrTest))
	);

	it.effect('fails with the agent call’s cost when gh fails after the body is written', () =>
		Effect.gen(function* () {
			yield* scriptBody;
			yield* (yield* GhFake).fail('createPr', 'no permission');
			const error = yield* Effect.flip((yield* Pr).open(input));
			// The body was already paid for, so the error carries its cost.
			expect(error).toMatchObject({
				_tag: 'PrPublishError',
				gh: { _tag: 'GhError', stderr: 'no permission' },
				cost: { step: 'pr', model: 'haiku', costUsd: 0.02 }
			});
		}).pipe(Effect.provide(PrTest))
	);

	it.effect('fails before paying for the agent when gh cannot list PRs', () =>
		Effect.gen(function* () {
			yield* scriptBody;
			yield* (yield* GhFake).fail('findPr', 'not logged in');
			const error = yield* Effect.flip((yield* Pr).open(input));
			expect(error).toMatchObject({ _tag: 'GhError', stderr: 'not logged in' });
			expect(yield* (yield* AgentFake).calls).toEqual([]);
		}).pipe(Effect.provide(PrTest))
	);
});

describe('renderPrBody', () => {
	it('indents multi-line evidence under its item and leaves out empty sections', () => {
		const body = renderPrBody('Body.', {
			escalation: null,
			unresolved: {
				mustFix: [],
				tradeoffs: [
					{ ...finding(2, 'tradeoff', 'Extra query.'), evidence: 'line one\nline two' }
				],
				nits: []
			}
		});
		expect(body).toBe(
			'Body.\n\n## Tradeoffs\n\n- `src/a.ts:2` (security): Extra query.\n  line one\n  line two\n'
		);
	});
});

describe('parsePrUrl and prRepoKey', () => {
	it('reads a PR URL, with or without a trailing path, query or fragment', () => {
		const parts = { host: 'github.com', owner: 'f-elix', name: 'ship', number: 3 };
		for (const url of [
			'https://github.com/f-elix/ship/pull/3',
			'https://GitHub.com/f-elix/ship/pull/3/files',
			'https://github.com/f-elix/ship/pull/3#discussion_r1',
			'https://github.com/f-elix/ship/pull/3?w=1',
			' https://github.com/f-elix/ship/pull/3\n'
		]) {
			expect(parsePrUrl(url), url).toEqual(parts);
			expect(prRepoKey(url), url).toBe('github.com/f-elix/ship');
		}
	});

	it('keys a PR of another repository or host apart from the project', () => {
		expect(prRepoKey('https://github.com/someone/ship/pull/3')).toBe('github.com/someone/ship');
		expect(prRepoKey('https://ghe.example.com/f-elix/ship/pull/3')).toBe(
			'ghe.example.com/f-elix/ship'
		);
	});

	it('refuses URLs that are not a pull request', () => {
		for (const url of [
			'https://github.com/f-elix/ship/issues/3',
			'https://github.com/f-elix/ship/pull/',
			'https://github.com/f-elix/ship',
			'https://github.com/f-elix/ship/pull/3x',
			'3',
			'git@github.com:f-elix/ship.git'
		]) {
			expect(parsePrUrl(url), url).toBeNull();
			expect(prRepoKey(url), url).toBeNull();
		}
	});
});

describe('Gh', () => {
	const HEAD_SHA = fakeSha(0xc);

	/** A stub `gh` that logs its argv and stdin, and answers like the real one. */
	const stubGh = Effect.gen(function* () {
		const dir = yield* tempDir;
		writeFileSync(
			`${dir}/gh`,
			`#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/argv.log"
case "$1 $2" in
  "pr list") echo '[{"url":"https://github.com/o/r/pull/6","number":6,"isDraft":false,"isCrossRepository":true},{"url":"https://github.com/o/r/pull/7","number":7,"isDraft":true,"isCrossRepository":false}]' ;;
  "pr create") cat > "${dir}/stdin.log"; echo "Creating pull request"; echo "https://github.com/o/r/pull/8" ;;
  "pr edit") cat > "${dir}/stdin.log" ;;
  "pr ready") ;;
  "pr view") echo '{"baseRefName":"main","body":"Adds a.","headRefOid":"${HEAD_SHA}","headRefName":"feature","headRepository":{"id":"R_1","name":"r"},"headRepositoryOwner":{"id":"U_1","login":"fork-owner"},"isCrossRepository":true,"maintainerCanModify":true,"number":7,"title":"Add a","url":"https://github.com/o/r/pull/7"}' ;;
  "api --hostname") cat > "${dir}/stdin.log"; echo '{"id":80,"node_id":"PRR_kwDOAbc","user":{"login":"octocat","id":1},"body":"Body.","state":"CHANGES_REQUESTED","html_url":"https://github.com/o/r/pull/7#pullrequestreview-80","pull_request_url":"https://api.github.com/repos/o/r/pulls/7","author_association":"OWNER","_links":{"html":{"href":"https://github.com/o/r/pull/7#pullrequestreview-80"}},"submitted_at":"2026-11-19T12:00:00Z","commit_id":"${HEAD_SHA}"}' ;;
  *) echo "unknown" >&2; exit 1 ;;
esac
`
		);
		chmodSync(`${dir}/gh`, 0o755);
		const repo = { cwd: dir, env: { PATH: `${dir}:/usr/bin:/bin` } };
		const read = (name: string) => readFileSync(`${dir}/${name}`, 'utf8');
		return { repo, read };
	});

	const GhLive = Gh.layer.pipe(Layer.provide(NodeServices.layer));

	it.effect('runs gh with the body on stdin, ignoring fork PRs from a same-named branch', () =>
		Effect.gen(function* () {
			const { repo, read } = yield* stubGh;
			const gh = yield* Gh;
			expect(yield* gh.findPr(repo, 'feature')).toEqual({
				url: 'https://github.com/o/r/pull/7',
				number: 7,
				isDraft: true
			});
			const url = yield* gh.createPr(repo, {
				base: 'main',
				head: 'feature',
				title: 'Add a',
				body: 'The `body`\n$(not run)',
				draft: true
			});
			expect(url).toBe('https://github.com/o/r/pull/8');
			expect(read('stdin.log')).toBe('The `body`\n$(not run)');
			yield* gh.editPr(repo, { url, title: 'Add b', body: 'New body' });
			expect(read('stdin.log')).toBe('New body');
			yield* gh.markDraft(repo, url);
			expect(read('argv.log').trim().split('\n')).toEqual([
				'pr list --head feature --state open --json url,number,isDraft,isCrossRepository',
				'pr create --base main --head feature --title Add a --body-file - --draft',
				'pr edit https://github.com/o/r/pull/8 --title Add b --body-file -',
				'pr ready https://github.com/o/r/pull/8 --undo'
			]);
		}).pipe(Effect.scoped, Effect.provide(GhLive))
	);

	it.effect('views a PR by number or URL, decoding what gh pr view prints', () =>
		Effect.gen(function* () {
			const { repo, read } = yield* stubGh;
			const gh = yield* Gh;
			const expected = {
				number: 7,
				url: 'https://github.com/o/r/pull/7',
				title: 'Add a',
				body: 'Adds a.',
				baseRef: 'main',
				headSha: HEAD_SHA,
				headRef: 'feature',
				headRepository: { owner: 'fork-owner', name: 'r' },
				isCrossRepository: true,
				maintainerCanModify: true
			};
			expect(yield* gh.viewPr(repo, '7')).toEqual(expected);
			expect(yield* gh.viewPr(repo, 'https://github.com/o/r/pull/7')).toEqual(expected);
			const fields =
				'number,url,title,body,baseRefName,headRefOid,headRefName,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify';
			expect(read('argv.log').trim().split('\n')).toEqual([
				`pr view 7 --json ${fields}`,
				`pr view https://github.com/o/r/pull/7 --json ${fields}`
			]);
		}).pipe(Effect.scoped, Effect.provide(GhLive))
	);

	it.effect('posts a review through the API of the PR host, comments on the new side', () =>
		Effect.gen(function* () {
			const { repo, read } = yield* stubGh;
			const gh = yield* Gh;
			const url = yield* gh.submitReview(repo, {
				prUrl: 'https://github.example.com/o/r/pull/7',
				commitId: HEAD_SHA,
				event: 'REQUEST_CHANGES',
				body: 'Body.',
				comments: [{ path: 'src/a.ts', line: 3, body: 'Broken.' }]
			});
			expect(url).toBe('https://github.com/o/r/pull/7#pullrequestreview-80');
			expect(read('argv.log').trim()).toBe(
				'api --hostname github.example.com --method POST repos/o/r/pulls/7/reviews --input -'
			);
			expect(JSON.parse(read('stdin.log'))).toEqual({
				commit_id: HEAD_SHA,
				event: 'REQUEST_CHANGES',
				body: 'Body.',
				comments: [{ path: 'src/a.ts', line: 3, body: 'Broken.', side: 'RIGHT' }]
			});
		}).pipe(Effect.scoped, Effect.provide(GhLive))
	);

	/**
	 * A stub `gh` that logs its argv and prints `output` as `gh api --paginate --jq` would:
	 * one JSON value per line, every page's lines one after the other.
	 */
	const listingGh = (output: string) =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			writeFileSync(`${dir}/reviews.out`, output);
			writeFileSync(
				`${dir}/gh`,
				`#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/argv.log"\ncat "${dir}/reviews.out"\n`
			);
			chmodSync(`${dir}/gh`, 0o755);
			const repo = { cwd: dir, env: { PATH: `${dir}:/usr/bin:/bin` } };
			return { repo, argv: () => readFileSync(`${dir}/argv.log`, 'utf8').trim() };
		});

	/** One thread as `reviewThreads`' `--jq` prints it. */
	const thread = (
		id: string,
		state: { readonly isResolved?: boolean; readonly isOutdated?: boolean } = {},
		comments: ReadonlyArray<{
			readonly login: string | null;
			readonly body: string;
			readonly association?: string;
		}> = [{ login: 'octocat', body: `Fix ${id}.` }]
	) =>
		JSON.stringify({
			id,
			isResolved: state.isResolved ?? false,
			isOutdated: state.isOutdated ?? false,
			path: 'src/a.ts',
			line: id === 'PRRT_file' ? null : 3,
			comments: {
				nodes: comments.map((comment, index) => ({
					author: comment.login === null ? null : { login: comment.login },
					authorAssociation: comment.association ?? 'MEMBER',
					body: comment.body,
					url: `https://github.com/o/r/pull/7#discussion_r${id}${index}`
				}))
			}
		});

	it.effect(
		"lists a PR's open, current threads across every page, as their first comments opened them",
		() =>
			Effect.gen(function* () {
				const { repo, argv } = yield* listingGh(
					[
						thread('PRRT_open', {}, [
							{ login: 'octocat', body: 'Fix this.' },
							{ login: 'author', body: 'Done.' }
						]),
						thread('PRRT_resolved', { isResolved: true }),
						thread('PRRT_outdated', { isOutdated: true }),
						// Page 2.
						thread('PRRT_file', {}, [
							{ login: null, body: 'Split this file.', association: 'NONE' }
						]),
						thread('PRRT_empty', {}, []),
						''
					].join('\n')
				);
				const gh = yield* Gh;

				const threads = yield* gh.reviewThreads(
					repo,
					'https://github.example.com/o/r/pull/7'
				);

				expect(threads).toEqual([
					{
						id: 'PRRT_open',
						path: 'src/a.ts',
						line: 3,
						author: 'octocat',
						authorCanWrite: true,
						body: 'Fix this.',
						url: 'https://github.com/o/r/pull/7#discussion_rPRRT_open0'
					},
					{
						id: 'PRRT_file',
						path: 'src/a.ts',
						line: null,
						author: null,
						authorCanWrite: false,
						body: 'Split this file.',
						url: 'https://github.com/o/r/pull/7#discussion_rPRRT_file0'
					}
				]);
				const call = argv();
				expect(call).toMatch(
					/^api graphql --hostname github\.example\.com --paginate -f query=/u
				);
				expect(call).toContain('reviewThreads(first: 100, after: $endCursor)');
				expect(call).toContain(
					'-f owner=o -f name=r -F number=7 --jq .data.repository.pullRequest.reviewThreads.nodes[]'
				);
			}).pipe(Effect.scoped, Effect.provide(GhLive))
	);

	it.effect('fails with GhError when a listed thread is not one, rather than missing it', () =>
		Effect.gen(function* () {
			const { repo } = yield* listingGh(`${thread('PRRT_open')}\n{"id":"PRRT_bad"}\n`);
			const gh = yield* Gh;

			const failed = yield* Effect.flip(
				gh.reviewThreads(repo, 'https://github.com/o/r/pull/7')
			);

			expect(failed._tag).toBe('GhError');
		}).pipe(Effect.scoped, Effect.provide(GhLive))
	);

	it.effect('resolves a thread through the GraphQL API of the PR host', () =>
		Effect.gen(function* () {
			const { repo, argv } = yield* listingGh('{"data":{}}\n');
			const gh = yield* Gh;

			yield* gh.resolveThread(repo, {
				prUrl: 'https://github.example.com/o/r/pull/7',
				threadId: 'PRRT_open'
			});

			const call = argv();
			expect(call).toMatch(/^api graphql --hostname github\.example\.com -f query=mutation/u);
			expect(call).toContain('resolveReviewThread(input: { threadId: $threadId })');
			expect(call).toMatch(/-f threadId=PRRT_open$/u);
		}).pipe(Effect.scoped, Effect.provide(GhLive))
	);

	const MARKER = '<!-- ship-review: 20261120-100000-abcdef-r1 -->';
	const listed = (id: number, body: string | null) =>
		JSON.stringify({ html_url: `https://github.com/o/r/pull/7#pullrequestreview-${id}`, body });

	it.effect('finds the first review whose body holds the marker, across every page', () =>
		Effect.gen(function* () {
			const { repo, argv } = yield* listingGh(
				[
					// Page 1: a review without a body, and one by someone else.
					listed(1, null),
					listed(2, 'Looks good.'),
					// Page 2: ship's review, then a later one quoting it.
					listed(3, `Findings.\n\n${MARKER}`),
					listed(4, `> ${MARKER}`),
					''
				].join('\n')
			);
			const gh = yield* Gh;

			const url = yield* gh.findReview(repo, {
				prUrl: 'https://github.example.com/o/r/pull/7',
				marker: MARKER
			});

			expect(url).toBe('https://github.com/o/r/pull/7#pullrequestreview-3');
			expect(argv()).toBe(
				'api --hostname github.example.com --paginate repos/o/r/pulls/7/reviews --jq .[] | {html_url, body}'
			);
		}).pipe(Effect.scoped, Effect.provide(GhLive))
	);

	it.effect('finds no review when none holds the marker or the PR has no reviews', () =>
		Effect.gen(function* () {
			const gh = yield* Gh;
			const input = { prUrl: 'https://github.com/o/r/pull/7', marker: MARKER };
			const unmarked = yield* listingGh(`${listed(1, 'Looks good.')}\n${listed(2, null)}\n`);
			const none = yield* listingGh('');

			expect(yield* gh.findReview(unmarked.repo, input)).toBeNull();
			expect(yield* gh.findReview(none.repo, input)).toBeNull();
		}).pipe(Effect.scoped, Effect.provide(GhLive))
	);

	it.effect('fails with GhError when a listed review is not one, rather than missing it', () =>
		Effect.gen(function* () {
			const { repo } = yield* listingGh(`${listed(1, 'Looks good.')}\nnot json\n`);
			const gh = yield* Gh;

			const failed = yield* Effect.flip(
				gh.findReview(repo, { prUrl: 'https://github.com/o/r/pull/7', marker: MARKER })
			);

			// Taking a garbled listing for "not posted" would post a second review.
			expect(failed).toMatchObject({ _tag: 'GhError', exitCode: 0 });
			expect(failed.stderr).toMatch(/^Unexpected output/u);
		}).pipe(Effect.scoped, Effect.provide(GhLive))
	);

	it.effect('fails with GhError when gh pr view prints something other than a PR', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			writeFileSync(
				`${dir}/gh`,
				`#!/bin/sh\necho '{"baseRefName":"main","body":"","headRefOid":"${HEAD_SHA}","number":7,"title":"Issue","url":"https://github.com/o/r/issues/7"}'\n`
			);
			chmodSync(`${dir}/gh`, 0o755);
			const gh = yield* Gh;
			const failed = yield* Effect.flip(
				gh.viewPr({ cwd: dir, env: { PATH: `${dir}:/bin` } }, '7')
			);
			expect(failed).toMatchObject({ _tag: 'GhError', exitCode: 0 });
			expect(failed.stderr).toMatch(/a pull request URL/u);
		}).pipe(Effect.scoped, Effect.provide(GhLive))
	);

	it.effect('fails with GhError on a non-zero exit or a missing gh', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			writeFileSync(`${dir}/gh`, '#!/bin/sh\necho "HTTP 403: no permission" >&2\nexit 1\n');
			chmodSync(`${dir}/gh`, 0o755);
			const gh = yield* Gh;
			const failed = yield* Effect.flip(
				gh.findPr({ cwd: dir, env: { PATH: `${dir}:/bin` } }, 'feature')
			);
			expect(failed).toMatchObject({
				_tag: 'GhError',
				exitCode: 1,
				stderr: 'HTTP 403: no permission\n'
			});
			const missing = yield* Effect.flip(
				gh.findPr({ cwd: dir, env: { PATH: '/nonexistent' } }, 'feature')
			);
			expect(missing).toMatchObject({ _tag: 'GhError', exitCode: null });
		}).pipe(Effect.scoped, Effect.provide(GhLive))
	);
});
