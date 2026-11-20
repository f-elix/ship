/**
 * A daemon process for tests, run as `node testing-daemon-process.ts <version>` with `SHIP_HOME`
 * set. Its implementer never finishes, so its runs stay active until the process stops.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer, References } from 'effect';
import { processEnv, serveDaemon, shipHomeDir } from './index.ts';
import { hangingFakes } from './testing.ts';

const services = Layer.effectContext(hangingFakes);

NodeRuntime.runMain(
	Effect.gen(function* () {
		const home = yield* shipHomeDir;
		yield* serveDaemon({
			home,
			version: process.argv[2] ?? 'unknown',
			services,
			env: processEnv()
		});
	}).pipe(
		Effect.provide(NodeServices.layer),
		Effect.provideService(References.MinimumLogLevel, 'Warn')
	)
);
