import { JsonSchema, Schema } from 'effect';
import { configParseOptions, GlobalConfig, ProjectConfig } from './config.ts';

/**
 * JSON Schema files for the config files, keyed by file name. Point a config's
 * `$schema` at one to get editor completion; the Effect decoder stays the authority.
 */
export const configJsonSchemaFiles = () => ({
	'config.schema.json': toFile(GlobalConfig),
	'project.schema.json': toFile(ProjectConfig)
});

const toFile = (schema: Schema.Top): string => {
	const document = Schema.toJsonSchemaDocument(schema, configParseOptions);
	const file = {
		$schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
		...document.schema,
		...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {})
	};
	return `${JSON.stringify(file, null, '\t')}\n`;
};

/** Where a config file's `$schema` points: the generated files on the main branch. */
export const schemaUrl = (file: keyof ReturnType<typeof configJsonSchemaFiles>): string =>
	`https://raw.githubusercontent.com/f-elix/ship/main/packages/cli/schemas/${file}`;

/** The `$schema` that `ship init` writes into project configs. */
export const PROJECT_SCHEMA_URL = schemaUrl('project.schema.json');
