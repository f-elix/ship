import { describe, expect, it } from '@effect/vitest';
import { DateTime } from 'effect';
import { buildSummary, RunId, type RunEvent } from '../src/index.ts';

const at = DateTime.makeUnsafe(0);
const runId = RunId.make('19700101-000000-abcdef');
const pass = { baseline: false, round: 1, attempt: 0 } as const;

const started = (check: string): RunEvent => ({
	_tag: 'CheckStarted',
	at,
	...pass,
	check,
	command: 'run',
	commandLine: `pnpm ${check}`
});

const finished = (check: string, exitCode: number): RunEvent => ({
	_tag: 'CheckFinished',
	at,
	...pass,
	check,
	command: 'run',
	exitCode,
	durationMs: 5,
	outputTail: `${check} output`
});

const summarize = (events: ReadonlyArray<RunEvent>) =>
	buildSummary({ runId, status: 'escalated', events, error: null });

describe('buildSummary', () => {
	it('lists a complete check pass with output only for failures', () => {
		const summary = summarize([
			started('lint'),
			finished('lint', 0),
			started('test'),
			finished('test', 1)
		]);
		expect(summary.checks).toEqual([
			{
				...pass,
				results: [
					{ name: 'lint', exitCode: 0, durationMs: 5 },
					{ name: 'test', exitCode: 1, durationMs: 5, outputTail: 'test output' }
				]
			}
		]);
	});

	it('leaves out a pass whose command never finished', () => {
		// `test` timed out after `lint` passed: the pass is not all green.
		expect(summarize([started('lint'), finished('lint', 0), started('test')]).checks).toEqual(
			[]
		);
	});

	it('keeps the latest result of a pass that ran again after a resume', () => {
		const summary = summarize([started('test'), started('test'), finished('test', 0)]);
		expect(summary.checks.map((round) => round.results)).toEqual([
			[{ name: 'test', exitCode: 0, durationMs: 5 }]
		]);
	});
});
