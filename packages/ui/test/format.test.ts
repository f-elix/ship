import { elapsed, relTime } from '#lib/format.ts';
import { describe, expect, it } from '@effect/vitest';

const START = '2026-01-01T12:00:00.000Z';
/** The ISO time `seconds` after `START`. */
const after = (seconds: number) => new Date(Date.parse(START) + seconds * 1000).toISOString();

describe('relTime', () => {
	const ago = (seconds: number) => relTime(START, Date.parse(after(seconds)));

	it('counts whole seconds, minutes, hours, then days', () => {
		expect([0, 59, 60, 3599, 3600, 86_399, 86_400, 3 * 86_400].map(ago)).toEqual([
			'0s ago',
			'59s ago',
			'1m ago',
			'59m ago',
			'1h ago',
			'23h ago',
			'1d ago',
			'3d ago'
		]);
	});

	it('says 0s ago for a time a skewed clock puts in the future', () => {
		expect(ago(-5)).toBe('0s ago');
	});
});

describe('elapsed', () => {
	const lasting = (seconds: number) => elapsed(START, after(seconds));

	it('gives seconds, then minutes and seconds, then hours and minutes', () => {
		expect([0, 59, 60, 250, 3599, 3600, 7199].map(lasting)).toEqual([
			'0s',
			'59s',
			'1m 0s',
			'4m 10s',
			'59m 59s',
			'1h 0m',
			'1h 59m'
		]);
	});
});
