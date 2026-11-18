import { NodeHttpClient } from '@effect/platform-node';
import { ShipRpcs } from '@ship/core/contract';
import { Context, Layer } from 'effect';
import { RpcClient, RpcSerialization, type RpcClientError } from 'effect/rpc';
import { RPC_PATH } from './protocol.ts';

/** A client of the daemon's RPC server; the CLI and the future UI both use it. */
export class DaemonClient extends Context.Service<
	DaemonClient,
	RpcClient.FromGroup<typeof ShipRpcs, RpcClientError.RpcClientError>
>()('@ship/daemon/DaemonClient') {
	/** Connects over HTTP to the daemon listening on the unix socket at `socketPath`. */
	static readonly layer = (socketPath: string) =>
		Layer.effect(this, RpcClient.make(ShipRpcs)).pipe(
			Layer.provide(RpcClient.layerProtocolHttp({ url: `http://localhost${RPC_PATH}` })),
			Layer.provide([
				NodeHttpClient.layerUndiciOptions({ connect: { socketPath } }),
				RpcSerialization.layerNdjson
			])
		);
}
