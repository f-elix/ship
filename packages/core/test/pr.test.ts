import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import {
	FindingId,
	Gh,
	Pr,
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

describe('Gh', () => {
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
