import { Effect, Schema, SchemaGetter } from 'effect';

/**
 * Makes a struct key optional in the JSON and fills `value` when it is absent.
 * The description and default go on the encoded side, where the JSON Schema reads them.
 */
export const withDefault =
	<S extends Schema.Top>(value: S['Encoded'], description?: string) =>
	(self: S) =>
		Schema.optionalKey(
			Schema.toEncoded(self).annotate(
				description === undefined ? { default: value } : { default: value, description }
			)
		).pipe(
			Schema.decodeTo(self, {
				decode: SchemaGetter.withDefault(Effect.succeed(value)),
				encode: SchemaGetter.passthrough()
			})
		);
