import { NeoPiModelsError } from "@t3tools/contracts";
import {
  make as makeClient,
  type NeoPiRpcClientOptions,
  type NeoPiRpcClient,
  type UiRequestFrame,
} from "effect-neopi-rpc/client";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeNeoPiLoginUi } from "./NeoPiLoginUi.ts";

export interface NeoPiModelsConnection {
  readonly capabilities: ReadonlySet<string>;
  readonly request: NeoPiRpcClient["request"];
  readonly respondUi: NeoPiRpcClient["respondUi"];
  /** One login flow's UI frames, from now until the scope closes; see `makeNeoPiLoginUi`. */
  readonly loginUi: (
    loginId: string,
  ) => Effect.Effect<Stream.Stream<UiRequestFrame, NeoPiModelsError>, never, Scope.Scope>;
  readonly changes: Stream.Stream<void>;
  readonly validate: Effect.Effect<void, NeoPiModelsError>;
}

/**
 * The native process feeds graphical observers through a synchronous sink. Each observer
 * holds at most one pending change signal (the hub re-reads once per burst). Login UI goes
 * only to the flow it belongs to; with no follower nothing is kept.
 */
export const makeNeoPiModelsConnection = Effect.fn("NeoPiModelsConnection.make")(function* (
  options: Omit<NeoPiRpcClientOptions, "sink" | "onTransportReady">,
) {
  const changes = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
  const loginUi = makeNeoPiLoginUi();
  const client = yield* makeClient({
    ...options,
    sink: {
      event: (event) => {
        if (event.type === "models_configuration_changed" || event.type === "model_changed")
          PubSub.publishUnsafe(changes, undefined);
      },
      uiRequest: loginUi.publish,
    },
  });
  return {
    capabilities: client.capabilities,
    request: client.request,
    respondUi: client.respondUi,
    loginUi: loginUi.subscribe,
    changes: Stream.fromPubSub(changes),
    validate: Effect.void,
  } satisfies NeoPiModelsConnection;
});
