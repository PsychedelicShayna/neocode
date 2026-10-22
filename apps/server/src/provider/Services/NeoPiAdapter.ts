import type { NeoPiSessionConfigurationResult, ThreadId } from "@t3tools/contracts";
import type { NeoPiJournalOptions } from "@t3tools/contracts";
import type { ReadResult } from "../neopi/NeoPiJournalReader.ts";
import type { NeoPiConfigurationIdentity } from "../neopi/NeoPiSessionConfiguration.ts";
import type { NeoPiNativeOwner } from "../neopi/NeoPiNativeOwner.ts";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import type { NeoPiModelsConnection } from "../neopi/NeoPiModelsConnection.ts";
import type { NeoPiModelsError } from "@t3tools/contracts";

/** Per-instance NeoPi/OMP JSONL RPC adapter contract. */
export interface NeoPiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
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
      readonly read: Effect.Effect<NeoPiSessionConfigurationResult, ProviderAdapterError>;
      readonly changes: Stream.Stream<void>;
    },
    never,
    Scope.Scope
  >;
  readonly getConfiguration: (
    threadId: ThreadId,
    expected: NeoPiConfigurationIdentity,
  ) => Effect.Effect<NeoPiSessionConfigurationResult, ProviderAdapterError>;
  readonly getLiveUsage: (
    activeProvider: string,
  ) => Effect.Effect<unknown | undefined, ProviderAdapterError>;
}
