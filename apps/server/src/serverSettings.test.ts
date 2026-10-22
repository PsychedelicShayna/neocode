import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
import { neoPiBinarySelectionPatch } from "./provider/neopi/NeoPiBinarySelection.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./terminal/Manager.ts";

const decodeSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

const makeFailingSecretStoreLayer = (cause: ServerSecretStore.SecretStoreError) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.fail(cause),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    }),
  );

const recordProviderUsage = (provider: string, instanceId: string | null = provider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_instance_id,
        updated_at
      )
      VALUES (
        ${`thread-${instanceId ?? provider}`},
        ${"ready"},
        ${provider},
        ${instanceId},
        ${"2026-08-25T00:00:00.000Z"}
      )
    `;
  });

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("respects an explicit disabled native default when finding a text-generation fallback", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const defaultId = ProviderInstanceId.make("neopi");
      const workId = ProviderInstanceId.make("native-work");
      const legacyId = ProviderInstanceId.make("saved-codex");
      const next = yield* service.updateSettings({
        providerInstances: {
          [defaultId]: { driver: ProviderDriverKind.make("neopi"), enabled: false, config: { profile: "personal" } },
          [workId]: { driver: ProviderDriverKind.make("neopi"), enabled: true, config: { profile: "work" } },
          [legacyId]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
        },
        textGenerationModelSelection: { instanceId: legacyId, model: "saved-model" },
      });
      assert.equal(next.textGenerationModelSelection.instanceId, workId);
      assert.equal(next.providerInstances[defaultId]?.enabled, false);
      assert.deepEqual(next.providerInstances[defaultId]?.config, { profile: "personal" });
      assert.deepEqual(next.providerInstances[workId]?.config, { profile: "work" });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves context when reading a provider environment secret fails", () => {
    const platformCause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFile",
      pathOrDescriptor: "provider environment secret",
      description: "Secret backend unavailable.",
    });
    const cause = new ServerSecretStore.SecretStoreReadError({
      resource: "provider environment secret",
      cause: platformCause,
    });
    const configLayer = Layer.fresh(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-server-settings-secret-failure-test-",
      }),
    );
    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(makeFailingSecretStoreLayer(cause)),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
      Layer.provideMerge(configLayer),
    );

    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"OPENROUTER_API_KEY","value":"","sensitive":true,"valueRedacted":true}],"config":{}}}}',
      );

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-secret",
        providerInstanceId: "codex_personal",
        environmentVariable: "OPENROUTER_API_KEY",
      });
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(settingsLayer));
  });

  it.effect("identifies provider history query failures", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE projection_thread_sessions`;

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-provider-history",
        settingsPath: serverConfig.settingsPath,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("decodes nested settings patches", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* decodeSettingsPatch({ providers: { codex: { binaryPath: "/tmp/codex" } } }),
        {
          providers: { codex: { binaryPath: "/tmp/codex" } },
        },
      );

      assert.deepEqual(
        yield* decodeSettingsPatch({
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        }),
        {
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        },
      );
    }),
  );

  it.effect(
    "decodes legacy object-shaped textGenerationModelSelection.options from settings.json",
    () =>
      Effect.gen(function* () {
        const decoded = yield* decodeServerSettings({
          textGenerationModelSelection: {
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5.4-mini",
            options: { reasoningEffort: "low" },
          },
        });

        assert.deepEqual(decoded.textGenerationModelSelection, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
      }),
  );

  it.effect("keeps fresh harness defaults disabled after saving and reloading settings", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const initial = yield* service.getSettings;
      assert.deepEqual(
        Object.entries(initial.providers)
          .filter(([, provider]) => provider.enabled)
          .map(([driver]) => driver),
        ["neopi"],
      );
      const codexId = ProviderInstanceId.make("codex_work");
      const claudeId = ProviderInstanceId.make("claude_work");
      yield* service.updateSettings({
        addProjectBaseDirectory: "~/Development",
        providerInstances: {
          [codexId]: { driver: ProviderDriverKind.make("codex"), config: {} },
          [claudeId]: { driver: ProviderDriverKind.make("claudeAgent"), config: {} },
        },
      });
      const reloaded = yield* Effect.gen(function* () {
        const fresh = yield* ServerSettingsModule.ServerSettingsService;
        return yield* fresh.getSettings;
      }).pipe(
        Effect.provide(
          Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
        ),
      );
      assert.isTrue(reloaded.providers.neopi.enabled);
      assert.isFalse(reloaded.providers.codex.enabled);
      assert.isFalse(reloaded.providers.claudeAgent.enabled);
      assert.isFalse(resolveProviderInstanceEnabled(reloaded.providerInstances[codexId]!));
      assert.isFalse(resolveProviderInstanceEnabled(reloaded.providerInstances[claudeId]!));
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  for (const enabled of [undefined, true, false]) {
    it.effect(`preserves existing Codex and Claude enabled flags (${String(enabled)})`, () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const codexId = ProviderInstanceId.make("codex_work");
        const claudeId = ProviderInstanceId.make("claude_work");
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            providers: { codex: { enabled }, claudeAgent: { enabled } },
            providerInstances: {
              [codexId]: { driver: "codex", enabled, config: {} },
              [claudeId]: { driver: "claudeAgent", config: { enabled } },
            },
          }),
        );
        const initial = yield* service.getSettings;
        yield* service.updateSettings({ addProjectBaseDirectory: "~/Development" });
        const reloaded = yield* Effect.gen(function* () {
          const fresh = yield* ServerSettingsModule.ServerSettingsService;
          return yield* fresh.getSettings;
        }).pipe(
          Effect.provide(
            Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
          ),
        );
        for (const settings of [initial, reloaded]) {
          assert.equal(settings.providers.codex.enabled, enabled ?? true);
          assert.equal(settings.providers.claudeAgent.enabled, enabled ?? true);
          assert.equal(
            resolveProviderInstanceEnabled(settings.providerInstances[codexId]!),
            enabled ?? true,
          );
          assert.equal(
            resolveProviderInstanceEnabled(settings.providerInstances[claudeId]!),
            enabled ?? true,
          );
        }
      }).pipe(Effect.provide(makeServerSettingsLayer())),
    );
  }

  it.effect("persists an automatic NeoPi selection once and reloads its provenance", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("neopi");
      const before = yield* service.getSettings;
      const binary = "/test/bin/npi-nightly";
      yield* service.updateSettings((current) =>
        neoPiBinarySelectionPatch(before, current, instanceId, binary),
      );
      const saved = yield* fs.readFileString(config.settingsPath);
      const reloaded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))(
        saved,
      );
      assert.equal(reloaded.providers.neopi.binaryPath, binary);
      assert.equal(reloaded.providers.neopi.autoSelectedBinaryPath, binary);
      // A later creation/refresh sees an explicit saved path, so it cannot write again.
      const selected = yield* service.getSettings;
      assert.equal(neoPiBinarySelectionPatch(selected, selected, instanceId, binary), null);
      yield* service.updateSettings(() => null);
      assert.equal(yield* fs.readFileString(config.settingsPath), saved);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps a user override made while an automatic NeoPi probe is in flight", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const instanceId = ProviderInstanceId.make("neopi_work");
      yield* service.updateSettings({
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("neopi"), config: { binaryPath: "npi" } },
        },
      });
      const before = yield* service.getSettings;
      const probeEntered = yield* Deferred.make<void>();
      const finishProbe = yield* Deferred.make<void>();
      const selection = yield* Effect.gen(function* () {
        yield* Deferred.succeed(probeEntered, undefined);
        yield* Deferred.await(finishProbe);
        return yield* service.updateSettings((current) =>
          neoPiBinarySelectionPatch(before, current, instanceId, "/test/bin/npi-nightly"),
        );
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(probeEntered);
      yield* service.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("neopi"),
            config: { binaryPath: "/user/chosen/npi", profile: "personal" },
          },
        },
      });
      const userSaved = yield* fs.readFileString(config.settingsPath);
      yield* Deferred.succeed(finishProbe, undefined);
      const result = yield* Fiber.join(selection);
      assert.deepEqual(result.providerInstances[instanceId]?.config, {
        binaryPath: "/user/chosen/npi",
        profile: "personal",
      });
      assert.equal(yield* fs.readFileString(config.settingsPath), userSaved);
    }).pipe(Effect.scoped, Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            enabled: true,
            binaryPath: "/usr/local/bin/codex",
            homePath: "/Users/julius/.codex",
          },
          claudeAgent: {
            enabled: true,
            binaryPath: "/usr/local/bin/claude",
            customModels: ["claude-custom"],
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("neopi"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("neopi"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      });

      assert.equal(next.providers.codex.enabled, true);
      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");
      assert.equal(next.providers.codex.homePath, "/Users/julius/.codex");
      assert.equal(next.providers.claudeAgent.enabled, true);
      assert.equal(next.providers.claudeAgent.binaryPath, "/usr/local/bin/claude");
      assert.deepEqual(next.providers.claudeAgent.customModels, ["claude-custom"]);
      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(
          ProviderInstanceId.make("neopi"),
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: false },
          ],
        ),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("buffers changes after a subscription is acquired but before it is consumed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        yield* serverSettings.updateSettings({
          providers: {
            codex: {
              binaryPath: "/usr/local/bin/codex-next",
            },
          },
        });

        const firstChange = yield* changes.pipe(Stream.runHead, Effect.timeout("1 second"));
        assert.equal(
          Option.getOrUndefined(firstChange)?.providers.codex.binaryPath,
          "/usr/local/bin/codex-next",
        );
      }),
    ).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists custom usage prices and removes them from the settings file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const prices = {
          inputCostPerMillionTokens: 2,
          outputCostPerMillionTokens: 8,
          cacheReadCostPerMillionTokens: 0,
        };
        const readPersisted = fileSystem
          .readFileString(serverConfig.settingsPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))));

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": prices } });
        const persisted = yield* readPersisted;
        assert.deepStrictEqual(persisted.usagePriceOverrides, { "example-model": prices });

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* readPersisted;
        assert.deepStrictEqual(restored.usagePriceOverrides, {});
      }),
    ).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists and broadcasts thread settlement settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        const next = yield* serverSettings.updateSettings({
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: false,
        });
        const change = Option.getOrUndefined(yield* Stream.runHead(changes));
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        // Inspect raw persisted JSON before schema decoding can apply defaults.
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const persisted = JSON.parse(raw) as Record<string, unknown>;

        assert.strictEqual(next.sidebarAutoSettleAfterDays, null);
        assert.isFalse(next.sidebarAutoSettleOnMerge);
        assert.strictEqual(change?.sidebarAutoSettleAfterDays, null);
        assert.isFalse(change?.sidebarAutoSettleOnMerge);
        assert.strictEqual(persisted.sidebarAutoSettleAfterDays, null);
        assert.isFalse(persisted.sidebarAutoSettleOnMerge);
      }),
    ).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps model backends and options when switching NeoPi instances", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const personal = ProviderInstanceId.make("personal");
      const work = ProviderInstanceId.make("work");
      yield* serverSettings.updateSettings({
        providerInstances: {
          [personal]: { driver: ProviderDriverKind.make("neopi"), enabled: true, config: { profile: "personal" } },
          [work]: { driver: ProviderDriverKind.make("neopi"), enabled: true, config: { profile: "work" } },
        },
        textGenerationModelSelection: { instanceId: personal, model: "anthropic/current", options: [{ id: "reasoningEffort", value: "high" }, { id: "fastMode", value: true }] },
      });
      const selection = { instanceId: work, model: "openai-codex/current", options: [{ id: "reasoningEffort", value: "low" }] };
      const next = yield* serverSettings.updateSettings({ textGenerationModelSelection: selection });
      assert.deepEqual(next.textGenerationModelSelection, selection);
      assert.deepEqual(next.providerInstances[personal]?.config, { profile: "personal" });
      assert.deepEqual(next.providerInstances[work]?.config, { profile: "work" });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves custom provider instance text generation selections", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("claude_openrouter")]: {
            driver: ProviderDriverKind.make("neopi"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claude_openrouter"),
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "uses explicit provider instance enabled state over legacy provider enabled state",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("claude_openrouter");

        const next = yield* serverSettings.updateSettings({
          providers: {
            neopi: {
              enabled: false,
            },
          },
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("neopi"),
              enabled: true,
              config: { customModels: ["openai/gpt-5.5"] },
            },
          },
          textGenerationModelSelection: {
            instanceId,
            model: "openai/gpt-5.5",
          },
        });

        assert.deepEqual(next.textGenerationModelSelection, {
          instanceId,
          model: "openai/gpt-5.5",
        });
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves unknown runtime settings while using NeoPi for text generation", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("openrouter_text");
      const selection = { instanceId, model: "openai/gpt-5.5" };
      const legacy = { driver: ProviderDriverKind.make("openrouter"), enabled: true, config: { customModels: [selection.model] } };
      const next = yield* serverSettings.updateSettings({ providerInstances: { [instanceId]: legacy }, textGenerationModelSelection: selection });
      assert.deepEqual(next.textGenerationModelSelection, DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
      assert.deepEqual(next.providerInstances[instanceId], legacy);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(yield* fileSystem.readFileString(serverConfig.settingsPath));
      assert.deepEqual(persisted.textGenerationModelSelection, selection);
      assert.deepEqual(persisted.providerInstances[instanceId], legacy);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "preserves the source control writer selection when its provider instance is disabled",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const instanceId = ProviderInstanceId.make("codex_writer");
        const sourceControlWriterModelSelection = {
          instanceId,
          model: "gpt-5.4-mini",
        };

        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("neopi"),
              enabled: true,
              config: {},
            },
          },
          sourceControlWriterModelSelection,
        });

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("neopi"),
              enabled: false,
              config: {},
            },
          },
        });

        assert.deepEqual(next.sourceControlWriterModelSelection, sourceControlWriterModelSelection);
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(next),
          next.textGenerationModelSelection,
        );
        assert.deepEqual(
          (yield* serverSettings.getSettings).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.deepEqual(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.parse(raw).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const restored = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("neopi"),
              enabled: true,
              config: {},
            },
          },
        });
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(restored),
          sourceControlWriterModelSelection,
        );
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("drops stale text generation options when resetting model selection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: { codex: { enabled: true } },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("replaces provider instance maps when clearing optional fields", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            accentColor: "#7c3aed",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[codexId], {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex Work",
        enabled: true,
        config: { homePath: "~/.codex" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("enables previously used providers from sparse settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providers":{"opencode":{"serverUrl":"http://127.0.0.1:4096"}}}',
      );
      yield* recordProviderUsage("opencode");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isTrue(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
      assert.equal(settings.providers.opencode.serverUrl, "http://127.0.0.1:4096");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves existing provider instances without explicit enabled flags", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"cursor_work":{"driver":"cursor","config":{}},"grok":{"driver":"grok","config":{}},"opencode_work":{"driver":"opencode","config":{"serverUrl":"http://127.0.0.1:4096"}},"opencode_unused":{"driver":"opencode","config":{}}}}',
      );
      yield* recordProviderUsage("cursor", "cursor_work");
      yield* recordProviderUsage("grok", null);
      yield* recordProviderUsage("opencode", "opencode_work");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.cursor.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("cursor_work")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("opencode_work")]?.enabled);
      const unused = settings.providerInstances[ProviderInstanceId.make("opencode_unused")];
      assert.isDefined(unused);
      assert.isFalse(resolveProviderInstanceEnabled(unused));
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves explicit provider disables in existing settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providers":{"grok":{"enabled":false},"opencode":{"enabled":false},"cursor":{"enabled":false}},"providerInstances":{"grok":{"driver":"grok","enabled":false,"config":{}},"opencode":{"driver":"opencode","config":{"enabled":false}},"cursor":{"driver":"cursor","enabled":false,"config":{}}}}',
      );
      yield* recordProviderUsage("grok");
      yield* recordProviderUsage("opencode");
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("opencode")]?.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("cursor")]?.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("skips a disabled provider instance when picking the text generation fallback", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // Obsolete provider settings are still readable, but cannot become a
      // text-generation fallback merely because an older build enabled them.
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex":{"driver":"codex","enabled":false,"config":{}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      assert.equal(settings.textGenerationModelSelection.instanceId, "neopi");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps unused providers disabled in existing sparse settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{}");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves provider history when no settings file exists", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* recordProviderUsage("grok");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves provider history when the settings file is invalid", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{invalid json");
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.cursor.enabled);
      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves valid provider flags when another settings field is invalid", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"addProjectBaseDirectory":42,"providers":{"cursor":{"enabled":false},"grok":{"enabled":true}}}',
      );
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.cursor.enabled);
      assert.isTrue(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("restores providers from persisted runtime sessions", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          status,
          last_seen_at
        )
        VALUES (
          ${"thread-opencode-runtime"},
          ${"opencode"},
          ${"opencode"},
          ${"opencode"},
          ${"ready"},
          ${"2026-08-25T00:00:00.000Z"}
        )
      `;

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isTrue(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists explicit disables after a provider has been used", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* recordProviderUsage("grok");

      assert.isTrue((yield* serverSettings.getSettings).providers.grok.enabled);

      const settings = yield* serverSettings.updateSettings({
        providers: { grok: { enabled: false } },
      });
      assert.isFalse(settings.providers.grok.enabled);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.isFalse(JSON.parse(raw).providers.grok.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists explicit provider enables before their first use", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          cursor: { enabled: true },
          grok: { enabled: true },
          opencode: { enabled: true },
        },
      });
      yield* serverSettings.updateSettings({ addProjectBaseDirectory: "~/Development" });

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(raw);
      assert.isTrue(persisted.providers.cursor.enabled);
      assert.isTrue(persisted.providers.grok.enabled);
      assert.isTrue(persisted.providers.opencode.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps optional providers disabled after a new installation writes settings", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const initial = yield* serverSettings.getSettings;
      assert.isFalse(initial.providers.grok.enabled);
      assert.isFalse(initial.providers.opencode.enabled);
      assert.isFalse(initial.providers.cursor.enabled);

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        providerInstances: {
          [ProviderInstanceId.make("grok")]: {
            driver: ProviderDriverKind.make("grok"),
            config: {},
          },
        },
      });

      assert.isFalse(next.providers.grok.enabled);
      assert.isFalse(next.providers.opencode.enabled);
      assert.isFalse(next.providers.cursor.enabled);
      const grok = next.providerInstances[ProviderInstanceId.make("grok")];
      assert.isDefined(grok);
      assert.isFalse(resolveProviderInstanceEnabled(grok));

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(raw);
      assert.isFalse(persisted.providers.cursor.enabled);
      assert.isFalse(persisted.providers.grok.enabled);
      assert.isFalse(persisted.providers.opencode.enabled);
      assert.isUndefined(persisted.providerInstances.grok.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("folds a legacy in-config enabled flag into the envelope on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // Old settings files can carry both flags with conflicting values.
      // The explicit false must win so a user's disable sticks.
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"grok":{"driver":"grok","enabled":true,"config":{"enabled":false}},"codex_work":{"driver":"codex","config":{"enabled":true,"homePath":"~/.codex"}},"cursor":{"driver":"cursor","config":{"enabled":"nope"}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      const grokId = ProviderInstanceId.make("grok");
      const codexWorkId = ProviderInstanceId.make("codex_work");
      assert.deepEqual(settings.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: {},
      });
      // A lone in-config flag is lifted to the envelope and stripped.
      assert.deepEqual(settings.providerInstances[codexWorkId], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { homePath: "~/.codex" },
      });
      // A malformed flag is left alone so driver schema validation can
      // surface it instead of the fold silently repairing the config.
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("cursor")], {
        driver: ProviderDriverKind.make("cursor"),
        config: { enabled: "nope" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("folds in-config enabled flags arriving through updates", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const grokId = ProviderInstanceId.make("grok");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [grokId]: {
            driver: ProviderDriverKind.make("grok"),
            enabled: true,
            config: { enabled: false, binaryPath: "/opt/grok" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: { binaryPath: "/opt/grok" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims provider path settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "  /opt/homebrew/bin/codex  ",
            homePath: "   ",
          },
          claudeAgent: {
            binaryPath: "  /opt/homebrew/bin/claude  ",
          },
          opencode: {
            binaryPath: "  /opt/homebrew/bin/opencode  ",
            serverUrl: "  http://127.0.0.1:4096  ",
            serverPassword: "  secret-password  ",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");
      assert.equal(next.providers.codex.homePath, "");
      assert.equal(next.providers.claudeAgent.binaryPath, "/opt/homebrew/bin/claude");
      assert.equal(next.providers.opencode.binaryPath, "/opt/homebrew/bin/opencode");
      assert.equal(next.providers.opencode.serverUrl, "http://127.0.0.1:4096");
      assert.equal(next.providers.opencode.serverPassword, "secret-password");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims observability settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "  ~/Development  ",
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
          otlpLogsUrl: "  http://localhost:4318/v1/logs  ",
        },
      });

      assert.equal(next.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        otlpLogsUrl: "http://localhost:4318/v1/logs",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("defaults blank binary paths to provider executables", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "   ",
          },
          claudeAgent: {
            binaryPath: "",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "codex");
      assert.equal(next.providers.claudeAgent.binaryPath, "claude");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes non-default settings to disk and reloads them", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          opencode: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
        automaticGitFetchInterval: Duration.seconds(10),
      });

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      const persisted = yield* decodeServerSettings(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.parse(raw),
      );
      const reloaded = yield* Effect.gen(function* () {
        const fresh = yield* ServerSettingsModule.ServerSettingsService;
        return yield* fresh.getSettings;
      }).pipe(
        Effect.provide(
          Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
        ),
      );

      for (const settings of [persisted, reloaded]) {
        assert.equal(settings.addProjectBaseDirectory, "~/Development");
        assert.equal(settings.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
        assert.equal(settings.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
        assert.equal(settings.providers.codex.binaryPath, "/opt/homebrew/bin/codex");
        assert.equal(settings.providers.opencode.serverUrl, "http://127.0.0.1:4096");
        assert.equal(settings.providers.opencode.serverPassword, "secret-password");
        assert.equal(Duration.toMillis(settings.automaticGitFetchInterval), 10_000);
        assert.equal(settings.backgroundActivity.profile, "custom");
        const customFetchInterval = settings.backgroundActivity.overrides.automaticGitFetchInterval;
        assert.equal(
          customFetchInterval === undefined ? undefined : Duration.toMillis(customFetchInterval),
          10_000,
        );
      }
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps the inline value on disk when secret migration fails", () => {
    const cause = new ServerSecretStore.SecretStorePersistError({
      resource: "provider environment secret",
      cause: new Error("Secret storage unavailable"),
    });
    const secretLayer = Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.map(ServerSecretStore.ServerSecretStore, (store) => ({
        ...store,
        set: () => Effect.fail(cause),
      })),
    ).pipe(Layer.provide(ServerSecretStore.layer));
    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(secretLayer),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
      Layer.provideMerge(
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3code-inline-secret-failure-test-",
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const original =
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}';
      yield* fs.writeFileString(config.settingsPath, original);
      const error = yield* Effect.flip(
        service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true }],
              config: {},
            },
          },
        }),
      );
      assert.equal(error.operation, "write-secret");
      assert.strictEqual(error.cause, cause);
      assert.equal(yield* fs.readFileString(config.settingsPath), original);
      const settings = yield* service.getSettings;
      assert.equal(
        settings.providerInstances[instanceId]?.environment?.[0]?.value,
        "inline-test-token",
      );
    }).pipe(Effect.provide(settingsLayer));
  });

  for (const { label, variable, expected, duplicate } of [
    {
      label: "preserves an inline secret on a redacted settings save",
      variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
      expected: "inline-test-token",
    },
    {
      label: "preserves the effective last inline secret when names are duplicated",
      variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
      expected: "last-inline-test-token",
      duplicate: true,
    },
    {
      label: "replaces an inline secret with an explicit value",
      variable: { name: "API_TOKEN", value: "replacement-test-token", sensitive: true },
      expected: "replacement-test-token",
    },
    {
      label: "clears an inline secret with an explicit empty value",
      variable: { name: "API_TOKEN", value: "", sensitive: true },
      expected: "",
    },
  ]) {
    it.effect(label, () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("codex_personal");
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(
          serverConfig.settingsPath,
          duplicate
            ? '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true},{"name":"API_TOKEN","value":"last-inline-test-token","sensitive":true}],"config":{}}}}'
            : '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}',
        );
        const initial = yield* serverSettings.getSettings;
        assert.equal(
          initial.providerInstances[instanceId]?.environment?.[0]?.value,
          "inline-test-token",
        );

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              displayName: "Renamed provider",
              environment: duplicate ? [variable, variable] : [variable],
              config: {},
            },
          },
        });
        assert.equal(next.providerInstances[instanceId]?.environment?.[0]?.value, expected);
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.notInclude(raw, "inline-test-token");
        assert.notInclude(raw, "replacement-test-token");

        const reloaded = yield* Effect.gen(function* () {
          const fresh = yield* ServerSettingsModule.ServerSettingsService;
          return yield* fresh.getSettings;
        }).pipe(
          Effect.provide(
            Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
          ),
        );
        assert.equal(reloaded.providerInstances[instanceId]?.environment?.[0]?.value, expected);
      }).pipe(Effect.provide(makeServerSettingsLayer())),
    );
  }

  for (const sensitiveLast of [true, false]) {
    it.effect(`preserves duplicate secret operation order (sensitive last: ${sensitiveLast})`, () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("codex_duplicate");
        const secret = { name: "API_TOKEN", value: "secret-last", sensitive: true };
        const plain = { name: "API_TOKEN", value: "plain-last", sensitive: false };
        const next = yield* service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: sensitiveLast ? [plain, secret] : [secret, plain],
              config: {},
            },
          },
        });
        assert.equal(
          next.providerInstances[instanceId]?.environment?.at(-1)?.value,
          sensitiveLast ? "secret-last" : "plain-last",
        );
        assert.equal(
          next.providerInstances[instanceId]?.environment?.find((v) => v.sensitive)?.value,
          sensitiveLast ? "secret-last" : "",
        );
      }).pipe(Effect.provide(makeServerSettingsLayer())),
    );
  }

  it.effect("stores sensitive provider instance environment values outside settings.json", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-or-secret", sensitive: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "sk-or-secret",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-or-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_personal.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Personal",
            environment: [
              { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.equal(
        roundTripped.providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-or-secret",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("materializes provider secrets for terminal environment resolution", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("neopi_terminal");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("neopi"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-terminal-secret", sensitive: true },
              { name: "OMP_PROFILE", value: "work", sensitive: false },
            ],
            config: { profile: "work" },
          },
        },
      });

      const environment = yield* resolveProviderInstanceTerminalEnvironment({ serverSettings, rawProviderInstanceId: instanceId,
      env: undefined, });
      const persisted = yield* fileSystem.readFileString(serverConfig.settingsPath);

      assert.equal(environment.OPENROUTER_API_KEY, "sk-terminal-secret");
      assert.equal(environment.OMP_PROFILE, "work");
      assert.equal(environment.CODEX_HOME, undefined);
      assert.notInclude(persisted, "sk-terminal-secret");
      assert.include(persisted, '"valueRedacted": true');
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("rolls back provider secret changes when the settings file commit fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let failRename = false;
      let settingsPathToFail: string | undefined;
      const writeFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        description: "Forced settings write failure.",
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (fromPath, toPath) =>
          failRename && toPath === settingsPathToFail
            ? Effect.fail(writeFailure)
            : fileSystem.rename(fromPath, toPath),
      });
      const instanceId = ProviderInstanceId.make("codex_write_failure");
      const settingsLayer = makeServerSettingsLayer().pipe(
        Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
      );

      yield* Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        settingsPathToFail = (yield* ServerConfig.ServerConfig).settingsPath;
        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
              config: {},
            },
          },
        });

        failRename = true;
        const failedUpdate = yield* serverSettings
          .updateSettings({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("codex"),
                environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
                config: {},
              },
            },
          })
          .pipe(Effect.result);
        assert.equal(failedUpdate._tag, "Failure");
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );

        const failed = yield* serverSettings
          .updateSettings({ providerInstances: {} })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
      }).pipe(Effect.provide(settingsLayer));
    }),
  );

  for (const failure of ["response materialization", "partially committed write"] as const) {
    it.effect(`rolls back provider secret changes after ${failure} fails`, () => {
      const textDecoder = new TextDecoder();
      const secrets = new Map<string, Uint8Array>();
      let rejectNewSecret = false;
      const secretStoreLayer = Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) =>
            Effect.suspend(() => {
              const value = secrets.get(name);
              if (
                failure === "response materialization" &&
                rejectNewSecret &&
                value !== undefined &&
                textDecoder.decode(value) === "sk-new"
              ) {
                return Effect.fail(
                  new ServerSecretStore.SecretStoreReadError({
                    resource: `secret ${name}`,
                    cause: "Forced response materialization failure.",
                  }),
                );
              }
              return Effect.succeed(
                value === undefined ? Option.none() : Option.some(Uint8Array.from(value)),
              );
            }),
          set: (name, value) =>
            Effect.suspend(() => {
              secrets.set(name, Uint8Array.from(value));
              return failure === "partially committed write" &&
                rejectNewSecret &&
                textDecoder.decode(value) === "sk-new"
                ? Effect.fail(
                    new ServerSecretStore.SecretStorePersistError({
                      resource: `secret ${name}`,
                      cause: "chmod failed after rename",
                    }),
                  )
                : Effect.void;
            }),
          create: (name, value) =>
            Effect.sync(() => {
              secrets.set(name, Uint8Array.from(value));
            }),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const value = secrets.get(name) ?? new Uint8Array(bytes);
              secrets.set(name, value);
              return Uint8Array.from(value);
            }),
          remove: (name) =>
            Effect.sync(() => {
              secrets.delete(name);
            }),
        }),
      );
      const settingsLayer = ServerSettingsModule.layer.pipe(
        Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
        Layer.provide(secretStoreLayer),
        Layer.provideMerge(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3code-server-settings-materialization-failure-test-",
            }),
          ),
        ),
      );
      const instanceId = ProviderInstanceId.make("codex_materialization_failure");

      return Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
              config: {},
            },
          },
        });

        rejectNewSecret = true;
        const failedUpdate = yield* serverSettings
          .updateSettings({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("codex"),
                environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
                config: {},
              },
            },
          })
          .pipe(Effect.result);

        assert.equal(failedUpdate._tag, "Failure");
        rejectNewSecret = false;
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
      }).pipe(Effect.provide(settingsLayer));
    });
  }

  it.effect("folds legacy project overrides into projectSettingsOverrides once", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const legacyProject = ProjectId.make("project-legacy");
      const scriptedProject = ProjectId.make("project-scripted");
      const script: ProjectScript = {
        id: "check",
        name: "Check",
        command: "npm test",
        icon: "play",
        runOnWorktreeCreate: false,
      };
      const model = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");
      const modelJson = yield* Schema.encodeEffect(Schema.fromJsonString(ModelSelection))(model);
      const scriptsJson = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Array(ProjectScript)),
      )([script]);
      for (const [projectId, modelColumn, envMode, autoPull, scripts] of [
        // The legacy project also carries aggregate scripts, but its stored
        // null override reset them; the fold must not bring them back.
        [legacyProject, modelJson, "worktree", 1, scriptsJson],
        [scriptedProject, null, null, 0, scriptsJson],
      ] as const) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            default_thread_env_mode, auto_pull, scripts_json, created_at, updated_at
          )
          VALUES (
            ${projectId}, ${"Project"}, ${`/tmp/${projectId}`}, ${modelColumn},
            ${envMode}, ${autoPull}, ${scripts},
            ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
          )
        `;
      }
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{"projectAgentBrowserAccessOverrides":{"${legacyProject}":false},"projectAutoPullOverrides":{"${scriptedProject}":true},"projectScriptOverrides":{"${legacyProject}":null}}`,
      );

      const settings = yield* serverSettings.getSettings;
      assert.isTrue(settings.projectSettingsFolded);
      assert.deepEqual<ServerSettings["projectSettingsOverrides"]>(
        settings.projectSettingsOverrides,
        {
          [legacyProject]: {
            enableAgentBrowserAccess: false,
            defaultModelSelection: model,
            defaultThreadEnvMode: "worktree",
            defaultAutoPull: true,
          },
          [scriptedProject]: { defaultAutoPull: true, defaultProjectScripts: [script] },
        },
      );
      // Derived legacy views keep older clients reading the same values.
      assert.deepEqual<ServerSettings["projectAutoPullOverrides"]>(
        settings.projectAutoPullOverrides,
        {
          [legacyProject]: true,
          [scriptedProject]: true,
        },
      );
      assert.deepEqual<ServerSettings["projectScriptOverrides"]>(settings.projectScriptOverrides, {
        [scriptedProject]: [script],
      });

      // A reset survives the next load: the fold does not run again.
      yield* serverSettings.updateSettings({
        projectSettingsOverrides: { [legacyProject]: null },
      });
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      const persisted = yield* decodeServerSettings(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.parse(raw),
      );
      assert.isTrue(persisted.projectSettingsFolded);
      assert.isUndefined(persisted.projectSettingsOverrides[legacyProject]);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("leaves an unreadable settings.json untouched instead of folding over it", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at
        )
        VALUES (
          ${"project-broken"}, ${"Project"}, ${"/tmp/project-broken"}, ${1}, ${"[]"},
          ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
        )
      `;
      const broken = '{"defaultAutoPull": tru';
      yield* fileSystem.writeFileString(serverConfig.settingsPath, broken);

      const settings = yield* serverSettings.getSettings;
      assert.isFalse(settings.projectSettingsFolded);
      assert.deepEqual(settings.projectSettingsOverrides, {});
      // The user's file is still there to repair; nothing was written over it.
      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), broken);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
