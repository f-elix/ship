import { DateTime, Schema } from 'effect';
import {
	configParseOptions,
	FindingId,
	GitSha,
	GlobalConfig,
	ProjectConfig,
	ProjectKey,
	resolveConfig,
	RunId,
	SessionId,
	type Finding,
	type ShipSummary,
	type VerifiedFinding
} from '../src/index.ts';

/** Encodes to JSON text and decodes it back, as the store and the RPC wire do. */
export const jsonRoundTrip = <S extends Schema.Codec<unknown, unknown>>(
	schema: S,
	value: S['Type']
): S['Type'] =>
	Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value))));

/** The config a run gets from an empty global config and a project with two checks. */
export const resolvedConfig = resolveConfig(
	Schema.decodeUnknownSync(GlobalConfig, configParseOptions)({}),
	Schema.decodeUnknownSync(
		ProjectConfig,
		configParseOptions
	)({
		checks: [
			{ name: 'lint', run: 'oxlint {files}', fix: 'oxlint --fix {files}' },
			{ name: 'test', run: 'vitest run', lock: 'db' }
		],
		format: 'prettier --write {files}'
	})
);

export const runId = RunId.make('run-1');
export const projectKey = ProjectKey.make('github.com/f-elix/ship');
export const baseSha = GitSha.make('a'.repeat(40));
export const headSha = GitSha.make('b'.repeat(40));
export const sessionId = SessionId.make('session-1');
export const at = DateTime.makeUnsafe('2026-11-17T12:00:00.000Z');

export const finding: Finding = {
	reviewer: 'error-handling',
	file: 'packages/core/src/config.ts',
	line: 12,
	severity: 'must-fix',
	claim: 'The decode failure is swallowed',
	evidence: 'catch {} on line 12 drops the error'
};

export const verifiedFinding: VerifiedFinding = {
	...finding,
	id: FindingId.make('r2-1'),
	round: 2,
	alsoReportedBy: ['standards'],
	repeats: FindingId.make('r1-3')
};

export const nit: VerifiedFinding = {
	reviewer: 'comments',
	file: 'README.md',
	severity: 'nit',
	claim: 'Typo',
	evidence: '"teh" in the first line',
	id: FindingId.make('r1-1'),
	round: 1,
	alsoReportedBy: []
};

export const escalatedSummary: ShipSummary = {
	runId,
	status: 'escalated',
	prUrl: 'https://github.com/f-elix/ship/pull/7',
	rounds: 2,
	checks: [
		{
			baseline: true,
			round: 0,
			attempt: 0,
			results: [{ name: 'lint', exitCode: 0, durationMs: 900 }]
		},
		{
			baseline: false,
			round: 0,
			attempt: 1,
			results: [
				{ name: 'test', exitCode: 1, durationMs: 4200, outputTail: 'FAIL config.test.ts' }
			]
		}
	],
	costUsd: 1.25,
	unresolvedMustFix: [verifiedFinding],
	tradeoffs: [],
	nits: [nit],
	escalationReason: 'stall',
	error: null
};
