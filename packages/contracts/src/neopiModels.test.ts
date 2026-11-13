import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NeoPiModelsAuthRespond, NeoPiModelsAuthState, NeoPiNativeModel } from "./neopiModels.ts";

const decodeNativeModel = Schema.decodeEffect(NeoPiNativeModel);
const encodeNativeModel = Schema.encodeEffect(NeoPiNativeModel);

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
            const decoded = yield* decodeNativeModel(input);
            const encoded = yield* encodeNativeModel(decoded);
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

describe("native Models login contract", () => {
  it("requires a real boolean for confirmation responses", () => {
    const decode = Schema.decodeUnknownOption(NeoPiModelsAuthRespond);
    for (const confirmed of [true, false]) {
      expect(decode({ flowId: "login", requestId: "dialog", confirmed })._tag).toBe("Some");
    }
    for (const confirmed of ["yes", "true", 1, null, undefined]) {
      expect(decode({ flowId: "login", requestId: "dialog", confirmed })._tag).toBe("None");
    }
    expect(decode({ flowId: "login", requestId: "dialog", value: "yes" })._tag).toBe("Some");
  });

  it("rejects incomplete prompts and payloads from the wrong prompt kind", () => {
    const decode = Schema.decodeUnknownOption(NeoPiModelsAuthState);
    const state = {
      flowId: "login",
      status: "running",
      message: null,
      url: null,
      instructions: null,
      userCode: null,
    };
    const input = {
      kind: "input",
      id: "member-key",
      title: "Member key",
      placeholder: null,
      secret: true,
    };
    const confirm = {
      kind: "confirm",
      id: "certificate",
      title: "Verify certificate",
      message:
        "https://office.example\nServer SHA256: complete fingerprint\nCompare with your administrator.",
    };
    for (const prompt of [
      { ...input, kind: undefined },
      { ...input, kind: "confirm" },
      { ...confirm, kind: "input" },
      { ...confirm, message: undefined },
      { ...input, secret: undefined },
    ]) {
      expect(decode({ ...state, prompt })._tag).toBe("None");
    }
  });
});
