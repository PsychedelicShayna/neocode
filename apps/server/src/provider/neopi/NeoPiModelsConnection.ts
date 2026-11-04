import { NeoPiModelsError } from "@t3tools/contracts";
import {
  make as makeClient,
  type NeoPiRpcClient,
  type SpawnFn,
  type UiRequestFrame,
} from "effect-neopi-rpc/client";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import * as Stream from "effect/Stream";
import { parseNeoPiLaunchArguments } from "./NeoPiLaunchArgs.ts";

export interface NeoPiModelsConnection {
  readonly capabilities: ReadonlySet<string>;
  readonly request: NeoPiRpcClient["request"];
  readonly respondUi: NeoPiRpcClient["respondUi"];
  readonly ui: Stream.Stream<UiRequestFrame>;
  readonly changes: Stream.Stream<void>;
  readonly validate: Effect.Effect<void, NeoPiModelsError>;
}

/** Drain the native queues once, then fan out to graphical observers without competing readers. */
export const makeNeoPiModelsConnection = Effect.fn("NeoPiModelsConnection.make")(function* (
  client: NeoPiRpcClient,
) {
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const ui = yield* Effect.acquireRelease(PubSub.unbounded<UiRequestFrame>(), PubSub.shutdown);
  yield* client.events.pipe(
    Stream.runForEach((event) =>
      event.type === "models_configuration_changed" || event.type === "model_changed"
        ? PubSub.publish(changes, undefined)
        : Effect.void,
    ),
    Effect.forkScoped,
  );
  yield* client.uiRequests.pipe(
    Stream.runForEach((frame) => PubSub.publish(ui, frame)),
    Effect.forkScoped,
  );
  return {
    capabilities: client.capabilities,
    request: client.request,
    respondUi: client.respondUi,
    ui: Stream.fromPubSub(ui),
    changes: Stream.fromPubSub(changes),
    validate: Effect.void,
  } satisfies NeoPiModelsConnection;
});

/** Own only no-session configuration connections, cached by the actual configuration cwd. */
export const makeNeoPiConfigurationConnections = Effect.fn("NeoPiConfigurationConnections.make")(
  function* (options: {
    readonly binary: string;
    readonly environment: Record<string, string>;
    readonly profile: string;
    readonly launchArgs?: string;
    readonly spawn: SpawnFn;
  }) {
    const clients = yield* RcMap.make({
      lookup: (cwd: string) =>
        Effect.gen(function* () {
          const extra = yield* parseNeoPiLaunchArguments(options.launchArgs);
          const client = yield* makeClient({
            spawn: options.spawn,
            command: options.binary,
            cwd,
            env: {
              ...options.environment,
              ...(options.profile ? { OMP_PROFILE: options.profile } : {}),
            },
            args: [
              "--mode",
              "rpc-ui",
              "--cwd",
              cwd,
              "--no-session",
              "--no-tools",
              "--no-skills",
              "--no-rules",
              "--no-title",
              ...extra,
            ],
          });
          return yield* makeNeoPiModelsConnection(client);
        }).pipe(Effect.mapError((cause) => new NeoPiModelsError({ message: cause.message }))),
      idleTimeToLive: "30 seconds",
      capacity: 4,
    });
    return (cwd: string) => RcMap.get(clients, cwd);
  },
);
