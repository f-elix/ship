import { describe, expect, it } from '@effect/vitest';
import { credentialsPath } from '@ship/core/credentials';
import { tempDir } from '@ship/daemon/testing';
import { Cause, Effect, Queue, Terminal } from 'effect';
import { existsSync } from 'node:fs';
import { cli } from './support.ts';

/** A terminal whose input has ended, as when the user quits a prompt. */
const quitTerminal = Terminal.make({
	columns: Effect.succeed(80),
	rows: Effect.succeed(24),
	size: Effect.flatMap(Queue.make<Terminal.Size, Cause.Done>(), (queue) =>
		Effect.as(Queue.end(queue), queue)
	),
	readInput: Effect.flatMap(Queue.make<Terminal.UserInput, Cause.Done>(), (queue) =>
		Effect.as(Queue.end(queue), queue)
	),
	readLine: Effect.fail(new Terminal.QuitError({})),
	display: () => Effect.void
});

describe('ship auth cloudflare', () => {
	it.live('saves nothing when the prompt is quit', () =>
		Effect.gen(function* () {
			const home = yield* tempDir;
			const result = yield* cli(['auth', 'cloudflare'], { home, terminal: quitTerminal });
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('cancelled; nothing was saved');
			expect(existsSync(credentialsPath(home))).toBe(false);
		})
	);
});
