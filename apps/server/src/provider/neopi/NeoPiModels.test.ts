import { describe, expect, it } from "@effect/vitest";
import { NeoPiModelsError, type NeoPiModelsConfiguration } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { readNativeModelsConfiguration } from "./NeoPiModels.ts";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";

const configuration: NeoPiModelsConfiguration = {
  providers: [{ id: "future-provider", name: "Future provider", mark: { text: "FP", seed: "future-provider", icon: "provider:future-provider" }, authenticated: false, authSource: null, available: true, disabled: false, loginProviders: [], envVars: [] }],
  models: [{ provider: "future-provider", id: "virtual/model", name: "Virtual model", kind: "chat", available: true, contextWindow: 200000, effectiveContextWindow: 120000, maxTokens: 40000, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, supportsFastMode: false, supportedThinkingLevels: ["off", "low"], permittedEfforts: ["off"] }],
  roles: [], roleStorage: "project", effortMode: "replacement", effortRules: [{ selector: "re:^future-provider/", allowed: ["off"] }], effortRulesProvenance: "project", effortRuleScopes: { global: null, project: [{ selector: "re:^future-provider/", allowed: ["off"] }] }, effortChoices: ["off", "low"],
};
const connection = (input: Partial<NeoPiModelsConnection> = {}): NeoPiModelsConnection => ({
  capabilities: new Set(["models_configuration"]), request: () => Effect.succeed(configuration), respondUi: () => Effect.void,
  validate: Effect.void, ui: Stream.empty, changes: Stream.empty, ...input,
});

describe("native Models read boundary", () => {
  it.effect("accepts native future providers and virtual model IDs without remapping their rules or effective budget", () => Effect.gen(function* () {
    const result = yield* readNativeModelsConfiguration(connection());
    expect(result).toEqual(configuration);
    expect(result.models[0]?.effectiveContextWindow).toBe(120000);
    expect(result.models[0]?.permittedEfforts).toEqual(["off"]);
  }));

  it.effect("rejects an unavailable native contract without invoking its command", () => Effect.gen(function* () {
    let requested = false;
    const result = yield* Effect.result(readNativeModelsConfiguration(connection({ capabilities: new Set(), request: () => Effect.sync(() => { requested = true; return configuration; }) })));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("does not advertise models_configuration");
    expect(requested).toBe(false);
  }));

  it.effect("does not read a replacement native session through an obsolete binding", () => Effect.gen(function* () {
    let requested = false;
    const result = yield* Effect.result(readNativeModelsConfiguration(connection({ validate: Effect.fail(new NeoPiModelsError({ message: "Native session identity changed" })), request: () => Effect.sync(() => { requested = true; return configuration; }) })));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toBe("Native session identity changed");
    expect(requested).toBe(false);
  }));

  it.effect("reports incompatible snapshots without returning unrecognized credential bytes", () => Effect.gen(function* () {
    const result = yield* Effect.result(readNativeModelsConfiguration(connection({ request: () => Effect.succeed({ credential: "private-fixture-secret" }) })));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("incompatible Models configuration");
      expect(result.failure.message).not.toContain("private-fixture-secret");
    }
  }));
});
