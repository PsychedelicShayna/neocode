import { WS_METHODS, type NeoPiSessionConfigurationResult } from "@t3tools/contracts";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../connection/runtime";

export const neopiSessionList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:neopi-sessions:list",
  tag: WS_METHODS.neopiSessionsList,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

export const neopiSessionResume = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:neopi-sessions:resume",
  tag: WS_METHODS.neopiSessionsResume,
});

export const neopiSessionHandoff = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:neopi-sessions:handoff",
  tag: WS_METHODS.neopiSessionsHandoff,
});

export const neopiSessionConfiguration = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:neopi-sessions:configuration",
  tag: WS_METHODS.neopiSessionsConfiguration,
});

export const neopiSessionJournal = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:neopi-sessions:journal",
  tag: WS_METHODS.neopiSessionsJournal,
});

export const neopiSessionConfigurationChanges = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:neopi-sessions:configuration-changes",
    tag: WS_METHODS.neopiSessionsWatchConfiguration,
    idleTtlMs: 0,
    transform: (stream) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          return SubscriptionRef.changes(supervisor.session).pipe(
            Stream.switchMap((session) => {
              const currentSession = Option.getOrNull(session);
              const initialResult: NeoPiSessionConfigurationResult | null =
                currentSession === null
                  ? {
                      status: "unavailable",
                      reason: "The environment is disconnected. Reconnect to follow model changes.",
                    }
                  : null;
              const initial = Stream.succeed({ session: currentSession, result: initialResult });
              return currentSession === null
                ? initial
                : initial.pipe(
                    Stream.concat(
                      stream.pipe(Stream.map((result) => ({ session: currentSession, result }))),
                    ),
                  );
            }),
            // Durable subscriptions wait through transport loss. Clear their last
            // snapshot and reject values buffered across a transport replacement.
            Stream.filterEffect((event) =>
              SubscriptionRef.get(supervisor.session).pipe(
                Effect.map((session) => Option.getOrNull(session) === event.session),
              ),
            ),
            Stream.map((event) => event.result),
          );
        }),
      ),
  },
);
