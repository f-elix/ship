import { Clef, saveCloudflareCredentials } from '@ship/core/clef';
import { credentialsPath, type CloudflareCredentials } from '@ship/core/credentials';
import { Console, Effect, Redacted } from 'effect';
import { Command, Prompt } from 'effect/cli';
import { cliError } from './connection.ts';
import { Invocation } from './invocation.ts';

const required = (what: string) => (value: string) => {
	const trimmed = value.trim();
	return trimmed.length === 0 ? Effect.fail(`enter the ${what}`) : Effect.succeed(trimmed);
};

const askCloudflare = Effect.gen(function* () {
	const accountId = yield* Prompt.String({
		message: 'Cloudflare account id',
		validate: required('account id')
	});
	const apiToken = yield* Prompt.Hidden({
		message: 'Cloudflare API token (Workers AI permission)',
		validate: required('API token')
	});
	return {
		accountId: accountId.trim(),
		apiToken: Redacted.value(apiToken).trim()
	} satisfies CloudflareCredentials;
});

const cloudflare = Command.make(
	'cloudflare',
	{},
	Effect.fn('ship.auth.cloudflare')(
		function* () {
			const invocation = yield* Invocation;
			const credentials = yield* askCloudflare;
			yield* saveCloudflareCredentials(invocation.home, credentials).pipe(
				Effect.provide(Clef.layer)
			);
			yield* Console.error(
				`ship: saved the Cloudflare credentials to ${credentialsPath(invocation.home)}`
			);
		},
		Effect.catchTags({
			ClefError: (error) =>
				Effect.fail(
					cliError(
						`Cloudflare refused the credentials, so nothing was saved: ${error.message}`
					)
				),
			CredentialsFileError: (error) => Effect.fail(cliError(error.message)),
			QuitError: () => Effect.fail(cliError('cancelled; nothing was saved'))
		})
	)
).pipe(
	Command.withDescription(
		'Save the Cloudflare account id and API token that Clef decisions use, after checking them with one Clef call.'
	)
);

export const auth = Command.make('auth').pipe(
	Command.withDescription("Save credentials for the services ship calls, in ship's home."),
	Command.withSubcommands([cloudflare])
);
