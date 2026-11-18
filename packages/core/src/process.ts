import { Effect, Fiber, Ref, Stream, type PlatformError } from 'effect';
import type { ChildProcess } from 'effect/process';

export interface ProcessOutput {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

const collectText = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
	Stream.mkString(Stream.decodeText(stream));

/** Runs a command to completion and collects its exit code, stdout and stderr. */
export const exec = (command: ChildProcess.Command) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* command;
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[collectText(handle.stdout), collectText(handle.stderr), handle.exitCode],
				{ concurrency: 'unbounded' }
			);
			return { exitCode, stdout, stderr } satisfies ProcessOutput;
		})
	);

/** How much of a command's output to keep. */
export interface OutputTailLimits {
	readonly maxLines: number;
	readonly maxBytes: number;
}

export const DEFAULT_OUTPUT_TAIL: OutputTailLimits = { maxLines: 80, maxBytes: 16_384 };

// How long to keep reading output after the process exited, for a background descendant
// that still holds the pipe open. The scope then kills the process group.
const OUTPUT_GRACE = '500 millis';

const ANSI_ESCAPE = new RegExp(
	String.raw`\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007`,
	'gu'
);

const appendBounded = (kept: Uint8Array, chunk: Uint8Array, maxBytes: number): Uint8Array => {
	if (chunk.length >= maxBytes) return chunk.slice(chunk.length - maxBytes);
	const start = Math.max(0, kept.length + chunk.length - maxBytes);
	const next = new Uint8Array(kept.length - start + chunk.length);
	next.set(kept.subarray(start), 0);
	next.set(chunk, kept.length - start);
	return next;
};

/**
 * The last lines of some output: colour codes removed, at most `maxLines` lines and,
 * before decoding, `maxBytes` bytes. Starts with a `…` line when anything was cut.
 */
export const outputTail = (
	bytes: Uint8Array,
	limits: OutputTailLimits,
	bytesCut: boolean
): string => {
	const text = new TextDecoder()
		.decode(bytes)
		.replace(/^�+/u, '')
		.replace(ANSI_ESCAPE, '')
		.replace(/\r\n?/gu, '\n')
		.trimEnd();
	const lines = text.split('\n');
	if (bytesCut) lines.shift();
	const kept = lines.slice(-limits.maxLines);
	const cut = bytesCut || kept.length < lines.length;
	return (cut ? ['…', ...kept] : kept).join('\n');
};

/**
 * Runs a command, keeping only the tail of its combined stdout and stderr. The process
 * group is killed when the command finishes or the effect is interrupted.
 */
export const execTail = (command: ChildProcess.Command, limits: OutputTailLimits) =>
	Effect.scoped(
		Effect.gen(function* () {
			const kept = yield* Ref.make<{ bytes: Uint8Array; cut: boolean }>({
				bytes: new Uint8Array(0),
				cut: false
			});
			const handle = yield* command;
			const reader = yield* handle.all.pipe(
				Stream.runForEach((chunk) =>
					Ref.update(kept, ({ bytes, cut }) => ({
						bytes: appendBounded(bytes, chunk, limits.maxBytes),
						cut: cut || bytes.length + chunk.length > limits.maxBytes
					}))
				),
				Effect.forkScoped
			);
			const exitCode = yield* handle.exitCode;
			yield* Fiber.join(reader).pipe(Effect.timeoutOption(OUTPUT_GRACE), Effect.ignore);
			const { bytes, cut } = yield* Ref.get(kept);
			return { exitCode, outputTail: outputTail(bytes, limits, cut) };
		})
	);
