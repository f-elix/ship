import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	ChangeIntent,
	commitStep,
	FindingId,
	pushStep,
	recheckStep,
	resolveStep,
	type VerifiedFinding
} from '../src/index.ts';
import { AgentFake, fakeSha, GhFake, GitFake } from '../src/testing.ts';
import { baseSha } from './fixtures.ts';
import { CheckpointValues, recordingKit, scopeWith, withSteps } from './step-harness.ts';

const PR_URL = 'https://github.com/f-elix/example/pull/1';

const findingOf = (n: number, severity: VerifiedFinding['severity'] = 'must-fix') =>
	({
		id: FindingId.make(`r1-${n}`),
		round: 1,
		reviewer: 'standards',
		alsoReportedBy: [],
		file: 'src/a.ts',
		line: n,
		severity,
		claim: `Claim ${n}.`,
		evidence: 'const a = 1;'
	}) satisfies VerifiedFinding;

const intent = ChangeIntent.cases.Description.make({ title: 'Add a', body: 'Adds a.' });

/** Only `src/a.ts` changed since `baseSha`. */
const sourceChange = { changedFiles: [{ path: 'src/a.ts', status: 'modified' as const }] };

/** What the verifier answers about earlier findings: their statuses, and no new verdicts. */
const statuses = (
	previous: ReadonlyArray<{ readonly id: string; readonly status: 'fixed' | 'unfixed' }>
) => ({
	output: {
		verdicts: [],
		previous: previous.map((entry) => ({ ...entry, evidence: `${entry.id} checked` }))
	},
	costUsd: 0.2
});

describe('recheckStep', () => {
	it.effect("gives each finding the verifier's status and evidence, unfixed by default", () =>
		withSteps(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				yield* agent.script(
					{ step: 'verify' },
					statuses([
						{ id: 'r1-1', status: 'fixed' },
						{ id: 'r1-2', status: 'unfixed' }
					])
				);
				const recorded = yield* recordingKit;

				const rechecked = yield* recheckStep.run(
					{
						...scopeWith(),
						intent,
						findings: [findingOf(1), findingOf(2), findingOf(3, 'nit')]
					},
					recorded.kit
				);

				expect(
					rechecked.map(({ finding, status }) => ({ id: finding.id, status }))
				).toEqual([
					{ id: 'r1-1', status: 'fixed' },
					{ id: 'r1-2', status: 'unfixed' },
					{ id: 'r1-3', status: 'unfixed' }
				]);
				expect(rechecked[0]?.evidence).toBe('r1-1 checked');
				expect(rechecked[2]?.evidence).toContain('no status');
				expect(yield* recorded.tags).toEqual(['FindingsRechecked']);
				expect(yield* recorded.costs).toEqual([0.2]);
				const [call] = yield* agent.calls;
				expect(call?.prompt).toContain('Claim 3.');
			}),
			sourceChange
		)
	);

	it.effect('takes the checkpointed statuses on resume instead of asking again', () =>
		withSteps(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				yield* agent.script(
					{ step: 'verify' },
					statuses([{ id: 'r1-1', status: 'fixed' }])
				);
				const input = { ...scopeWith(), intent, findings: [findingOf(1)] };
				const first = yield* recheckStep.run(input, (yield* recordingKit).kit);

				const again = yield* recheckStep.run(input, (yield* recordingKit).kit);

				expect(again).toEqual(first);
				expect(yield* agent.calls).toHaveLength(1);
			}),
			sourceChange
		)
	);
});

describe('resolveStep', () => {
	const openThreads = Effect.gen(function* () {
		const gh = yield* GhFake;
		const a = yield* gh.addThread({
			prUrl: PR_URL,
			path: 'src/a.ts',
			line: 1,
			author: 'octocat',
			body: 'Fix a.'
		});
		const b = yield* gh.addThread({
			prUrl: PR_URL,
			path: 'src/a.ts',
			line: 2,
			author: 'octocat',
			body: 'Fix b.'
		});
		return [
			{ findingId: FindingId.make('t1'), threadId: a.id },
			{ findingId: FindingId.make('t2'), threadId: b.id }
		];
	});

	it.effect('resolves every thread on GitHub and reports each', () =>
		withSteps(
			Effect.gen(function* () {
				const threads = yield* openThreads;
				const recorded = yield* recordingKit;

				const resolved = yield* resolveStep.run(
					{ ...scopeWith(), prUrl: PR_URL, headSha: baseSha, threads },
					recorded.kit
				);

				expect(resolved).toEqual(threads.map((thread) => thread.threadId));
				const gh = yield* GhFake;
				expect((yield* gh.threads).every((thread) => thread.resolved)).toBe(true);
				expect(yield* recorded.tags).toEqual(['ThreadResolved', 'ThreadResolved']);
			})
		)
	);

	it.effect('skips the threads it resolved before a resume', () =>
		withSteps(
			Effect.gen(function* () {
				const threads = yield* openThreads;
				const [first] = threads;
				(yield* CheckpointValues).set(`thread/${first?.threadId}`, first?.threadId);

				yield* resolveStep.run(
					{ ...scopeWith(), prUrl: PR_URL, headSha: baseSha, threads },
					(yield* recordingKit).kit
				);

				expect(yield* (yield* GhFake).resolveCalls).toEqual([threads[1]?.threadId]);
			})
		)
	);

	it.effect('refuses, resolving nothing, when HEAD moved from the rechecked head', () =>
		withSteps(
			Effect.gen(function* () {
				const threads = yield* openThreads;

				const error = yield* Effect.flip(
					resolveStep.run(
						{ ...scopeWith(), prUrl: PR_URL, headSha: fakeSha(9), threads },
						(yield* recordingKit).kit
					)
				);

				expect(error._tag).toBe('StepNotReady');
				expect(yield* (yield* GhFake).resolveCalls).toEqual([]);
			})
		)
	);
});

describe('commitStep', () => {
	it.effect('commits the work and reports it, or returns null with nothing to commit', () =>
		withSteps(
			Effect.gen(function* () {
				const git = yield* GitFake;
				yield* git.edit([{ path: 'src/a.ts', status: 'modified' }]);
				const recorded = yield* recordingKit;
				const input = { ...scopeWith(), message: 'Address review findings' };

				const sha = yield* commitStep.run(input, recorded.kit);
				const again = yield* commitStep.run(input, recorded.kit);

				const state = yield* git.state;
				expect(sha).toBe(state.headSha);
				expect(state.commits.map((commit) => commit.message)).toEqual([
					'Address review findings'
				]);
				expect(again).toBeNull();
				expect(yield* recorded.tags).toEqual(['CommitCreated']);
			})
		)
	);
});

describe('pushStep', () => {
	const target = { remote: 'origin', ref: 'feature' };

	it.effect("pushes HEAD to the PR's branch when it descends from the pinned head", () =>
		withSteps(
			Effect.gen(function* () {
				const git = yield* GitFake;
				yield* git.edit([{ path: 'src/a.ts', status: 'modified' }]);
				const sha = yield* commitStep.run(
					{ ...scopeWith(), message: 'Fix' },
					(yield* recordingKit).kit
				);
				const recorded = yield* recordingKit;

				const pushed = yield* pushStep.run(
					{ ...scopeWith(), pinnedSha: baseSha, target },
					recorded.kit
				);

				expect(pushed).toBe(sha);
				expect((yield* git.state).headPushes).toEqual([{ ...target, sha }]);
				expect(yield* recorded.tags).toEqual(['BranchPushed']);
			})
		)
	);

	it.effect('pushes nothing when HEAD is still the pinned head', () =>
		withSteps(
			Effect.gen(function* () {
				const pushed = yield* pushStep.run(
					{ ...scopeWith(), pinnedSha: baseSha, target },
					(yield* recordingKit).kit
				);

				expect(pushed).toBeNull();
				expect((yield* (yield* GitFake).state).headPushes).toEqual([]);
			})
		)
	);

	it.effect('refuses when HEAD does not descend from the pinned head', () =>
		withSteps(
			Effect.gen(function* () {
				const error = yield* Effect.flip(
					pushStep.run(
						{ ...scopeWith(), pinnedSha: baseSha, target },
						(yield* recordingKit).kit
					)
				);

				expect(error._tag).toBe('StepNotReady');
				expect((yield* (yield* GitFake).state).headPushes).toEqual([]);
			}),
			{ headSha: fakeSha(9) }
		)
	);
});
