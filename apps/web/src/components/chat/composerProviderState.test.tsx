import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { getComposerProviderState } from "./composerProviderState";

const provider = ProviderDriverKind.make("neopi");
const models: ReadonlyArray<ServerProviderModel> = [{
  slug: "openai-codex/current", name: "Current", isCustom: false,
  capabilities: { optionDescriptors: [
    { id: "reasoningEffort", label: "Thinking", type: "select", options: [
      { id: "low", label: "Low" }, { id: "high", label: "High" },
    ], currentValue: "high" },
    { id: "fastMode", label: "Fast", type: "boolean", currentValue: true },
  ] },
}];

describe("NeoPi composer option projection", () => {
  it("uses native thinking and fast defaults without forcing Cursor's old Normal default", () => {
    const state = getComposerProviderState({ provider, models, model: models[0]!.slug, modelOptions: undefined });
    expect(state.promptEffort).toBe("high");
    expect(state.modelOptionsForDispatch).not.toContainEqual({ id: "fastMode", value: false });
  });

  it("preserves an explicit fast-mode opt-out", () => {
    const state = getComposerProviderState({ provider, models, model: models[0]!.slug, modelOptions: [{ id: "fastMode", value: false }] });
    expect(state.modelOptionsForDispatch).toContainEqual({ id: "fastMode", value: false });
  });

  it("keeps explicit native thinking choices independent of inference-provider labels", () => {
    const state = getComposerProviderState({ provider, models, model: models[0]!.slug, modelOptions: [{ id: "reasoningEffort", value: "low" }] });
    expect(state.promptEffort).toBe("low");
    expect(state.modelOptionsForDispatch).toContainEqual({ id: "reasoningEffort", value: "low" });
  });

  it("does not create controls or defaults a native model did not advertise", () => {
    const state = getComposerProviderState({ provider, models: [{ ...models[0]!, capabilities: null }], model: models[0]!.slug, modelOptions: undefined });
    expect(state.modelOptionsForDispatch).toBeUndefined();
    expect(state.promptEffort).toBeNull();
  });
});
