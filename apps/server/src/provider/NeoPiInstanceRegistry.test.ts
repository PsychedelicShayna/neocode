import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { NeoPiDriver } from "./Drivers/NeoPiDriver.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

const layerDependencies = ServerConfig.layerTest(process.cwd(), {
  prefix: "neopi-only-registry-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("Registry discovery must not start a harness")),
    ),
  ),
  Layer.provideMerge(
    Layer.mock(SecretResolver.SecretResolver)({
      read: () => Effect.die("Disabled and retired instances must not read credentials"),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);

const testLayer = ProviderHostLive.layer.pipe(
  Layer.provideMerge(McpSessionRegistryTestkit.layerNative),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(layerDependencies),
);

it.layer(testLayer)("NeoPi-only registry", (it) => {
  it.effect("keeps separate NeoPi instances and marks old runtimes unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const personalId = ProviderInstanceId.make("neopi-personal");
        const workId = ProviderInstanceId.make("neopi-work");
        const oldDrivers = ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"];
        const configMap = {
          [personalId]: {
            driver: NeoPiDriver.driverKind,
            enabled: false,
            config: { profile: "personal" },
          },
          [workId]: { driver: NeoPiDriver.driverKind, enabled: false, config: { profile: "work" } },
          ...Object.fromEntries(
            oldDrivers.map((driver) => [
              driver,
              {
                driver: ProviderDriverKind.make(driver),
                enabled: true,
                config: { binaryPath: "must-not-run" },
              },
            ]),
          ),
        };
        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: BUILT_IN_DRIVERS,
          configMap,
        });
        const instances = yield* registry.listInstances;
        expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
          [personalId, workId].toSorted(),
        );
        expect(instances.every((instance) => instance.driverKind === "neopi")).toBe(true);
        const unavailable = yield* registry.listUnavailable;
        expect(unavailable.map((snapshot) => snapshot.driver).toSorted()).toEqual(
          oldDrivers.toSorted(),
        );
        expect(
          unavailable.every(
            (snapshot) => snapshot.availability === "unavailable" && !snapshot.enabled,
          ),
        ).toBe(true);
        expect(configMap[ProviderInstanceId.make("codex")]).toMatchObject({
          config: { binaryPath: "must-not-run" },
        });
        expect(yield* registry.getInstance(ProviderInstanceId.make("codex"))).toBeUndefined();
      }),
    ),
  );

  it.effect("does not let an obsolete explicit selection suppress the NeoPi default", () =>
    Effect.scoped(
      Effect.sync(() => {
        const legacy = {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: { homePath: "/saved/claude", customModels: ["saved-model"] },
        };
        const settings = {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: { [ProviderInstanceId.make("legacy")]: legacy },
        };
        const configMap = deriveProviderInstanceConfigMap(settings);
        expect(configMap[ProviderInstanceId.make("legacy")]).toEqual(legacy);
        expect(configMap[ProviderInstanceId.make("neopi")]?.driver).toBe("neopi");
        expect(Object.values(configMap).filter((entry) => entry.driver !== "neopi")).toEqual([
          legacy,
        ]);
        expect(settings.providerInstances.legacy).toEqual(legacy);
      }),
    ),
  );
});
