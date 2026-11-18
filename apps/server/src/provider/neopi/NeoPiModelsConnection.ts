import { NeoPiModelsError } from "@t3tools/contracts";
import {
  make as makeClient,
  type NeoPiRpcClientOptions,
  type NeoPiRpcClient,
  type UiRequestFrame,
} from "effect-neopi-rpc/client";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export interface NeoPiModelsConnection {
  readonly capabilities: ReadonlySet<string>;
  readonly request: NeoPiRpcClient["request"];
  readonly respondUi: NeoPiRpcClient["respondUi"];
  readonly ui: Stream.Stream<UiRequestFrame>;
  readonly changes: Stream.Stream<void>;
  readonly validate: Effect.Effect<void, NeoPiModelsError>;
}

/** Login prompts are a handful per flow; a subscriber that stalls drops frames past this, never grows. */
const UI_BACKLOG = 64;

/**
 * The native process feeds graphical observers through a synchronous sink. Each observer
 * holds at most one pending change signal (the hub re-reads once per burst) and at most
 * `UI_BACKLOG` UI frames; with no observer nothing is kept.
 */
export const makeNeoPiModelsConnection = Effect.fn("NeoPiModelsConnection.make")(function* (
  options: Omit<NeoPiRpcClientOptions, "sink" | "onTransportReady">,
) {
  const changes = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
  const ui = yield* Effect.acquireRelease(
    PubSub.sliding<UiRequestFrame>(UI_BACKLOG),
    PubSub.shutdown,
  );
  const client = yield* makeClient({
    ...options,
    sink: {
      event: (event) => {
        if (event.type === "models_configuration_changed" || event.type === "model_changed")
          PubSub.publishUnsafe(changes, undefined);
      },
      uiRequest: (frame) => {
        PubSub.publishUnsafe(ui, frame);
      },
    },
  });
  return {
    capabilities: client.capabilities,
    request: client.request,
    respondUi: client.respondUi,
    ui: Stream.fromPubSub(ui),
    changes: Stream.fromPubSub(changes),
    validate: Effect.void,
  } satisfies NeoPiModelsConnection;
});
