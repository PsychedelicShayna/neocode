import type { NeoPiRpcClient } from "effect-neopi-rpc/client";
import * as Effect from "effect/Effect";
import { NEOPI_CAPABILITIES } from "./NeoPiCompatibility.ts";
import type { NeoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";

interface UsageConnection {
  readonly client: Pick<NeoPiRpcClient, "capabilities" | "request">;
  readonly validate: Effect.Effect<void, Error>;
}

const connections = new WeakMap<NeoPiSessionCatalogSource, Set<UsageConnection>>();

/** A native host contributes usage only for its lifetime and configured account. */
export const registerNeoPiUsageConnection = (
  source: NeoPiSessionCatalogSource,
  connection: UsageConnection,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const active = connections.get(source) ?? new Set<UsageConnection>();
      active.add(connection);
      connections.set(source, active);
    }),
    () =>
      Effect.sync(() => {
        const active = connections.get(source);
        active?.delete(connection);
        if (active?.size === 0) connections.delete(source);
      }),
  );

export const readNeoPiLiveUsage = Effect.fnUntraced(function* (
  source: NeoPiSessionCatalogSource,
  activeProvider: string,
) {
  for (const connection of connections.get(source) ?? []) {
    if (!connection.client.capabilities.has(NEOPI_CAPABILITIES.getUsage)) continue;
    yield* connection.validate;
    return yield* connection.client.request({
      type: "get_usage",
      provider: activeProvider,
      redact: true,
    });
  }
  return undefined;
});
