import { describe, expect, it } from "@effect/vitest";
import { NeoPiModelsError, type NeoPiModelSelectorResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { queryNativeModelSelector } from "./NeoPiModels.ts";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";

const facts = { intelligence: null, ttftMs: null, tokensPerSecond: null, contextWindow: 200000, effectiveContextWindow: 120000, inputCostPerMillion: 0, outputCostPerMillion: null, performanceSource: null, serviceTier: null };
const response: NeoPiModelSelectorResult = {
  items: [
    { selector: "future/virtual/Zed:Exact", provider: "future", id: "virtual/Zed:Exact", name: "Zed", resolvedSelector: "future/virtual/Zed:Exact", facts },
    { selector: "future/alpha", provider: "future", id: "alpha", name: "Alpha", resolvedSelector: "future/alpha", facts },
  ],
  roles: [{ selector: "@review", provider: "future", id: "review", name: "Review", description: "Read the diff", resolvedSelector: "future/virtual/Zed:Exact", facts }],
  error: null,
};
const connection = (overrides: Partial<NeoPiModelsConnection> = {}): NeoPiModelsConnection => ({
  capabilities: new Set(["model_selector"]), validate: Effect.void,
  request: () => Effect.succeed(response), respondUi: () => Effect.void,
  ui: Stream.empty, changes: Stream.empty, ...overrides,
});

describe("native model selector read boundary", () => {
  it.effect("forwards the exact query and returns native rank, role IDs and effective facts unchanged", () => Effect.gen(function* () {
    const commands: unknown[] = [];
    let validations = 0;
    const result = yield* queryNativeModelSelector(connection({
      request: command => Effect.sync(() => { commands.push(command); return response; }),
      validate: Effect.sync(() => { validations++; }),
    }), "Zed:Exact");
    expect(commands).toEqual([{ type: "query_model_selector", query: "Zed:Exact" }]);
    expect(result).toEqual(response);
    expect(validations).toBe(2);
  }));

  it.effect("does not call a native executable without the advertised contract", () => Effect.gen(function* () {
    let requested = false;
    const result = yield* Effect.result(queryNativeModelSelector(connection({
      capabilities: new Set(), request: () => Effect.sync(() => { requested = true; return response; }),
    }), "query"));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("does not advertise model_selector");
    expect(requested).toBe(false);
  }));

  it.effect("does not query through an obsolete session binding", () => Effect.gen(function* () {
    let requested = false;
    const result = yield* Effect.result(queryNativeModelSelector(connection({
      validate: Effect.fail(new NeoPiModelsError({ message: "Native session identity changed" })),
      request: () => Effect.sync(() => { requested = true; return response; }),
    }), ""));
    expect(result._tag).toBe("Failure");
    expect(requested).toBe(false);
  }));

  it.effect("discards a response if the connected session changed during the native query", () => Effect.gen(function* () {
    let validations = 0;
    const result = yield* Effect.result(queryNativeModelSelector(connection({
      validate: Effect.suspend(() => ++validations === 1 ? Effect.void : Effect.fail(new NeoPiModelsError({ message: "Native session identity changed" }))),
    }), ""));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toBe("Native session identity changed");
  }));

  it.effect("returns native query errors without falling back to substring matching", () => Effect.gen(function* () {
    const errorResponse = { items: [], roles: [], error: "Invalid selector" };
    const result = yield* queryNativeModelSelector(connection({ request: () => Effect.succeed(errorResponse) }), "invalid");
    expect(result).toEqual(errorResponse);
  }));

  it.effect("rejects incompatible rows without exposing unrecognized native data", () => Effect.gen(function* () {
    const result = yield* Effect.result(queryNativeModelSelector(connection({ request: () => Effect.succeed({ private: "fixture-secret" }) }), ""));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("incompatible model selector response");
      expect(result.failure.message).not.toContain("fixture-secret");
    }
  }));
});
