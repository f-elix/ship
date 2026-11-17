import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import {
	Finding,
	RunEvent,
	RunEventEnvelope,
	RunState,
	Summary,
	UnknownEvent,
	type RunEvent as RunEventType
} from '../src/index.ts';
import {
	at,
	baseSha,
	escalatedSummary,
	finding,
	headSha,
	jsonRoundTrip,
	nit,
	projectKey,
	resolvedConfig,
	runId,
	sessionId,
	verifiedFinding
} from './fixtures.ts';

const lock = { resource: 'db', check: 'test' };
const check = { check: 'test', command: 'run', baseline: false, round: 1, attempt: 2 } as const;

const events: ReadonlyArray<RunEventType> = [
	RunEvent.cases.RunCreated.make({
		at,
		projectKey,
		cwd: '/repo',
		planDir: '/plans/feature',
		branch: 'feature',
		baseSha
	}),
	RunEvent.cases.StateChanged.make({ at, from: 'checks.running', to: 'checks.waiting' }),
	RunEvent.cases.StepStarted.make({ at, step: 'implement' }),
	RunEvent.cases.StepEnded.make({
		at,
		step: 'implement',
		outcome: 'timed-out',
		durationMs: 3_600_000,
		error: 'timed out after 1 hour'
	}),
	RunEvent.cases.CheckStarted.make({ at, ...check, commandLine: 'vitest run a.ts b.ts' }),
	RunEvent.cases.CheckFinished.make({
		at,
		...check,
		exitCode: 1,
		durationMs: 4200,
		outputTail: 'FAIL a.ts'
	}),
	RunEvent.cases.LockWaiting.make({ at, ...lock }),
	RunEvent.cases.LockAcquired.make({ at, ...lock, waitedMs: 1500 }),
	RunEvent.cases.LockReleased.make({ at, ...lock }),
	RunEvent.cases.ReviewStarted.make({
		at,
		round: 2,
		fromSha: baseSha,
		toSha: headSha,
		reviewers: ['error-handling', 'tests']
	}),
	RunEvent.cases.FindingsReported.make({
		at,
		round: 1,
		reviewer: 'error-handling',
		findings: [finding]
	}),
	RunEvent.cases.FindingsVerified.make({
		at,
		round: 2,
		verified: [verifiedFinding],
		disproved: [{ finding: { ...finding, severity: 'nit' }, reason: 'The error is rethrown' }]
	}),
	RunEvent.cases.FindingsTriaged.make({
		at,
		round: 2,
		mustFix: [verifiedFinding.id],
		tradeoffs: [],
		nits: [nit.id]
	}),
	RunEvent.cases.Escalated.make({ at, reason: 'stall' }),
	RunEvent.cases.AgentCost.make({
		at,
		step: 'review',
		model: 'sonnet',
		sessionId,
		costUsd: 0.12
	}),
	RunEvent.cases.CommitCreated.make({ at, sha: headSha, message: 'ship: checks pass' }),
	RunEvent.cases.PrOpened.make({ at, url: 'https://github.com/f-elix/ship/pull/7', draft: true }),
	RunEvent.cases.RunFinished.make({ at, summary: escalatedSummary }),
	RunEvent.cases.RunInterrupted.make({ at }),
	RunEvent.cases.RunResumed.make({ at }),
	RunEvent.cases.RunCancelled.make({ at })
];

describe('RunEvent', () => {
	it('round-trips every case through JSON inside an envelope', () => {
		expect(new Set(events.map((event) => event._tag))).toEqual(
			new Set(Object.keys(RunEvent.cases))
		);
		events.forEach((event, index) => {
			const envelope = { runId, seq: index + 1, event };
			expect(jsonRoundTrip(RunEventEnvelope, envelope)).toEqual(envelope);
		});
	});

	it('round-trips an unknown event inside an envelope', () => {
		const envelope = {
			runId,
			seq: 3,
			event: UnknownEvent.make({
				type: 'RunExploded',
				json: '{"_tag":"RunExploded"}',
				error: 'x'
			})
		};
		expect(jsonRoundTrip(RunEventEnvelope, envelope)).toEqual(envelope);
	});

	it('encodes timestamps as ISO strings', () => {
		const encoded = Schema.encodeSync(RunEvent)(RunEvent.cases.RunCancelled.make({ at }));
		expect(encoded).toEqual({ _tag: 'RunCancelled', at: '2026-11-17T12:00:00.000Z' });
	});

	it('rejects unknown tags and non-positive sequence numbers', () => {
		const decode = Schema.decodeUnknownSync(RunEventEnvelope);
		const event = Schema.encodeSync(RunEvent)(events[0]!);
		expect(() => decode({ runId, seq: 1, event: { ...event, _tag: 'RunExploded' } })).toThrow();
		expect(() => decode({ runId, seq: 0, event })).toThrow(/greater than or equal to 1/);
	});
});

describe('run domain', () => {
	it('rejects a finding with an unknown severity', () => {
		expect(() =>
			Schema.decodeUnknownSync(Finding)({ ...finding, severity: 'blocker' })
		).toThrow(/"must-fix" \| "tradeoff" \| "nit"/);
	});

	it('round-trips a mid-run RunState through JSON, as a persisted snapshot', () => {
		const state: RunState = {
			runId,
			projectKey,
			cwd: '/repo',
			env: { PATH: '/usr/bin:/bin' },
			planDir: '/plans/feature',
			branch: 'feature',
			baseSha,
			config: resolvedConfig,
			implementerSessionId: sessionId,
			round: 2,
			checkFixAttempts: 1,
			lastReviewedSha: headSha,
			reviewRounds: [
				{
					round: 1,
					fromSha: baseSha,
					toSha: headSha,
					reviewers: ['comments'],
					findings: [nit]
				}
			],
			unresolved: { mustFix: [verifiedFinding], tradeoffs: [], nits: [nit] },
			checks: escalatedSummary.checks,
			costUsd: 0.84,
			prUrl: null,
			escalationReason: null
		};
		expect(jsonRoundTrip(RunState, state)).toEqual(state);
	});

	it('only allows terminal statuses in a summary', () => {
		const encoded = Schema.encodeSync(Summary)(escalatedSummary);
		expect(() => Schema.decodeUnknownSync(Summary)({ ...encoded, status: 'running' })).toThrow(
			/\["status"\]/
		);
	});
});
