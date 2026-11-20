import { describe, expect, it } from "@effect/vitest";
import {
  NeoPiModelsError,
  ProviderInstanceId,
  type NeoPiModelsConfiguration,
  type NeoPiModelsUpdate,
} from "@t3tools/contracts";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { readNativeModelsConfiguration, updateNativeModelsConfiguration } from "./NeoPiModels.ts";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";

const configuration: NeoPiModelsConfiguration = {
  providers: [
    {
      id: "future-provider",
      name: "Future provider",
      mark: { text: "FP", seed: "future-provider", icon: "provider:future-provider" },
      authenticated: false,
      authSource: null,
      available: true,
      disabled: false,
      acceptsKeys: true,
      loginProviders: [
        {
          id: "future-provider-device",
          name: "Device login",
          available: true,
          loginKind: "device-code",
          deviceCode: true,
          storeCredentialsAs: "future-provider",
        },
      ],
      envVars: [],
      discovery: null,
    },
  ],
  models: [
    {
      provider: "future-provider",
      id: "virtual/model",
      description: "A complete native model description",
      name: "Virtual model",
      kind: "chat",
      available: true,
      contextWindow: 200000,
      effectiveContextWindow: 120000,
      maxTokens: 40000,
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      supportsFastMode: false,
      supportedThinkingLevels: ["off", "low"],
      permittedEfforts: ["off"],
    },
  ],
  roles: [
    {
      id: "review",
      name: "Review",
      alias: "@review",
      hidden: false,
      source: "configured",
      section: "chat",
      patterns: ["@advisor"],
      configured: "@advisor",
      resolved: { provider: "runtime", modelId: "overlay" },
      scopedResolutions: {
        global: { provider: "future-provider", modelId: "virtual/global" },
        project: { provider: "future-provider", modelId: "virtual/project" },
      },
      fallbacks: { chain: ["@smol"], efforts: { "@smol": { mode: "fixed", level: "low" } } },
      fallbacksGlobal: { chain: [], efforts: {} },
      provenance: "project",
      effort: null,
      global: { selector: "future-provider/virtual/global", effort: null },
      project: { selector: "@advisor", effort: null },
    },
  ],
  roleStorage: "project",
  effortMode: "replacement",
  effortRules: [{ selector: "re:^future-provider/", allowed: ["off"] }],
  effortRulesProvenance: "project",
  effortRuleScopes: {
    global: null,
    project: [{ selector: "re:^future-provider/", allowed: ["off"] }],
  },
  effortChoices: ["off", "low"],
};
const connection = (input: Partial<NeoPiModelsConnection> = {}): NeoPiModelsConnection => ({
  capabilities: new Set(["models_configuration"]),
  request: () => Effect.succeed(configuration),
  respondUi: () => Effect.void,
  validate: Effect.void,
  loginUi: () => Effect.succeed(Stream.empty),
  changes: Stream.empty,
  ...input,
});

describe("native Models read boundary", () => {
  it.effect(
    "accepts native future providers and virtual model IDs without remapping their rules or effective budget",
    () =>
      Effect.gen(function* () {
        const result = yield* readNativeModelsConfiguration(connection());
        expect(result).toEqual(configuration);
        expect(result.models[0]?.effectiveContextWindow).toBe(120000);
        expect(result.models[0]?.permittedEfforts).toEqual(["off"]);
        expect(result.roles[0]?.scopedResolutions.global?.modelId).toBe("virtual/global");
        expect(result.roles[0]?.scopedResolutions.project?.modelId).toBe("virtual/project");
        expect(result.roles[0]?.resolved?.provider).toBe("runtime");
        expect(result.providers[0]?.loginProviders[0]?.id).toBe("future-provider-device");
      }),
  );

  it.effect("retains native unknown catalog limits and zero effective budgets", () =>
    Effect.gen(function* () {
      const snapshot = {
        ...configuration,
        models: configuration.models.map((model) => ({
          ...model,
          contextWindow: null,
          maxTokens: null,
          effectiveContextWindow: 0,
        })),
      };
      const result = yield* readNativeModelsConfiguration(
        connection({
          request: () => Effect.succeed(snapshot),
        }),
      );
      expect(result).toEqual(snapshot);
      expect(result.models[0]?.contextWindow).toBeNull();
      expect(result.models[0]?.maxTokens).toBeNull();
      expect(result.models[0]?.effectiveContextWindow).toBe(0);
    }),
  );

  it.effect("identifies the invalid nested contract field without exposing its value", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        readNativeModelsConfiguration(
          connection({
            request: () =>
              Effect.succeed({
                ...configuration,
                models: configuration.models.map((model) => ({
                  ...model,
                  effectiveContextWindow: "private-budget-fixture-secret",
                })),
              }),
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(NeoPiModelsError);
        expect(result.failure.message).toContain('["models"][0]["effectiveContextWindow"]');
        expect(result.failure.message).toMatch(/expected number/i);
        expect(result.failure.message).toContain("configured NeoPi executable");
        expect(result.failure.message).not.toContain("private-budget-fixture-secret");
      }
    }),
  );

  it.effect("rejects an unavailable native contract without invoking its command", () =>
    Effect.gen(function* () {
      let requested = false;
      const result = yield* Effect.result(
        readNativeModelsConfiguration(
          connection({
            capabilities: new Set(),
            request: () =>
              Effect.sync(() => {
                requested = true;
                return configuration;
              }),
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toContain("does not advertise models_configuration");
      expect(requested).toBe(false);
    }),
  );

  it.effect("does not read a replacement native session through an obsolete binding", () =>
    Effect.gen(function* () {
      let requested = false;
      const result = yield* Effect.result(
        readNativeModelsConfiguration(
          connection({
            validate: Effect.fail(
              new NeoPiModelsError({ message: "Native session identity changed" }),
            ),
            request: () =>
              Effect.sync(() => {
                requested = true;
                return configuration;
              }),
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toBe("Native session identity changed");
      expect(requested).toBe(false);
    }),
  );

  it.effect("reports incompatible snapshots without returning unrecognized credential bytes", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        readNativeModelsConfiguration(
          connection({ request: () => Effect.succeed({ credential: "private-fixture-secret" }) }),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("incompatible Models configuration");
        expect(result.failure.message).not.toContain("private-fixture-secret");
      }
    }),
  );
});

describe("native Models mutation ownership", () => {
  const target = { providerInstanceId: ProviderInstanceId.make("models-test") };
  it.effect(
    "writes the explicit project scope without changing the global storage preference",
    () =>
      Effect.gen(function* () {
        const commands: unknown[] = [];
        const change: NeoPiModelsUpdate["change"] = {
          operation: "role",
          role: "review",
          scope: "project",
          selector: "@advisor",
          expected: { selector: null, effort: null },
        };
        const result = yield* updateNativeModelsConfiguration(
          connection({
            request: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { ...configuration, roleStorage: "global" };
              }),
          }),
          { target, change },
        );
        expect(result.roleStorage).toBe("global");
        expect(commands).toEqual([
          {
            type: "set_model_role_configuration",
            role: "review",
            scope: "project",
            selector: "@advisor",
            expected: { selector: null, effort: null },
          },
          { type: "get_models_configuration" },
        ]);
      }),
  );

  it.effect(
    "sends fallback metadata CAS and an empty-chain clear to their real native operations",
    () =>
      Effect.gen(function* () {
        const commands: unknown[] = [];
        const native = connection({
          request: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return configuration;
            }),
        });
        yield* updateNativeModelsConfiguration(native, {
          target,
          change: {
            operation: "fallbacks",
            role: "review",
            scope: "global",
            chain: [],
            efforts: {},
            expected: { chain: ["@smol"], efforts: { "@smol": { mode: "fixed", level: "low" } } },
          },
        });
        yield* updateNativeModelsConfiguration(native, {
          target,
          change: {
            operation: "description",
            role: "review",
            scope: "global",
            description: "Review changes",
            expected: null,
          },
        });
        yield* updateNativeModelsConfiguration(native, {
          target,
          change: {
            operation: "deleteRole",
            role: "review",
            scope: "project",
            expected: { selector: "@advisor", effort: null },
          },
        });
        expect(commands).toEqual([
          {
            type: "set_model_role_fallbacks",
            role: "review",
            scope: "global",
            chain: [],
            efforts: {},
            expected: { chain: ["@smol"], efforts: { "@smol": { mode: "fixed", level: "low" } } },
          },
          { type: "get_models_configuration" },
          {
            type: "set_model_role_description",
            role: "review",
            scope: "global",
            description: "Review changes",
            expected: null,
          },
          { type: "get_models_configuration" },
          {
            type: "delete_model_role",
            role: "review",
            scope: "project",
            expected: { selector: "@advisor", effort: null },
          },
          { type: "get_models_configuration" },
        ]);
      }),
  );

  it.effect("does not activate an account in an ephemeral project configuration connection", () =>
    Effect.gen(function* () {
      const commands: unknown[] = [];
      const native = connection({
        request: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return configuration;
          }),
      });
      const change: NeoPiModelsUpdate["change"] = {
        operation: "activateAccount",
        providerId: "future-provider",
        credentialId: 42,
      };
      const rejected = yield* Effect.result(
        updateNativeModelsConfiguration(native, { target, change }),
      );
      expect(rejected._tag).toBe("Failure");
      expect(commands).toEqual([]);
      yield* updateNativeModelsConfiguration(native, {
        target: { ...target, sessionFile: "/sessions/canonical.jsonl" },
        change,
      });
      expect(commands).toEqual([
        { type: "activate_account", providerId: "future-provider", credentialId: 42 },
        { type: "get_models_configuration" },
      ]);
    }),
  );

  it.effect(
    "preserves native invalid-pattern diagnostics and does not read or retry a rejected mutation",
    () =>
      Effect.gen(function* () {
        const commands: unknown[] = [];
        const result = yield* Effect.result(
          updateNativeModelsConfiguration(
            connection({
              request: (command) => {
                commands.push(command);
                return Effect.fail(
                  new NeoPiRpcError({
                    code: "invalid_value",
                    message: "Invalid model selector glob",
                  }),
                );
              },
            }),
            {
              target,
              change: {
                operation: "rules",
                scope: "project",
                rules: [{ selector: "provider/[", allowed: ["low"] }],
                expected: null,
              },
            },
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            code: "invalid_value",
            message: "Invalid model selector glob",
          });
        expect(commands).toHaveLength(1);
      }),
  );
});
