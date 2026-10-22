import { WS_METHODS, type NeoPiThemesConfiguration } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/unstable/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

export function createNeoPiThemesState<R, ER>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>) {
  const update = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:neopi-themes:update", tag: WS_METHODS.neopiThemesUpdate,
  });
  const watch = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:neopi-themes:watch", tag: WS_METHODS.neopiThemesWatch,
    idleTtlMs: 30_000,
    transform: stream => Stream.unwrap(Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      return SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(session => {
          const current = Option.getOrNull(session);
          const initial = Stream.succeed({ session: current, result: null as NeoPiThemesConfiguration | null });
          return current === null ? initial : initial.pipe(Stream.concat(
            stream.pipe(Stream.map(result => ({ session: current, result }))),
          ));
        }),
        Stream.filterEffect(event => SubscriptionRef.get(supervisor.session).pipe(
          Effect.map(session => Option.getOrNull(session) === event.session),
        )),
        Stream.map(event => event.result),
      );
    })),
  });
  return { update, watch };
}
