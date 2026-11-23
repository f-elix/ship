import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
	ChangeIntent,
	FindingId,
	reviewStep,
	ShipHome,
	type ResolvedConfig,
	type ReviewStepInput,
	type VerifiedFinding
} from '../src/index.ts';
import { AgentFake, ClefFake, fakeSha } from '../src/testing.ts';
import { baseSha, projectKey, resolvedConfig, verifiedFinding } from './fixtures.ts';
import { CheckpointValues, recordingKit, scopeWith, withSteps } from './step-harness.ts';

const input = (followUp: ReviewStepInput['followUp'] = null): ReviewStepInput => ({
	...scopeWith(),
	round: followUp === null ? 1 : 2,
	intent: ChangeIntent.cases.Description.make({ title: 'Add a', body: 'Adds a.' }),
	followUp
});

/** Only `src/a.ts` changed: a source file, so routing picks `standards` alone. */
const sourceChange = { changedFiles: [{ path: 'src/a.ts', status: 'added' as const }] };

const reports = (...claims: ReadonlyArray<string>) => ({
	output: {
		findings: claims.map((claim) => ({
			file: 'src/a.ts',
			line: 1,
			severity: 'must-fix',
			claim,
			evidence: 'const a = 1;'
		}))
	},
	costUsd: 0.1
});

const confirms = (
	count: number,
	previous: ReadonlyArray<{ readonly id: string; readonly status: 'fixed' | 'unfixed' }> = []
) => ({
	output: {
		verdicts: Array.from({ length: count }, (_, index) => ({
			index,
			verdict: 'confirmed',
			reason: 'Seen'
		})),
		previous: previous.map((entry) => ({ ...entry, evidence: 'Checked' }))
	},
	costUsd: 0.2
});

/** The labels of the agent calls made, or the step for an unlabelled call. */
const callLabels = Effect.gen(function* () {
	const calls = yield* (yield* AgentFake).calls;
	return calls.map((call) => call.label ?? call.step);
});

describe('reviewStep', () => {
	it.effect('runs the reviewers routing picks and verifies what they report', () =>
		withSteps(
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'review', label: 'standards' }, reports('Injection.'));
				yield* agent.script({ step: 'verify' }, confirms(1));
				const recorded = yield* recordingKit;

				const round = yield* reviewStep.run(input(), recorded.kit);

				expect(round).toMatchObject({
					round: 1,
					fromSha: baseSha,
					reviewers: ['standards']
				});
				expect(round.findings.map((finding) => finding.claim)).toEqual(['Injection.']);
				expect(yield* callLabels).toEqual(['standards', 'verify']);
				expect(yield* recorded.tags).toEqual([
					'ReviewStarted',
					'FindingsReported',
					'FindingsVerified'
				]);
				expect(yield* recorded.costs).toEqual([0.1, 0.2]);
			}),
			sourceChange
		)
	);

	it.effect('resumes by running only the reviewers that had not reported', () =>
		withSteps(
			Effect.gen(function* () {
				const values = yield* CheckpointValues;
				values.set('route', { toSha: baseSha, reviewers: ['security', 'standards'] });
				values.set('reviewer/standards', []);
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'review', label: 'security' }, reports('Secret.'));
				yield* agent.script({ step: 'verify' }, confirms(1));
				const recorded = yield* recordingKit;

				const round = yield* reviewStep.run(input(), recorded.kit);

				expect(round.reviewers).toEqual(['security', 'standards']);
				expect(yield* callLabels).toEqual(['security', 'verify']);
				// Routing was restored, so it reported nothing again.
				expect(yield* recorded.tags).not.toContain('ReviewStarted');
			}),
			sourceChange
		)
	);

	it.effect('after a fix, brings back reviewers of must-fix findings and rechecks them', () =>
		withSteps(
			Effect.gen(function* () {
				const previous: VerifiedFinding = {
					...verifiedFinding,
					id: FindingId.make('r1-1'),
					reviewer: 'security',
					alsoReportedBy: []
				};
				const agent = yield* AgentFake;
				yield* agent.script({ step: 'review', label: 'security' }, reports());
				yield* agent.script({ step: 'review', label: 'standards' }, reports());
				yield* agent.script(
					{ step: 'verify' },
					confirms(0, [{ id: 'r1-1', status: 'fixed' }])
				);
				const recorded = yield* recordingKit;

				const round = yield* reviewStep.run(
					input({ previous: [previous], knownTradeoffs: [], routedFromSha: fakeSha(9) }),
					recorded.kit
				);

				expect(round.reviewers).toEqual(['security', 'standards']);
				expect(round.findings).toEqual([]);
				const verify = (yield* agent.calls).find((call) => call.step === 'verify');
				expect(verify?.prompt).toContain('r1-1');
			}),
			sourceChange
		)
	);

	/** The model the `standards` reviewer ran on. */
	const reviewModel = Effect.gen(function* () {
		const calls = yield* (yield* AgentFake).calls;
		return calls.find((call) => call.label === 'standards')?.model;
	});

	/** Runs a review on `config` whose only reviewer, `standards`, reports nothing. */
	const reviewNothing = (config: Partial<ResolvedConfig> = {}) =>
		Effect.gen(function* () {
			yield* (yield* AgentFake).script({ step: 'review', label: 'standards' }, reports());
			const step = { ...input(), ...scopeWith(config) };
			return yield* reviewStep.run(step, (yield* recordingKit).kit);
		});

	it.effect.each([
		[0, 'trivial', resolvedConfig.models.reviewTrivial],
		[1, 'routine', resolvedConfig.models.review],
		[2, 'risky', resolvedConfig.models.reviewRisky]
	] as const)('reviews with the model for a risk score of %d (%s)', ([score, risk, model]) =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ClefFake).answer('risk', { score });
				yield* reviewNothing();
				expect(yield* reviewModel).toBe(model);
				expect((yield* CheckpointValues).get('route')).toMatchObject({ risk });
			}),
			sourceChange
		)
	);

	it.effect('reviews with `models.review` when Clef gives no risk', () =>
		withSteps(
			Effect.gen(function* () {
				yield* (yield* ClefFake).answer('risk', { score: 2 });
				yield* reviewNothing({ clef: false });
				expect(yield* reviewModel).toBe(resolvedConfig.models.review);
				expect((yield* CheckpointValues).get('route')).toMatchObject({ risk: null });
			}),
			sourceChange
		)
	);

	it.effect("lets a reviewer's frontmatter model win over the risk's", () =>
		withSteps(
			Effect.gen(function* () {
				const dir = (yield* ShipHome).projectReviewers(projectKey);
				mkdirSync(dir, { recursive: true });
				writeFileSync(
					`${dir}/standards.md`,
					'---\nname: standards\nmodel: pinned\ntriggers:\n    fileKinds: [source]\n---\n\nPinned.\n'
				);
				yield* (yield* ClefFake).answer('risk', { score: 2 });
				yield* reviewNothing();
				expect(yield* reviewModel).toBe('pinned');
			}),
			sourceChange
		)
	);

	it.effect('reuses the checkpointed risk on resume, asking Clef nothing', () =>
		withSteps(
			Effect.gen(function* () {
				const values = yield* CheckpointValues;
				values.set('route', { toSha: baseSha, reviewers: ['standards'], risk: 'trivial' });
				values.set('conventions', []);
				const clef = yield* ClefFake;
				yield* clef.answer('risk', { score: 2 });
				yield* reviewNothing();
				expect(yield* reviewModel).toBe(resolvedConfig.models.reviewTrivial);
				expect(yield* clef.asks).toEqual([]);
			}),
			sourceChange
		)
	);

	it.effect('reviews a route checkpointed before risk existed with `models.review`', () =>
		withSteps(
			Effect.gen(function* () {
				const values = yield* CheckpointValues;
				values.set('route', { toSha: baseSha, reviewers: ['standards'] });
				yield* reviewNothing();
				expect(yield* reviewModel).toBe(resolvedConfig.models.review);
			}),
			sourceChange
		)
	);
});
