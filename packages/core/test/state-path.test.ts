import { describe, expect, it } from '@effect/vitest';
import { statePath } from '../src/index.ts';

describe('statePath', () => {
	it('turns XState state values into dotted paths', () => {
		expect(statePath('review')).toBe('review');
		expect(statePath({ checks: 'waiting' })).toBe('checks.waiting');
		expect(statePath({ a: { b: 'c' } })).toBe('a.b.c');
		expect(statePath({ left: 'x', right: 'y' })).toBe('left.x,right.y');
		expect(statePath(null)).toBe('');
	});
});
