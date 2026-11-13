import type {
  NeoPiJournalOptions,
  NeoPiModelsError,
  NeoPiSessionConfigurationResult,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { ReadResult } from "./NeoPiJournalReader.ts";
import type { NeoPiConfigurationIdentity } from "./NeoPiSessionConfiguration.ts";
import type { NeoPiNativeOwner } from "./NeoPiNativeOwner.ts";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";
import type { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";

export type NeoPiAdapterShape = ProviderAdapterV2["Service"] & {
  readonly observeNative?: (
    threadId: ThreadId,
  ) => Effect.Effect<NeoPiNativeOwner | undefined, never, Scope.Scope>;
  readonly readJournal?: (
    threadId: ThreadId,
    expected: NeoPiConfigurationIdentity,
    options: NeoPiJournalOptions,
  ) => Effect.Effect<ReadResult | undefined>;
  readonly getModelsConnection: (
    cwd: string,
    threadId?: ThreadId,
    expected?: NeoPiConfigurationIdentity,
  ) => Effect.Effect<NeoPiModelsConnection, NeoPiModelsError, Scope.Scope>;
  readonly observeConfiguration: (
    threadId: ThreadId,
    expected: NeoPiConfigurationIdentity,
  ) => Effect.Effect<
    {
      readonly read: Effect.Effect<NeoPiSessionConfigurationResult, NeoPiRuntimeError>;
      readonly changes: Stream.Stream<void>;
    },
    never,
    Scope.Scope
  >;
  readonly getConfiguration: (
    threadId: ThreadId,
    expected: NeoPiConfigurationIdentity,
  ) => Effect.Effect<NeoPiSessionConfigurationResult, NeoPiRuntimeError>;
  readonly getLiveUsage: (
    activeProvider: string,
  ) => Effect.Effect<unknown | undefined, NeoPiRuntimeError>;
};
