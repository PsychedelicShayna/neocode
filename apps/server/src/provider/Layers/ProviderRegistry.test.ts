import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { mergeProviderSnapshot, ProviderRegistryLive, upsertProviderWorkspaceSnapshot } from "./ProviderRegistry.ts";

const driver = ProviderDriverKind.make("neopi");
const instanceId = ProviderInstanceId.make("neopi");
const checkedAt = "2026-10-22T00:00:00.000Z";
const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
const snapshot = (models: ServerProvider["models"] = []): ServerProvider => ({
  ...buildServerProvider({
    presentation: { displayName: "NeoPi" }, enabled: true, checkedAt, models, skills: [],
    probe: { installed: true, version: "1.0.0", status: "ready", auth: { status: "unknown" } },
  }),
  driver, instanceId,
});

it("uses the native inventory without resurrecting removed models", () => {
  const previous = snapshot([model("anthropic/old-model")]);
  const next = snapshot([model("openai-codex/current-model")]);
  assert.deepStrictEqual(mergeProviderSnapshot(previous, next).models, next.models);
  assert.deepStrictEqual(mergeProviderSnapshot(previous, snapshot()).models, []);
});

it("retains workspace-scoped commands without changing the native model inventory", () => {
  const previous = snapshot([model("openai-codex/current-model")]);
  const scoped = upsertProviderWorkspaceSnapshot(previous, "/workspace", {
    ...previous,
    slashCommands: [{ name: "project-command", description: "Project command" }],
  });
  const next = mergeProviderSnapshot(scoped, snapshot([model("anthropic/current-model")]));
  assert.deepStrictEqual(next.workspaceSnapshots, scoped.workspaceSnapshots);
  assert.deepStrictEqual(next.models, [model("anthropic/current-model")]);
});

it.effect("refreshes the same NeoPi instance without probing on registry construction", () => {
  let probes = 0;
  const initial = snapshot([model("openai-codex/current-model")]);
  const refreshed = snapshot([model("anthropic/current-model")]);
  const instance: ProviderInstance = {
    instanceId, driverKind: driver, enabled: true, displayName: "NeoPi",
    continuationIdentity: { driverKind: driver, continuationKey: "neopi:instance:neopi" },
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    snapshot: {
      getSnapshot: Effect.succeed(initial),
      refresh: Effect.sync(() => { probes += 1; return refreshed; }),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
  };
  const instances = Layer.mock(ProviderInstanceRegistry)({
    getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
    listInstances: Effect.succeed([instance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) => PubSub.subscribe(pubsub)),
  });
  const layer = ProviderRegistryLive.pipe(
    Layer.provide(instances),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "neopi-registry-" })),
    Layer.provide(NodeServices.layer),
  );
  return Effect.scoped(Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    assert.strictEqual(probes, 0);
    const providers = yield* registry.refreshInstance(instanceId);
    assert.strictEqual(probes, 1);
    assert.deepStrictEqual(providers.find((provider) => provider.instanceId === instanceId)?.models, refreshed.models);
  }).pipe(Effect.provide(layer)));
});
