import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert, expect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsError,
  ServerProvider,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { deepMerge } from "@t3tools/shared/Struct";
import { createModelCapabilities } from "@t3tools/shared/model";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderInstanceRegistryHydration from "./ProviderInstanceRegistryHydration.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import {
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const decodeServerProvider = Schema.decodeSync(ServerProvider);
const encodeServerProvider = Schema.encodeSync(ServerProvider);
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodedDefaultServerSettings = encodeServerSettings(DEFAULT_SERVER_SETTINGS);

const disabledDefaultSlots = (
  ...drivers: ReadonlyArray<string>
): ContractServerSettings["providerInstances"] =>
  Object.fromEntries(
    drivers.map((driver) => [
      ProviderInstanceId.make(driver),
      { driver: ProviderDriverKind.make(driver), enabled: false },
    ]),
  );

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const layerUnusedMutator = Layer.mock(
  ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
)({});

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const layerBackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function makeMutableServerSettingsService(
  initial: ContractServerSettings = DEFAULT_SERVER_SETTINGS,
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const resolved = typeof patch === "function" ? patch(current) : patch;
          if (resolved === null) return current;
          const next = applyServerSettingsPatch(current, resolved);
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      updateProviderInstance: (mutation, patch = {}) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = ServerSettingsModule.applyProviderInstanceMutation(
            applyServerSettingsPatch(current, patch),
            mutation,
          );
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      withSettingsSnapshot: (use) => Ref.get(settingsRef).pipe(Effect.flatMap(use)),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        );
      },
    } satisfies ServerSettingsModule.ServerSettingsService["Service"];
  });
}

const awaitPersistedProvider = (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  checkedAt: string,
) =>
  registry.streamChanges.pipe(
    Stream.filter((providers) => providers.some((provider) => provider.checkedAt === checkedAt)),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped({ startImmediately: true }),
  );

const layerTestNodeServices = Layer.mergeAll(
  ProviderLatestVersions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
  }),
  // Probes must never read credentials from the developer's home.
  Layer.effect(
    HostProcess.HomeDirectory,
    Effect.gen(function* () {
      return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    }),
  ).pipe(Layer.provide(NodeServices.layer)),
);

it.layer(
  Layer.mergeAll(layerTestNodeServices, ServerSettingsModule.layerTest(), layerTestHttpClient),
)("ProviderRegistry", (it) => {
  describe("ProviderRegistry.layer", () => {
    it("stores workspace skills, commands and options without changing machine metadata", () => {
      const provider = {
        instanceId: ProviderInstanceId.make("neopi"),
        driver: ProviderDriverKind.make("neopi"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-03-25T00:00:00.000Z",
        version: "1.0.0",
        models: [],
        slashCommands: [{ name: "global" }],
        skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
      } satisfies ServerProvider;
      const scopedSnapshot = {
        ...provider,
        checkedAt: "2026-03-25T00:01:00.000Z",
        slashCommands: [{ name: "project" }],
        skills: [{ name: "project", path: "/project/SKILL.md", enabled: true }],
        optionDescriptors: [
          {
            id: "agent",
            label: "Agent",
            type: "select",
            options: [{ id: "readonly", label: "Readonly" }],
          },
        ],
      } satisfies ProviderWorkspaceSnapshot;

      const result = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        provider,
        "/project",
        scopedSnapshot,
      );

      assert.deepStrictEqual(result.slashCommands, provider.slashCommands);
      assert.deepStrictEqual(result.skills, provider.skills);
      assert.strictEqual(result.models, provider.models);
      const decoded = decodeServerProvider(encodeServerProvider(result));
      assert.deepStrictEqual(decoded.workspaceSnapshots, [
        {
          cwd: "/project",
          checkedAt: scopedSnapshot.checkedAt,
          slashCommands: scopedSnapshot.slashCommands,
          skills: scopedSnapshot.skills,
          optionDescriptors: scopedSnapshot.optionDescriptors,
        },
      ]);

      const pendingSnapshot = {
        ...scopedSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND],
        slashCommandsPending: true,
      } satisfies ProviderWorkspaceSnapshot;
      const partial = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        result,
        "/project",
        pendingSnapshot,
      );
      assert.deepStrictEqual(partial.workspaceSnapshots?.[0]?.slashCommands, [{ name: "project" }]);
      assert.strictEqual(partial.workspaceSnapshots?.[0]?.slashCommandsPending, true);
      const otherProject = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        partial,
        "/other-project",
        pendingSnapshot,
      );
      assert.deepStrictEqual(otherProject.workspaceSnapshots?.[1]?.slashCommands, [
        COMPACT_SLASH_COMMAND,
      ]);
      const recovered = ProviderRegistry.upsertProviderWorkspaceSnapshot(partial, "/project", {
        ...scopedSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND, { name: "replacement" }],
      });
      assert.deepStrictEqual(recovered.workspaceSnapshots?.[0]?.slashCommands, [
        COMPACT_SLASH_COMMAND,
        { name: "replacement" },
      ]);
      assert.strictEqual(recovered.workspaceSnapshots?.[0]?.slashCommandsPending, undefined);

      const { optionDescriptors, ...failedSnapshot } = scopedSnapshot;
      const firstFailure = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        provider,
        "/project",
        failedSnapshot,
      );
      assert.strictEqual(
        Object.hasOwn(firstFailure.workspaceSnapshots![0]!, "optionDescriptors"),
        false,
      );
      const failedOtherProject = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        recovered,
        "/other-project",
        failedSnapshot,
      );
      assert.strictEqual(
        Object.hasOwn(failedOtherProject.workspaceSnapshots![1]!, "optionDescriptors"),
        false,
      );

      for (const clearedDescriptors of [[], [{ ...optionDescriptors[0]!, options: [] }]]) {
        const cleared = ProviderRegistry.upsertProviderWorkspaceSnapshot(recovered, "/project", {
          ...scopedSnapshot,
          optionDescriptors: clearedDescriptors,
        });
        assert.deepStrictEqual(
          cleared.workspaceSnapshots?.[0]?.optionDescriptors,
          clearedDescriptors,
        );
      }

      const failedRefresh = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        failedOtherProject,
        "/project",
        failedSnapshot,
      );
      assert.deepStrictEqual(
        failedRefresh.workspaceSnapshots?.[1]?.optionDescriptors,
        optionDescriptors,
      );
    });

    it("replaces and clears native inventory without losing workspace commands", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("neopi"),
        driver: ProviderDriverKind.make("neopi"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "unknown" },
        checkedAt: "2026-10-22T00:00:00.000Z",
        version: "1.0.0",
        models: [
          {
            slug: "anthropic/old-model",
            name: "Old model",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const scoped = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        previousProvider,
        "/workspace",
        {
          ...previousProvider,
          slashCommands: [{ name: "project-command", description: "Project command" }],
        },
      );
      const nextProvider = {
        ...previousProvider,
        checkedAt: "2026-10-22T00:01:00.000Z",
        models: [
          {
            slug: "openai-codex/current-model",
            name: "Current model",
            isCustom: false,
            capabilities: null,
          },
        ],
      } satisfies ServerProvider;
      const refreshed = ProviderRegistry.mergeProviderSnapshot(scoped, nextProvider);
      assert.deepStrictEqual(refreshed.models, nextProvider.models);
      assert.deepStrictEqual(refreshed.workspaceSnapshots, scoped.workspaceSnapshots);
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(refreshed, { ...nextProvider, models: [] }).models,
        [],
      );
    });

    describe("native model inventories", () => {
      const cachedProvider = {
        instanceId: ProviderInstanceId.make("neopi-personal"),
        driver: ProviderDriverKind.make("neopi"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-09-04T19:00:00.000Z",
        version: "0.153.3",
        models: ["vega-alpha", "joule-alpha", "kindle-alpha", "ultima-alpha", "solstice-alpha"].map(
          (slug) => ({ slug, name: slug, isCustom: false, capabilities: null }),
        ),
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
      const customModel = {
        slug: "custom-model",
        name: "Custom model",
        isCustom: true,
        capabilities: null,
      } as const;
      const refreshedProvider = {
        ...cachedProvider,
        checkedAt: "2026-09-04T19:01:00.000Z",
        models: [
          { slug: "gpt-6-astra", name: "GPT 6 Astra", isCustom: false, capabilities: null },
          cachedProvider.models[0]!,
          customModel,
        ],
      } satisfies ServerProvider;
      const pendingProvider = {
        ...cachedProvider,
        status: "warning",
        installed: false,
        auth: { status: "unknown" },
        models: [customModel],
      } satisfies ServerProvider;
      const failedProvider = {
        ...pendingProvider,
        checkedAt: "2026-09-04T19:02:00.000Z",
        status: "error",
        installed: true,
      } satisfies ServerProvider;

      it.effect("persists removals across failed refreshes and registry restarts", () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: cachedProvider.instanceId,
          });
          yield* writeProviderStatusCache({ filePath, provider: cachedProvider });
          const nextProvider = yield* Ref.make<ServerProvider>(refreshedProvider);
          const currentProvider = yield* Ref.make<ServerProvider>(pendingProvider);
          const instance = {
            instanceId: cachedProvider.instanceId,
            driverKind: cachedProvider.driver,
            continuationIdentity: {
              driverKind: cachedProvider.driver,
              continuationKey: "neopi:instance:neopi-personal",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              getSnapshot: Ref.get(currentProvider),
              refresh: Ref.get(nextProvider).pipe(
                Effect.tap((provider) => Ref.set(currentProvider, provider)),
              ),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const layerInstanceRegistry = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (id) =>
                Effect.succeed(id === instance.instanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            },
          );
          for (const restarted of [false, true]) {
            yield* Ref.set(currentProvider, pendingProvider);
            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              assert.deepStrictEqual(
                (yield* registry.getProviders)[0]?.models,
                pendingProvider.models,
              );

              yield* registry.refreshInstance(instance.instanceId);
              assert.deepStrictEqual(
                (yield* readProviderStatusCache(filePath))?.models,
                restarted ? failedProvider.models : refreshedProvider.models,
              );

              yield* Ref.set(nextProvider, failedProvider);
              const afterFailure = yield* registry.refreshInstance(instance.instanceId);
              assert.deepStrictEqual(afterFailure[0]?.models, failedProvider.models);
              assert.deepStrictEqual(
                (yield* readProviderStatusCache(filePath))?.models,
                failedProvider.models,
              );
            }).pipe(
              Effect.provide(
                ProviderRegistry.layer.pipe(
                  Layer.provide(layerInstanceRegistry),
                  Layer.provide(layerUnusedMutator),
                ),
              ),
              Effect.scoped,
            );
          }
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-native-model-cache-",
            }).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
          ),
        ),
      );
    });

    describe("cleared native inventories", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("antigravity-personal"),
        driver: ProviderDriverKind.make("neopi"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-09-02T00:00:00.000Z",
        version: "0.1.3",
        models: [
          {
            slug: "gemini-3.1-pro-high",
            name: "Gemini 3.1 Pro High",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "gemini-3-flash",
            name: "Gemini 3 Flash",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;

      it("clears models after sign-out, disable, uninstall, or an empty successful refresh", () => {
        const emptyProvider = {
          ...previousProvider,
          checkedAt: "2026-09-02T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;
        const clearedProviders = [
          { ...emptyProvider, status: "warning", auth: { status: "unauthenticated" } },
          { ...emptyProvider, status: "error", auth: { status: "unauthenticated" } },
          { ...emptyProvider, status: "disabled", enabled: false },
          { ...emptyProvider, status: "error", enabled: false },
          { ...emptyProvider, status: "error", installed: false, auth: { status: "unknown" } },
          emptyProvider,
        ] satisfies ReadonlyArray<ServerProvider>;

        for (const provider of clearedProviders) {
          const afterRemoval = ProviderRegistry.mergeProviderSnapshot(previousProvider, provider);
          assert.deepStrictEqual(afterRemoval.models, []);

          const afterFailure = ProviderRegistry.mergeProviderSnapshot(afterRemoval, {
            ...emptyProvider,
            status: "error",
            auth: { status: "unknown" },
          });
          assert.deepStrictEqual(afterFailure.models, []);
        }
      });
    });

    it.effect(
      "a second request for a cwd being scanned gets its result, even if the first leaves",
      () =>
        Effect.gen(function* () {
          const driver = ProviderDriverKind.make("neopi");
          const instanceId = ProviderInstanceId.make("neopi");
          const provider = {
            instanceId,
            driver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const scanStarted = yield* Deferred.make<void>();
          const releaseScan = yield* Deferred.make<void>();
          const scans = yield* Ref.make(0);
          const instance: ProviderInstance = {
            instanceId,
            driverKind: driver,
            continuationIdentity: { driverKind: driver, continuationKey: "codex:instance:codex" },
            displayName: undefined,
            enabled: true,
            snapshot: {
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            snapshotForCwd: () =>
              Ref.update(scans, (count) => count + 1).pipe(
                Effect.andThen(Deferred.succeed(scanStarted, undefined)),
                Effect.andThen(Deferred.await(releaseScan)),
                Effect.as(provider),
              ),
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          };
          const layerInstanceRegistry = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (requestedId) =>
                Effect.succeed(requestedId === instanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistry.layer.pipe(
              Layer.provide(layerUnusedMutator),
              Layer.provideMerge(layerInstanceRegistry),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-shared-workspace-scan-",
                }),
              ),
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const refresh = registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
            const first = yield* Effect.forkChild(refresh);
            yield* Deferred.await(scanStarted);
            const second = yield* Effect.forkChild(refresh, { startImmediately: true });
            yield* Fiber.interrupt(first);
            yield* Deferred.succeed(releaseScan, undefined);
            assert.deepStrictEqual(
              (yield* Fiber.join(second))[0]?.workspaceSnapshots?.map((snapshot) => snapshot.cwd),
              ["/workspace"],
            );
            assert.strictEqual(yield* Ref.get(scans), 1);
          }).pipe(Effect.provide(runtimeServices));
        }),
    );

    it.effect("publishes workspace skills while machine health is in error", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("neopi");
        const instanceId = ProviderInstanceId.make("neopi");
        const healthyProvider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [COMPACT_SLASH_COMMAND],
          skills: [],
        } as const satisfies ServerProvider;
        const unhealthyProvider = {
          ...healthyProvider,
          status: "error",
          auth: { status: "unknown" },
          message: "Native provider discovery failed: unauthorized (401).",
          slashCommands: [],
        } as const satisfies ServerProvider;
        const firstSkills = [{ name: "first", path: "/workspace/first/SKILL.md", enabled: true }];
        const laterSkills = [{ name: "later", path: "/workspace/later/SKILL.md", enabled: true }];
        const scanResult = yield* Ref.make<ProviderWorkspaceSnapshot>({
          ...healthyProvider,
          skills: firstSkills,
        });
        const instance: ProviderInstance = {
          instanceId,
          driverKind: driver,
          continuationIdentity: { driverKind: driver, continuationKey: "codex:instance:codex" },
          displayName: undefined,
          enabled: true,
          snapshot: {
            getSnapshot: Effect.succeed(unhealthyProvider),
            refresh: Effect.succeed(unhealthyProvider),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          snapshotForCwd: () => Ref.get(scanResult),
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        };
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (requestedId) =>
              Effect.succeed(requestedId === instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provide(layerUnusedMutator),
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-unhealthy-workspace-",
              }),
            ),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const workspaceOf = Effect.map(
            registry.getProviders,
            (providers) => providers[0]?.workspaceSnapshots?.[0],
          );
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.deepStrictEqual((yield* workspaceOf)?.slashCommands, [COMPACT_SLASH_COMMAND]);

          yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS);
          yield* Ref.set(scanResult, { ...unhealthyProvider, skills: laterSkills });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const unhealthy = yield* workspaceOf;
          assert.deepStrictEqual(unhealthy?.skills, laterSkills);
          assert.deepStrictEqual(unhealthy?.slashCommands, [COMPACT_SLASH_COMMAND]);
          assert.strictEqual(unhealthy?.slashCommandsPending, true);
          const provider = (yield* registry.getProviders)[0];
          assert.strictEqual(provider?.status, "error");
          assert.strictEqual(provider?.message, unhealthyProvider.message);

          yield* Ref.set(scanResult, { ...unhealthyProvider, skills: [] });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.deepStrictEqual((yield* workspaceOf)?.skills, []);

          const discoveredCommand = { name: "review", description: "Review changes" };
          yield* Ref.set(scanResult, {
            ...unhealthyProvider,
            slashCommands: [discoveredCommand],
            slashCommandsPending: false,
          });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const discovered = yield* workspaceOf;
          assert.deepStrictEqual(discovered?.slashCommands, [discoveredCommand]);
          assert.strictEqual(discovered?.slashCommandsPending, undefined);

          yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS);
          yield* Ref.set(scanResult, { ...healthyProvider, skills: laterSkills });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const recovered = yield* workspaceOf;
          assert.deepStrictEqual(recovered?.skills, laterSkills);
          assert.deepStrictEqual(recovered?.slashCommands, [COMPACT_SLASH_COMMAND]);
          assert.strictEqual(recovered?.slashCommandsPending, undefined);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("shares one in-flight pass between concurrent untargeted refreshes", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("neopi");
        const instanceId = ProviderInstanceId.make("neopi");
        const provider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshCalls = yield* Ref.make(0);
        const probeStarted = yield* Deferred.make<void>();
        const releaseProbe = yield* Deferred.make<void>();
        const instances = [
          {
            instanceId,
            driverKind: driver,
            continuationIdentity: { driverKind: driver, continuationKey: "codex:instance:codex" },
            displayName: undefined,
            enabled: true,
            snapshot: {
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.gen(function* () {
                yield* Ref.update(refreshCalls, (count) => count + 1);
                yield* Deferred.succeed(probeStarted, undefined);
                yield* Deferred.await(releaseProbe);
                return provider;
              }),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          },
        ] satisfies ReadonlyArray<ProviderInstance>;
        const instanceRegistryLayer = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (requestedId) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === requestedId)),
            listInstances: Effect.succeed(instances),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provide(layerUnusedMutator),
            Layer.provideMerge(instanceRegistryLayer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-shared-refresh-",
              }),
            ),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const first = yield* registry.refresh().pipe(Effect.forkChild);
          yield* Deferred.await(probeStarted);
          const second = yield* registry
            .refresh()
            .pipe(Effect.forkChild({ startImmediately: true }));
          assert.strictEqual(yield* Ref.get(refreshCalls), 1);
          yield* Deferred.succeed(releaseProbe, undefined);
          expect(yield* Fiber.join(first)).toEqual([expect.objectContaining(provider)]);
          expect(yield* Fiber.join(second)).toEqual([expect.objectContaining(provider)]);
          assert.strictEqual(yield* Ref.get(refreshCalls), 1);

          yield* registry.refresh();
          assert.strictEqual(yield* Ref.get(refreshCalls), 2);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("ignores a probe from an instance that settings replaced mid-refresh", () =>
      Effect.gen(function* () {
        const scenario = Effect.fn(function* (
          probeFails: boolean,
          run: (
            registry: ProviderRegistry.ProviderRegistry["Service"],
          ) => Effect.Effect<ReadonlyArray<ServerProvider>>,
        ) {
          const driver = ProviderDriverKind.make("neopi");
          const instanceId = ProviderInstanceId.make("neopi");
          const provider = {
            instanceId,
            driver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: "2.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const retiredProbe = {
            ...provider,
            status: "error",
            installed: false,
            version: "1.0.0",
            message: "The native executable is not installed.",
          } as const satisfies ServerProvider;
          const probeStarted = yield* Deferred.make<void>();
          const releaseProbe = yield* Deferred.make<void>();
          const makeInstance = (snapshot: ServerProvider, refresh: Effect.Effect<void>) =>
            ({
              instanceId,
              driverKind: driver,
              continuationIdentity: { driverKind: driver, continuationKey: "codex:instance:codex" },
              displayName: undefined,
              enabled: true,
              snapshot: {
                getSnapshot: Effect.succeed(snapshot),
                refresh: Effect.as(refresh, snapshot),
                streamChanges: Stream.empty,
                applyUsageLimits: () => Effect.void,
              },
              orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            }) satisfies ProviderInstance;
          const retiredInstance = makeInstance(
            retiredProbe,
            Deferred.succeed(probeStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseProbe)),
              Effect.andThen(probeFails ? Effect.die(new Error("probe failed")) : Effect.void),
            ),
          );
          const rebuiltInstance = makeInstance(provider, Effect.void);
          const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([retiredInstance]);
          const changes = yield* PubSub.unbounded<void>();
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (requestedId) =>
                Ref.get(instances).pipe(
                  Effect.map((current) =>
                    current.find((instance) => instance.instanceId === requestedId),
                  ),
                ),
              listInstances: Ref.get(instances),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: PubSub.subscribe(changes),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistry.layer.pipe(
              Layer.provide(layerUnusedMutator),
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-retired-refresh-",
                }),
              ),
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ).pipe(Scope.provide(scope));

          return yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const rebuiltPublished = yield* Stream.toPull(
              registry.streamChanges.pipe(
                Stream.filter((providers) => providers[0]?.version === provider.version),
              ),
            );
            const refresh = yield* run(registry).pipe(Effect.forkChild);
            yield* Deferred.await(probeStarted);
            yield* Ref.set(instances, [rebuiltInstance]);
            yield* PubSub.publish(changes, undefined);
            yield* rebuiltPublished;
            yield* Deferred.succeed(releaseProbe, undefined);
            return {
              provider,
              result: yield* Fiber.join(refresh),
              providers: yield* registry.getProviders,
            };
          }).pipe(Effect.provide(runtimeServices));
        });
        const instanceId = ProviderInstanceId.make("neopi");

        for (const probeFails of [true, false]) {
          const refreshed = yield* scenario(probeFails, (registry) =>
            registry.refreshInstance(instanceId),
          );
          expect(refreshed.result).toEqual([expect.objectContaining(refreshed.provider)]);
          expect(refreshed.providers).toEqual([expect.objectContaining(refreshed.provider)]);
        }
      }),
    );

    it.effect("keeps an enriched snapshot that streams in before a manual refresh returns", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("neopi");
        const instanceId = ProviderInstanceId.make("gemini");
        const initialProvider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const pendingProvider = {
          ...initialProvider,
          status: "warning",
          auth: { status: "unknown" },
          checkedAt: "2026-06-10T00:01:00.000Z",
          message: "Checking native model discovery in the background...",
        } as const satisfies ServerProvider;
        const enrichedProvider = {
          ...initialProvider,
          status: "error",
          auth: { status: "unauthenticated" },
          checkedAt: "2026-06-10T00:01:01.000Z",
          message: "Native account authentication is required.",
        } as const satisfies ServerProvider;
        const snapshotRef = yield* Ref.make<ServerProvider>(initialProvider);
        const changes = yield* PubSub.unbounded<ServerProvider>();
        const publishSnapshot = (provider: ServerProvider) =>
          Ref.set(snapshotRef, provider).pipe(Effect.andThen(PubSub.publish(changes, provider)));
        const releaseRefresh = yield* Deferred.make<void>();
        const instance = {
          instanceId,
          driverKind: driver,
          continuationIdentity: { driverKind: driver, continuationKey: "acpRegistry:gemini" },
          displayName: undefined,
          enabled: true,
          snapshot: {
            getSnapshot: Ref.get(snapshotRef),
            // Enrichment can publish before the original probe finishes its remaining work.
            refresh: Effect.gen(function* () {
              yield* publishSnapshot(pendingProvider);
              yield* publishSnapshot(enrichedProvider);
              yield* Deferred.await(releaseRefresh);
              return pendingProvider;
            }),
            streamChanges: Stream.fromPubSub(changes),
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const instanceRegistryLayer = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (requestedId) =>
              Effect.succeed(requestedId === instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provide(layerUnusedMutator),
            Layer.provideMerge(instanceRegistryLayer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-enriched-refresh-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const config = yield* ServerConfig.ServerConfig;
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId,
          });
          expect(yield* registry.getProviders).toEqual([expect.objectContaining(initialProvider)]);

          const enrichedObserved = yield* awaitPersistedProvider(
            registry,
            enrichedProvider.checkedAt,
          );
          const refreshed = yield* registry.refreshInstance(instanceId).pipe(Effect.forkChild);
          yield* Fiber.join(enrichedObserved);
          yield* Deferred.succeed(releaseRefresh, undefined);
          const returned = yield* Fiber.join(refreshed);

          const enriched = {
            status: enrichedProvider.status,
            auth: enrichedProvider.auth,
            message: enrichedProvider.message,
            checkedAt: enrichedProvider.checkedAt,
          };
          expect(
            yield* registry.getProviders,
            "getProviders should hold the enriched snapshot, not the stale pending one refresh returned",
          ).toEqual([expect.objectContaining(enriched)]);
          expect(returned).toEqual([expect.objectContaining(enriched)]);
          expect(yield* readProviderStatusCache(filePath)).toEqual(
            expect.objectContaining(enriched),
          );
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("persists an authoritative empty native inventory", () =>
      Effect.gen(function* () {
        const cursorDriver = ProviderDriverKind.make("neopi");
        const cursorInstanceId = ProviderInstanceId.make("neopi");
        const initialProvider = {
          instanceId: cursorInstanceId,
          driver: cursorDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...initialProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;
        const changes = yield* PubSub.unbounded<ServerProvider>();
        const instance = {
          instanceId: cursorInstanceId,
          driverKind: cursorDriver,
          continuationIdentity: {
            driverKind: cursorDriver,
            continuationKey: "cursor:instance:cursor",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            getSnapshot: Effect.succeed(initialProvider),
            refresh: Effect.succeed(refreshedProvider),
            streamChanges: Stream.fromPubSub(changes),
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === cursorInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provide(layerUnusedMutator),
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-merged-persist-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const config = yield* ServerConfig.ServerConfig;
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: cursorInstanceId,
          });

          assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
            ...initialProvider.models,
          ]);
          const persisted = yield* awaitPersistedProvider(registry, refreshedProvider.checkedAt);
          yield* PubSub.publish(changes, refreshedProvider);
          yield* Fiber.join(persisted);
          const cachedProvider = yield* readProviderStatusCache(filePath);

          assert.deepStrictEqual(cachedProvider, refreshedProvider);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("does not republish an older snapshot after a slow cache write", () =>
      Effect.gen(function* () {
        const claudeDriver = ProviderDriverKind.make("neopi");
        const claudeInstanceId = ProviderInstanceId.make("neopi");
        const initialProvider = {
          instanceId: claudeInstanceId,
          driver: claudeDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2.1.300",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const verifyingProvider = { ...initialProvider, checkedAt: "2026-04-14T00:01:00.000Z" };
        const laterProvider = { ...initialProvider, checkedAt: "2026-04-14T00:02:00.000Z" };
        let latestProvider: ServerProvider = initialProvider;
        const changes = yield* PubSub.unbounded<ServerProvider>();
        const instance = {
          instanceId: claudeInstanceId,
          driverKind: claudeDriver,
          continuationIdentity: {
            driverKind: claudeDriver,
            continuationKey: "claude:instance:claude",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            getSnapshot: Effect.sync(() => latestProvider),
            refresh: Effect.succeed(initialProvider),
            streamChanges: Stream.fromPubSub(changes),
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === claudeInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          },
        );
        const writeStarted = yield* Deferred.make<void>();
        const releaseWrite = yield* Deferred.make<void>();
        const gatedCachePath = yield* Ref.make<string | undefined>(undefined);
        const layerGatedFileSystem = Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            return {
              ...fileSystem,
              rename: (from, to) =>
                Ref.modify(gatedCachePath, (path) =>
                  path === to ? [true, undefined] : [false, path],
                ).pipe(
                  Effect.flatMap((gated) =>
                    gated
                      ? Deferred.succeed(writeStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseWrite)),
                        )
                      : Effect.void,
                  ),
                  Effect.andThen(fileSystem.rename(from, to)),
                ),
            } satisfies FileSystem.FileSystem;
          }),
        ).pipe(Layer.provide(NodeServices.layer));
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provide(layerUnusedMutator),
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-update-state-race-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(layerGatedFileSystem),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const config = yield* ServerConfig.ServerConfig;
          const streamed = yield* registry.streamChanges.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          );

          yield* Ref.set(
            gatedCachePath,
            yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: claudeInstanceId,
            }),
          );
          yield* PubSub.publish(changes, verifyingProvider);
          yield* Deferred.await(writeStarted);
          latestProvider = laterProvider;
          yield* registry.refreshInstance(claudeInstanceId);
          yield* Deferred.succeed(releaseWrite, undefined);
          assert.deepStrictEqual(
            (yield* registry.getProviders).map((provider) => provider.checkedAt),
            [laterProvider.checkedAt],
          );
          assert.deepStrictEqual(
            (yield* Fiber.join(streamed)).map((providers) =>
              providers.map((provider) => provider.checkedAt),
            ),
            [[laterProvider.checkedAt], [laterProvider.checkedAt]],
          );
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("persists native inventory removals through a later unavailable snapshot", () =>
      Effect.gen(function* () {
        const openCodeDriver = ProviderDriverKind.make("neopi");
        const openCodeInstanceId = ProviderInstanceId.make("neopi");
        const initialProvider = {
          instanceId: openCodeInstanceId,
          driver: openCodeDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "removed-plugin/model",
              name: "Removed Plugin Model",
              subProvider: "Removed Plugin",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const authoritativeProvider = {
          ...initialProvider,
          checkedAt: "2026-07-17T00:01:00.000Z",
          models: [initialProvider.models[0]!],
        } satisfies ServerProvider;
        const failedProvider = {
          ...authoritativeProvider,
          status: "error",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:02:00.000Z",
          models: [],
          message: "Native model discovery is unavailable.",
        } satisfies ServerProvider;
        const changes = yield* PubSub.unbounded<ServerProvider>();
        const instance = {
          instanceId: openCodeInstanceId,
          driverKind: openCodeDriver,
          continuationIdentity: {
            driverKind: openCodeDriver,
            continuationKey: "opencode:instance:opencode",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            getSnapshot: Effect.succeed(initialProvider),
            refresh: Effect.succeed(authoritativeProvider),
            streamChanges: Stream.fromPubSub(changes),
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === openCodeInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provide(layerUnusedMutator),
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-opencode-authoritative-persist-",
              }),
            ),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const config = yield* ServerConfig.ServerConfig;
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: openCodeInstanceId,
          });

          const authoritativePersisted = yield* awaitPersistedProvider(
            registry,
            authoritativeProvider.checkedAt,
          );
          yield* PubSub.publish(changes, authoritativeProvider);
          yield* Fiber.join(authoritativePersisted);
          let cachedProvider = yield* readProviderStatusCache(filePath);

          assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);

          const failedPersisted = yield* awaitPersistedProvider(registry, failedProvider.checkedAt);
          yield* PubSub.publish(changes, failedProvider);
          yield* Fiber.join(failedPersisted);
          cachedProvider = yield* readProviderStatusCache(filePath);

          assert.deepStrictEqual(cachedProvider?.models, []);
          assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, []);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("returns the cached provider list when a manual refresh fails", () =>
      Effect.gen(function* () {
        const codexDriver = ProviderDriverKind.make("neopi");
        const codexInstanceId = ProviderInstanceId.make("neopi");
        const cachedProvider = {
          instanceId: codexInstanceId,
          driver: codexDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-29T10:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const instance = {
          instanceId: codexInstanceId,
          driverKind: codexDriver,
          continuationIdentity: {
            driverKind: codexDriver,
            continuationKey: "codex:instance:codex",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            getSnapshot: Effect.succeed(cachedProvider),
            refresh: Effect.die(new Error("simulated refresh failure")),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provide(layerUnusedMutator),
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-refresh-failure-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;

          assert.deepStrictEqual(yield* registry.getProviders, [cachedProvider]);
          assert.deepStrictEqual(yield* registry.refresh(codexDriver), [cachedProvider]);
          assert.deepStrictEqual(yield* registry.refreshInstance(codexInstanceId), [
            cachedProvider,
          ]);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("re-probes the selected NeoPi executable after a settings change", () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("neopi");
        const firstMissing = "/nonexistent/t3-neopi-first";
        const secondMissing = "/nonexistent/t3-neopi-second";
        const spawnedCommands: string[] = [];
        const secondProbeStarted = yield* Deferred.make<void>();
        const releaseSecondProbe = yield* Deferred.make<void>();
        const serverSettings = yield* makeMutableServerSettingsService(
          decodeServerSettings({
            ...encodedDefaultServerSettings,
            providerInstances: {
              [instanceId]: {
                driver: "neopi",
                enabled: true,
                config: { binaryPath: firstMissing },
              },
            },
          }),
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const layerProviderRegistry = ProviderRegistry.layer.pipe(
          Layer.provideMerge(
            ProviderInstanceRegistryHydration.layer.pipe(
              Layer.provide(McpSessionRegistryTestkit.layerNative),
            ),
          ),
          Layer.provideMerge(
            Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
          ),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-native-reprobe-" }),
          ),
          Layer.provideMerge(layerTestHttpClient),
          Layer.provideMerge(ProviderLatestVersions.layer),
          Layer.provideMerge(
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunScopeWork: () => Effect.succeed(false),
            }),
          ),
          Layer.updateService(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
            ChildProcessSpawner.make((command) => {
              if (
                command._tag !== "StandardCommand" ||
                (command.command !== firstMissing && command.command !== secondMissing)
              ) {
                return Effect.die("Unexpected executable during native reprobe");
              }
              spawnedCommands.push(command.command);
              const beforeSpawn =
                command.command === secondMissing
                  ? Deferred.succeed(secondProbeStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseSecondProbe)),
                    )
                  : Effect.void;
              return beforeSpawn.pipe(Effect.andThen(spawner.spawn(command)));
            }),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        );
        const runtimeServices = yield* Layer.build(layerProviderRegistry).pipe(
          Scope.provide(scope),
        );
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const snapshots = registry.streamChanges.pipe(
            Stream.map((providers) =>
              providers.find((provider) => provider.instanceId === instanceId),
            ),
            Stream.filter((provider): provider is ServerProvider => provider !== undefined),
          );
          const initial = (yield* registry.refreshInstance(instanceId)).find(
            (provider) => provider.instanceId === instanceId,
          );
          assert.strictEqual(initial?.status, "error");
          assert.strictEqual(initial?.installed, false);
          assert.include(spawnedCommands, firstMissing);
          const beforeChange = spawnedCommands.length;
          const reprobePublished = yield* Stream.toPull(
            snapshots.pipe(
              Stream.filter(
                (provider) =>
                  provider.status === "error" && provider.message?.includes(secondMissing) === true,
              ),
            ),
          );
          yield* serverSettings.updateSettings({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("neopi"),
                enabled: true,
                config: { binaryPath: secondMissing },
              },
            },
          });
          yield* Deferred.await(secondProbeStarted);
          yield* Deferred.succeed(releaseSecondProbe, undefined);
          yield* reprobePublished;
          const rebuilt = (yield* registry.refreshInstance(instanceId)).find(
            (provider) => provider.instanceId === instanceId,
          );
          assert.deepStrictEqual(
            new Set(spawnedCommands.slice(beforeChange)),
            new Set([secondMissing]),
          );
          assert.strictEqual(rebuilt?.status, "error");
          assert.strictEqual(rebuilt?.installed, false);
          assert.include(rebuilt?.message ?? "", secondMissing);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("includes unavailable instance snapshots in getProviders", () =>
      Effect.gen(function* () {
        const serverSettings = yield* makeMutableServerSettingsService(
          decodeServerSettings(
            deepMerge(encodedDefaultServerSettings, {
              providerInstances: {
                ...disabledDefaultSlots("neopi"),
                ghost_main: {
                  driver: "ghostDriver",
                  displayName: "A fork-only driver we don't ship",
                  enabled: false,
                  config: { arbitrary: "payload" },
                },
              } as unknown as (typeof ServerSettings.Encoded)["providerInstances"],
            }),
          ),
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const layerProviderRegistry = ProviderRegistry.layer.pipe(
          Layer.provideMerge(
            ProviderInstanceRegistryHydration.layer.pipe(
              Layer.provide(McpSessionRegistryTestkit.layerNative),
            ),
          ),
          Layer.provideMerge(
            Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
          ),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-provider-registry-",
            }),
          ),
          Layer.provideMerge(layerTestHttpClient),
          Layer.provideMerge(ProviderLatestVersions.layer),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
        );
        const runtimeServices = yield* Layer.build(layerProviderRegistry).pipe(
          Scope.provide(scope),
        );

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const providers = yield* registry.getProviders;
          const ghost = providers.find((provider) => provider.instanceId === "ghost_main");

          assert.notStrictEqual(ghost, undefined);
          assert.strictEqual(ghost?.driver, "ghostDriver");
          assert.strictEqual(ghost?.availability, "unavailable");
          assert.strictEqual(Object.hasOwn(ghost ?? {}, "setup"), false);
          assert.match(ghost?.unavailableReason ?? "", /ghostDriver/);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    const startupSettings = (instanceId?: string) =>
      decodeServerSettings({
        ...encodedDefaultServerSettings,
        providerInstances: {
          ...disabledDefaultSlots("neopi"),
          ...(instanceId ? { [instanceId]: { driver: "ghostDriver" } } : {}),
        },
      });

    const hydrateDuringSettingsChange = Effect.fnUntraced(function* (input: {
      seed: ContractServerSettings;
      saved: ContractServerSettings;
      current: ContractServerSettings;
      failCurrentRead?: boolean;
    }) {
      const changes = yield* PubSub.unbounded<ContractServerSettings | undefined>();
      const consume = yield* Deferred.make<void>();
      const drained: Array<Deferred.Deferred<void>> = [];
      let readSeed = true;
      let failCurrentRead = false;
      const settings = yield* makeMutableServerSettingsService(input.current);
      const serverSettings = {
        ...settings,
        getSettings: Effect.suspend(() => {
          if (!readSeed) {
            readSeed = true;
            return PubSub.publish(changes, input.saved).pipe(Effect.as(input.seed));
          }
          return failCurrentRead
            ? Effect.fail(
                new ServerSettingsError({
                  settingsPath: "<memory>",
                  operation: "read-secret",
                  cause: new Error("secret materialization failed"),
                }),
              )
            : settings.getSettings;
        }),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const done = yield* Deferred.make<void>();
          drained.push(done);
          // The terminal marker acknowledges preceding reconciles, including no-op/failed reads.
          return Stream.fromEffectRepeat(
            Deferred.await(consume).pipe(Effect.andThen(PubSub.take(subscription))),
          ).pipe(
            Stream.takeWhile((next): next is ContractServerSettings => next !== undefined),
            Stream.ensuring(Deferred.succeed(done, undefined)),
          );
        }),
      } satisfies ServerSettingsModule.ServerSettingsService["Service"];
      const dependencies = yield* Layer.build(
        ServerSecretStore.layer.pipe(
          Layer.provideMerge(
            Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
          ),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-registry-" }),
          ),
          Layer.provideMerge(layerTestHttpClient),
          Layer.provideMerge(ProviderLatestVersions.layer),
          Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
        ),
      );
      readSeed = false;
      const services = yield* Layer.build(
        ProviderInstanceRegistryHydration.layer.pipe(
          Layer.provide(McpSessionRegistryTestkit.layerNative),
        ),
      ).pipe(Effect.provide(dependencies));
      failCurrentRead = input.failCurrentRead ?? false;
      yield* PubSub.publish(changes, undefined);
      yield* Deferred.succeed(consume, undefined);
      yield* Effect.forEach(drained, Deferred.await);
      const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry.pipe(
        Effect.provide(services),
      );
      return (yield* registry.listUnavailable).map(
        (provider): string | undefined => provider.instanceId,
      );
    });

    it.effect("applies a settings change saved while the provider registry starts", () =>
      Effect.gen(function* () {
        const saved = startupSettings("ghost_late");
        const unavailable = yield* hydrateDuringSettingsChange({
          seed: startupSettings(),
          saved,
          current: saved,
        });
        assert.include(unavailable, "ghost_late");
      }),
    );

    it.effect("does not apply a queued settings change older than the registry seed", () =>
      Effect.gen(function* () {
        const seed = startupSettings("ghost_current");
        const unavailable = yield* hydrateDuringSettingsChange({
          seed,
          saved: startupSettings("ghost_stale"),
          current: seed,
        });
        assert.include(unavailable, "ghost_current");
        assert.notInclude(unavailable, "ghost_stale");
      }),
    );

    it.effect(
      "retains the newer registry seed when a queued stale change cannot read current settings",
      () =>
        Effect.gen(function* () {
          const seed = startupSettings("ghost_current");
          const unavailable = yield* hydrateDuringSettingsChange({
            seed,
            saved: startupSettings("ghost_stale"),
            current: seed,
            failCurrentRead: true,
          });
          assert.include(unavailable, "ghost_current");
          assert.notInclude(unavailable, "ghost_stale");
        }),
    );
  });
});
