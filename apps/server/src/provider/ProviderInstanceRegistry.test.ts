import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  type ResolvedProviderInstanceEnvironment,
  ProviderInstanceId,
  SecretProviderId,
  SettingsSecretValue,
  type SecretReference,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { ProviderDriverError } from "./Errors.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import type {
  AnyProviderDriver,
  ProviderDriver,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";

const LifecycleConfig = Schema.Struct({
  enabled: Schema.Boolean,
  binaryPath: Schema.String,
  homePath: Schema.String,
  customModels: Schema.Array(Schema.String),
});
type LifecycleConfig = typeof LifecycleConfig.Type;
const makeConfig = (overrides: Partial<LifecycleConfig>): LifecycleConfig => ({
  enabled: false,
  binaryPath: "unused",
  homePath: "",
  customModels: [],
  ...overrides,
});
const lifecycleDriver: ProviderDriver<LifecycleConfig> = {
  driverKind: ProviderDriverKind.make("neopi"),
  metadata: { displayName: "Lifecycle fixture" },
  configSchema: LifecycleConfig,
  defaultConfig: () => makeConfig({}),
  create: (input) =>
    Effect.succeed({
      instanceId: input.instanceId,
      driverKind: ProviderDriverKind.make("neopi"),
      displayName: input.displayName,
      enabled: input.enabled,
      snapshot: { getSnapshot: Effect.succeed({ enabled: input.enabled }) },
    } as ProviderInstance),
};

describe("ProviderInstanceRegistry lifecycle", () => {
  const layerTest = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(SecretResolver.SecretResolver)({}),
  );

  it.effect.each(["replacement", "removal", "creation failure"] as const)(
    "detaches retired provider scopes after repeated %s",
    (scenario) =>
      Effect.gen(function* () {
        const parent = yield* Scope.make();
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped();
        let creates = 0;
        let closes = 0;
        const driver: typeof lifecycleDriver = {
          ...lifecycleDriver,
          create: Effect.fn("ProviderInstanceRegistry.test.create")(function* (
            input: Parameters<typeof lifecycleDriver.create>[0],
          ) {
            creates++;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closes++;
              }),
            );
            if (input.config.binaryPath === "creation-failure") {
              return yield* new ProviderDriverError({
                driver: lifecycleDriver.driverKind,
                instanceId: input.instanceId,
                detail: "fixture creation failed",
              });
            }
            return yield* lifecycleDriver.create(input);
          }),
        };
        const siblingId = ProviderInstanceId.make("sibling");
        const retiredId = ProviderInstanceId.make("retired");
        const entry = {
          driver: lifecycleDriver.driverKind,
          enabled: false,
          config: makeConfig({ homePath }),
        };
        yield* Effect.gen(function* () {
          const { registry, mutator } = yield* makeProviderInstanceRegistry({
            drivers: [driver],
            configMap: { [siblingId]: entry },
          });
          const sibling = yield* registry.getInstance(siblingId);
          const finalizerCount = () => {
            const state = parent.state;
            return state._tag === "Open" ? (state.finalizers?.size ?? 1) : 0;
          };
          const baseline = finalizerCount();
          for (let index = 0; index < 20; index++) {
            yield* mutator.reconcile({
              [siblingId]: entry,
              [retiredId]: {
                ...entry,
                config: makeConfig({
                  homePath,
                  binaryPath: scenario === "creation failure" ? "creation-failure" : "replacement",
                  customModels: [`revision-${index}`],
                }),
              },
            });
            if (scenario === "removal") yield* mutator.reconcile({ [siblingId]: entry });
          }
          yield* mutator.reconcile({ [siblingId]: entry });
          expect(yield* registry.getInstance(siblingId)).toBe(sibling);
          expect(closes).toBe(creates - 1);
          expect(parent.state._tag).toBe("Open");
          expect(finalizerCount()).toBe(baseline);
        }).pipe(
          Effect.provideService(Scope.Scope, parent),
          Effect.ensuring(Scope.close(parent, Exit.void)),
        );
        expect(closes).toBe(creates);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["replacement", "removal"] as const)(
    "hides retired instances during reconcile (%s)",
    (scenario) =>
      Effect.gen(function* () {
        let closed = 0;
        const replacementStarted = yield* Deferred.make<void>();
        const releaseReplacement = yield* Deferred.make<void>();
        const driver: typeof lifecycleDriver = {
          ...lifecycleDriver,
          create: (input) =>
            Effect.gen(function* () {
              if (input.displayName === "Second") {
                yield* Deferred.succeed(replacementStarted, undefined);
                yield* Deferred.await(releaseReplacement);
              }
              const instance = yield* lifecycleDriver.create(input);
              yield* Effect.addFinalizer(() => Effect.sync(() => closed++));
              return instance;
            }),
        };
        const retiredId = ProviderInstanceId.make("retired");
        const siblingId = ProviderInstanceId.make("sibling");
        const nextId = scenario === "replacement" ? retiredId : ProviderInstanceId.make("new");
        const entry = {
          driver: lifecycleDriver.driverKind,
          enabled: false,
          config: makeConfig({}),
        };
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: { [retiredId]: entry, [siblingId]: entry },
        });
        const sibling = yield* registry.getInstance(siblingId);
        const reconcile = yield* mutator
          .reconcile({
            [siblingId]: entry,
            [nextId]: {
              ...entry,
              displayName: "Second",
              config: makeConfig({ customModels: ["replacement-model"] }),
            },
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(replacementStarted);
        expect(closed).toBe(1);
        expect(yield* registry.getInstance(retiredId)).toBeUndefined();
        expect(yield* registry.listInstances).toEqual([sibling]);
        yield* Deferred.succeed(releaseReplacement, undefined);
        yield* Fiber.join(reconcile);
        expect((yield* registry.getInstance(nextId))?.displayName).toBe("Second");
        expect(yield* registry.getInstance(siblingId)).toBe(sibling);
        expect(closed).toBe(1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.live("treats an explicit in-config enabled:false as disabling despite the envelope", () =>
    Effect.gen(function* () {
      const staleId = ProviderInstanceId.make("neopi_stale");
      const configMap: ProviderInstanceConfigMap = {
        [staleId]: {
          driver: lifecycleDriver.driverKind,
          enabled: true,
          config: makeConfig({ enabled: false }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [lifecycleDriver],
        configMap,
      });

      const instance = yield* registry.getInstance(staleId);
      expect(instance).toBeDefined();
      expect(instance!.enabled).toBe(false);
      const snapshot = yield* instance!.snapshot.getSnapshot;
      expect(snapshot.enabled).toBe(false);
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("lists a blocked driver's instances as unavailable without running them", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("neopi");
      const reason = "Example Corp's policy does not allow this runtime.";
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [lifecycleDriver],
        configMap: { [instanceId]: { driver: lifecycleDriver.driverKind } },
        blockedReason: (driver) => (driver === lifecycleDriver.driverKind ? reason : undefined),
      });

      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      const [unavailable] = yield* registry.listUnavailable;
      expect(unavailable?.instanceId).toBe(instanceId);
      expect(unavailable?.availability).toBe("unavailable");
      expect(unavailable?.unavailableReason).toBe(reason);
    }).pipe(Effect.provide(layerTest)),
  );

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const nativeId = ProviderInstanceId.make("neopi_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [nativeId]: {
            driver: lifecycleDriver.driverKind,
            enabled: false,
            config: makeConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [lifecycleDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(nativeId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(layerTest)),
  );
});

const DisabledByDefaultConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});

describe("ProviderInstanceRegistry secret environment", () => {
  const driverKind = ProviderDriverKind.make("fake");
  const instanceId = ProviderInstanceId.make("fake_main");
  const secret: SecretReference = {
    provider: SecretProviderId.make("personal"),
    reference: "op://Private/OpenAI/credential",
  };

  function setup(
    initial: Record<string, string>,
    configSchema: AnyProviderDriver["configSchema"] = Schema.Unknown,
    config: unknown = {},
  ) {
    const vault = new Map(Object.entries(initial));
    const reads: Array<ReadonlyArray<string>> = [];
    const invalidated: Array<ReadonlyArray<string>> = [];
    const created: Array<ResolvedProviderInstanceEnvironment> = [];
    const configs: Array<unknown> = [];
    const driver: AnyProviderDriver = {
      driverKind,
      metadata: { displayName: "Fake" },
      configSchema,
      defaultConfig: () => ({}),
      create: (input) =>
        Effect.sync(() => {
          created.push(input.environment);
          configs.push(input.config);
          return { instanceId: input.instanceId, enabled: input.enabled } as ProviderInstance;
        }),
    };
    const gate = Deferred.makeUnsafe<void>();
    const resolver = Layer.succeed(SecretResolver.SecretResolver, {
      label: (provider) => Effect.succeed(provider),
      read: (references) =>
        Deferred.await(gate).pipe(
          Effect.andThen(
            Effect.sync(() => {
              reads.push(references.map((reference) => reference.reference));
              return references.map((reference) => vault.get(reference.reference));
            }),
          ),
        ),
      invalidate: (references = []) =>
        Effect.sync(() => {
          invalidated.push(references.map((reference) => reference.reference));
        }),
    });
    const configMap: ProviderInstanceConfigMap = {
      [instanceId]: {
        driver: driverKind,
        config,
        environment: [
          { name: "OPENAI_API_KEY", value: secret, sensitive: true },
          { name: "BASE_URL", value: "https://example.test", sensitive: false },
        ],
      },
    };
    const makeGated = makeProviderInstanceRegistry({ drivers: [driver], configMap }).pipe(
      Effect.provide(resolver),
    );
    // Secrets are read after startup, so wait for the change that applies them.
    const make = Effect.gen(function* () {
      const built = yield* makeGated;
      const changes = yield* built.registry.subscribeChanges;
      yield* Deferred.succeed(gate, undefined);
      yield* PubSub.take(changes);
      return built;
    });
    return { vault, reads, invalidated, created, configs, configMap, make, makeGated, gate };
  }

  it.effect("starts an instance with the secret its environment points at", () => {
    const fixture = setup({ [secret.reference]: "sk-live" });
    return Effect.gen(function* () {
      const { registry } = yield* fixture.make;

      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(fixture.created).toEqual([
        [
          { name: "OPENAI_API_KEY", value: "sk-live", sensitive: true },
          { name: "BASE_URL", value: "https://example.test", sensitive: false },
        ],
      ]);
    }).pipe(Effect.scoped);
  });

  // An empty secret must not let a driver fall back to a credential the server inherited.
  it.effect.each([
    ["missing", {}],
    ["empty", { [secret.reference]: " " }],
  ] as const)("marks an instance unavailable when its secret is %s", ([, initial]) => {
    const fixture = setup(initial);
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.make;
      const readsAtStartup = fixture.reads.length;

      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      expect(fixture.created).toEqual([]);
      const [unavailable] = yield* registry.listUnavailable;
      expect(unavailable?.instanceId).toBe(instanceId);
      expect(unavailable?.unavailableReason).toContain("OPENAI_API_KEY");

      // A settings save that leaves it alone does not read the vault again.
      yield* mutator.reconcile({ ...fixture.configMap });
      expect(fixture.reads).toHaveLength(readsAtStartup);
      expect(yield* registry.listUnavailable).toHaveLength(1);
    }).pipe(Effect.scoped);
  });

  it.effect("does not read the secrets of an instance its config decodes as disabled", () => {
    const fixture = setup({ [secret.reference]: "sk-live" }, DisabledByDefaultConfig);
    return Effect.gen(function* () {
      const { mutator } = yield* fixture.makeGated;
      yield* mutator.reloadSecrets();

      expect(fixture.reads).toEqual([]);
      expect(fixture.invalidated).toEqual([]);
      expect(fixture.created).toHaveLength(1);
    }).pipe(Effect.scoped);
  });

  it.effect("re-reads secrets on reload and rebuilds only when they changed", () => {
    const fixture = setup({});
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.make;

      fixture.vault.set(secret.reference, "sk-live");
      yield* mutator.reloadSecrets();
      expect(fixture.invalidated).toEqual([[secret.reference]]);
      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(yield* registry.listUnavailable).toEqual([]);

      yield* mutator.reloadSecrets(instanceId);
      expect(fixture.created).toHaveLength(1);

      fixture.vault.set(secret.reference, "sk-rotated");
      yield* mutator.reloadSecrets(instanceId);
      expect(fixture.created.map((environment) => environment[0]?.value)).toEqual([
        "sk-live",
        "sk-rotated",
      ]);
    }).pipe(Effect.scoped);
  });

  it.effect("reads a config field typed SettingsSecretValue and rebuilds when it rotates", () => {
    const apiKey: SecretReference = { ...secret, reference: "op://Private/Gateway/key" };
    const fixture = setup(
      { [secret.reference]: "sk-live", [apiKey.reference]: "gw-live" },
      Schema.Struct({ apiKey: SettingsSecretValue, model: Schema.String }),
      { apiKey, model: "m" },
    );
    return Effect.gen(function* () {
      const { mutator } = yield* fixture.make;
      expect(fixture.reads.at(-1)).toEqual([secret.reference, apiKey.reference]);

      fixture.vault.set(apiKey.reference, "gw-rotated");
      yield* mutator.reloadSecrets();
      expect(fixture.configs).toEqual([
        { apiKey: "gw-live", model: "m" },
        { apiKey: "gw-rotated", model: "m" },
      ]);
    }).pipe(Effect.scoped);
  });

  it.effect.each(["apiKey", "serverPassword"])(
    "hands the driver the secret its %s names",
    (field) => {
      const reference: SecretReference = { ...secret, reference: "op://Private/Provider/key" };
      const fixture = setup(
        { [secret.reference]: "sk-live", [reference.reference]: "provider-live" },
        Schema.Struct({ enabled: Schema.Boolean, [field]: SettingsSecretValue }),
        { enabled: true, [field]: reference },
      );
      return Effect.gen(function* () {
        yield* fixture.make;
        expect(fixture.configs).toEqual([expect.objectContaining({ [field]: "provider-live" })]);
      }).pipe(Effect.scoped);
    },
  );

  it.effect("keeps a working instance live when a reload cannot read its secret", () => {
    const fixture = setup({ [secret.reference]: "sk-live" });
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.make;

      fixture.vault.delete(secret.reference);
      yield* mutator.reloadSecrets();

      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(yield* registry.listUnavailable).toEqual([]);
      expect(fixture.created).toHaveLength(1);
    }).pipe(Effect.scoped);
  });

  it.effect("starts without waiting for secrets to be read", () => {
    const fixture = setup({ [secret.reference]: "sk-live" });
    return Effect.gen(function* () {
      const { registry } = yield* fixture.makeGated;
      const changes = yield* registry.subscribeChanges;

      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      const [pending] = yield* registry.listUnavailable;
      expect(pending?.unavailableReason).toBe("Reading secrets…");

      yield* Deferred.succeed(fixture.gate, undefined);
      yield* PubSub.take(changes);
      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(yield* registry.listUnavailable).toEqual([]);
    }).pipe(Effect.scoped);
  });
});
