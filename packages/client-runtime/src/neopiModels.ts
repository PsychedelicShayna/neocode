import { WS_METHODS, type NeoPiModelsConfiguration } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/unstable/reactivity";
import { EnvironmentSupervisor } from "./connection/supervisor.ts";
import type { EnvironmentRegistry } from "./connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./state/runtime.ts";

/** Web, desktop and mobile share the native contract; a reconnect clears the previous connection's snapshot. */
export function makeNeoPiModelsClientState<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
) {
  return {
    read: createEnvironmentRpcCommand(runtime, {
      label: "neopi-models:read",
      tag: WS_METHODS.neopiModelsRead,
    }),
    querySelector: createEnvironmentRpcCommand(runtime, {
      label: "neopi-models:query-selector",
      tag: WS_METHODS.neopiModelsQuerySelector,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "neopi-models:update",
      tag: WS_METHODS.neopiModelsUpdate,
    }),
    accounts: createEnvironmentRpcCommand(runtime, {
      label: "neopi-models:accounts",
      tag: WS_METHODS.neopiModelsAccounts,
    }),
    startAuth: createEnvironmentRpcCommand(runtime, {
      label: "neopi-models:auth-start",
      tag: WS_METHODS.neopiModelsAuthStart,
    }),
    respondAuth: createEnvironmentRpcCommand(runtime, {
      label: "neopi-models:auth-respond",
      tag: WS_METHODS.neopiModelsAuthRespond,
    }),
    cancelAuth: createEnvironmentRpcCommand(runtime, {
      label: "neopi-models:auth-cancel",
      tag: WS_METHODS.neopiModelsAuthCancel,
    }),
    authChanges: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "neopi-models:auth-watch",
      tag: WS_METHODS.neopiModelsAuthWatch,
      idleTtlMs: 0,
    }),
    changes: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "neopi-models:watch",
      tag: WS_METHODS.neopiModelsWatch,
      idleTtlMs: 0,
      transform: (stream) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const supervisor = yield* EnvironmentSupervisor;
            return SubscriptionRef.changes(supervisor.session).pipe(
              Stream.switchMap((session) => {
                const current = Option.getOrNull(session);
                return Stream.succeed({
                  session: current,
                  value: null as NeoPiModelsConfiguration | null,
                }).pipe(
                  Stream.concat(
                    current === null
                      ? Stream.empty
                      : stream.pipe(Stream.map((value) => ({ session: current, value }))),
                  ),
                );
              }),
              Stream.filterEffect((event) =>
                SubscriptionRef.get(supervisor.session).pipe(
                  Effect.map((session) => Option.getOrNull(session) === event.session),
                ),
              ),
              Stream.map((event) => event.value),
            );
          }),
        ),
    }),
  };
}
