/**
 * A daemon process for tests, run as `node daemon-process.ts <version>` with `SHIP_HOME`
 * set. Its implementer never finishes, so its runs stay active until the process stops.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { AgentFake, GhFake } from '@ship/core/testing';
import { Context, Effect, Layer, References } from 'effect';
import { serveDaemon, shipHomeDir } from '../../src/index.ts';

const services = Layer.effectContext(
	Effect.gen(function* () {
		const context = yield* Layer.build(Layer.mergeAll(AgentFake.layer, GhFake.layer));
		const hangs = () => Effect.never;
		yield* Context.get(context, AgentFake).script({ step: 'implement' }, hangs, hangs, hangs);
		return context;
	})
);

NodeRuntime.runMain(
	Effect.gen(function* () {
		const home = yield* shipHomeDir;
		yield* serveDaemon({ home, version: process.argv[2] ?? 'unknown', services });
	}).pipe(
		Effect.provide(NodeServices.layer),
		Effect.provideService(References.MinimumLogLevel, 'Warn')
	)
);
