import type {
  ProviderUsageLimitsUpdate,
  ServerProvider,
  ServerSettingsError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface ManagedServerProvider {
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly refreshUsage?: Effect.Effect<void, ServerSettingsError>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /** Merge windows by ID; updates with no usable window leave the snapshot untouched. */
  readonly applyUsageLimits: (
    update: ProviderUsageLimitsUpdate & { readonly checkedAt: string },
  ) => Effect.Effect<void>;
}
