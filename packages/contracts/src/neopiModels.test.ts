import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NeoPiModelsTarget, NeoPiNativeModel } from "./neopiModels.ts";

const model = {
  provider: "native-provider",
  id: "unknown-limits",
  name: "Unknown limits",
  kind: "chat",
  available: false,
  contextWindow: null,
  effectiveContextWindow: 0,
  maxTokens: null,
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  supportsFastMode: false,
  supportedThinkingLevels: [],
  permittedEfforts: [],
} satisfies typeof NeoPiNativeModel.Encoded;

describe("native Models catalog contract", () => {
  it.effect(
    "preserves independently unknown catalog limits and zero numeric values on the wire",
    () =>
      Effect.gen(function* () {
        for (const contextWindow of [null, 0, 200000]) {
          for (const maxTokens of [null, 0, 32000]) {
            const input = { ...model, contextWindow, maxTokens };
            const decoded = yield* Schema.decodeUnknownEffect(NeoPiNativeModel)(input);
            const encoded = yield* Schema.encodeEffect(NeoPiNativeModel)(decoded);
            expect(encoded).toEqual(input);
          }
        }
      }),
  );

  it("does not treat absent limits, numeric strings, or an unknown effective budget as native values", () => {
    const decode = Schema.decodeUnknownOption(NeoPiNativeModel);
    const { contextWindow: _contextWindow, ...withoutContext } = model;
    const { maxTokens: _maxTokens, ...withoutOutput } = model;
    for (const input of [
      withoutContext,
      withoutOutput,
      { ...model, contextWindow: "200000" },
      { ...model, maxTokens: "32000" },
      { ...model, effectiveContextWindow: null },
      { ...model, cost: { ...model.cost, input: null } },
    ]) {
      expect(decode(input)._tag).toBe("None");
    }
  });
});

describe("native Models target", () => {
  it("rejects an archived SQL thread target instead of treating it as global configuration", () => {
    const decoded = Schema.decodeUnknownOption(NeoPiModelsTarget)({
      providerInstanceId: "neopi",
      threadId: "saved-sql-thread",
    });
    expect(decoded._tag).toBe("None");
  });
});
