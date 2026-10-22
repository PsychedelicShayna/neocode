import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

const makeProviderRegistryMock = (
  providers: ReadonlyArray<ServerProvider> = [],
): ProviderRegistryShape => ({
  getProviders: Effect.succeed(providers),
  refresh: () => Effect.succeed(providers),
  refreshInstance: () => Effect.succeed(providers),
  refreshWorkspaceSnapshot: () => Effect.succeed(providers),
  streamChanges: Stream.empty,
});

export const makeProviderRegistryLayer = (providers: ReadonlyArray<ServerProvider> = []) =>
  Layer.succeed(ProviderRegistry, makeProviderRegistryMock(providers));
