/**
 * What `ship init` needs: detection, project config validation, the project key and the
 * global config, without the pipeline, the Agent SDK or the run store.
 */
export { ConfigLoader } from './config-loader.ts';
export { ProjectConfig } from './config.ts';
export * from './detect.ts';
export { Git } from './git.ts';
export { PROJECT_SCHEMA_URL } from './json-schema.ts';
