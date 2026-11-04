import type { ProviderInstance } from "../ProviderDriver.ts";
import type { NeoPiModelsError } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";

/** Last completed handshake, retained while refresh is in flight or fails. */
export interface NeoPiCapabilityProbe {
  status: "unprobed" | "compatible" | "unsupported";
  version: string | null;
  failure?: string;
}

export interface NeoPiSessionCatalogSource {
  readonly binary: string;
  readonly env: Record<string, string>;
  readonly profile: string;
  readonly launchArgs?: string;
  /** The same mutable capability set refreshed by the driver's RPC probe. */
  readonly capabilities: ReadonlySet<string>;
  readonly probe: NeoPiCapabilityProbe;
  /** Scoped configuration-only native process; never a SQL thread/session binding. */
  readonly modelsConnection?: (
    cwd: string,
  ) => Effect.Effect<NeoPiModelsConnection, NeoPiModelsError, Scope.Scope>;
}

const sources = new WeakMap<ProviderInstance, NeoPiSessionCatalogSource>();

export function registerNeoPiSessionCatalogSource<T extends ProviderInstance>(
  instance: T,
  source: NeoPiSessionCatalogSource,
): T {
  sources.set(instance, source);
  return instance;
}

export const neoPiSessionCatalogSource = (instance: ProviderInstance) => sources.get(instance);

export const unregisterNeoPiSessionCatalogSource = (instance: ProviderInstance): void => {
  sources.delete(instance);
};
