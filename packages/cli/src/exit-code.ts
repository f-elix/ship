import { Context, Effect, Ref } from 'effect';

/** The process exit code a command sets when it ends normally; 0 unless set. */
export class ExitCode extends Context.Service<ExitCode, Ref.Ref<number>>()(
	'@f-elix/ship/ExitCode'
) {}

export const setExitCode = (code: number) =>
	Effect.gen(function* () {
		yield* Ref.set(yield* ExitCode, code);
	});
