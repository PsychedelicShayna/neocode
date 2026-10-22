import { NeoPiModelsError } from "@t3tools/contracts";
import type { NeoPiRpcClient, UiRequestFrame } from "effect-neopi-rpc/client";
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

/** Drain the native queues once, then fan out to graphical observers without competing readers. */
export const makeNeoPiModelsConnection = Effect.fn("NeoPiModelsConnection.make")(function* (client: NeoPiRpcClient) {
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const ui = yield* Effect.acquireRelease(PubSub.unbounded<UiRequestFrame>(), PubSub.shutdown);
  yield* client.events.pipe(Stream.runForEach(event => event.type === "models_configuration_changed" || event.type === "themes_configuration_changed" || event.type === "model_changed" ? PubSub.publish(changes, undefined) : Effect.void), Effect.forkScoped);
  yield* client.uiRequests.pipe(Stream.runForEach(frame => PubSub.publish(ui, frame)), Effect.forkScoped);
  return {
    capabilities: client.capabilities, request: client.request, respondUi: client.respondUi,
    ui: Stream.fromPubSub(ui), changes: Stream.fromPubSub(changes),
    validate: Effect.void,
  } satisfies NeoPiModelsConnection;
});
