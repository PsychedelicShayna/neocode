import {
  WS_METHODS,
  type EnvironmentId,
  type NeoPiModelsConfiguration,
  type NeoPiModelsTarget,
} from "@t3tools/contracts";
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

/** A missing native catalog limit is unknown, not a zero-token capability. */
export function formatNeoPiModelTokenLimit(value: number | null): string {
  return value === null ? "Unknown" : value.toLocaleString();
}

/**
 * The last configuration each native source delivered. A reopened Models page shows it at once,
 * read-only, while the live stream revalidates. Memory-only and small: one entry is several MB.
 */
const LAST_SNAPSHOT_LIMIT = 3;
const lastSnapshots = new Map<string, NeoPiModelsConfiguration>();

export const neopiModelsSnapshotKey = (environmentId: EnvironmentId, target: NeoPiModelsTarget) =>
  JSON.stringify([
    environmentId,
    target.providerInstanceId,
    target.projectId ?? null,
    target.sessionFile ?? null,
    target.threadId ?? null,
  ]);

export function rememberNeoPiModelsConfiguration(
  key: string,
  configuration: NeoPiModelsConfiguration,
): void {
  lastSnapshots.delete(key);
  lastSnapshots.set(key, configuration);
  for (const oldest of lastSnapshots.keys()) {
    if (lastSnapshots.size <= LAST_SNAPSHOT_LIMIT) break;
    lastSnapshots.delete(oldest);
  }
}

export function recallNeoPiModelsConfiguration(key: string): NeoPiModelsConfiguration | undefined {
  return lastSnapshots.get(key);
}

/** Keep authored selectors intact: catalog refreshes must not turn patterns into resolved model IDs. */
export function getNeoPiModelsSelectorOptions(
  configuration: NeoPiModelsConfiguration,
  retainedSelector: string,
) {
  const entries = new Map<string, { label: string; detail: string }>();
  const preserve = (selector: string | null) => {
    if (selector && !entries.has(selector))
      entries.set(selector, { label: selector, detail: "Saved native selector" });
  };
  for (const model of configuration.models) {
    entries.set(`${model.provider}/${model.id}`, {
      label: model.name,
      detail: `${model.provider} · ${model.id}${model.available ? "" : " · Not available"}`,
    });
  }
  for (const role of configuration.roles) {
    entries.set(role.alias, { label: role.alias, detail: role.description ?? role.alias });
    preserve(role.configured);
    preserve(role.global.selector);
    preserve(role.project.selector);
  }
  for (const rules of [
    configuration.effortRules,
    configuration.effortRuleScopes.global,
    configuration.effortRuleScopes.project,
  ])
    for (const rule of rules ?? []) preserve(rule.selector);
  preserve(retainedSelector);
  return entries;
}

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
    // Keep a pending native login through transient observer teardown: closing
    // its only watch cancels the one-shot login and removes its flow ID.
    authChanges: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "neopi-models:auth-watch",
      tag: WS_METHODS.neopiModelsAuthWatch,
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
