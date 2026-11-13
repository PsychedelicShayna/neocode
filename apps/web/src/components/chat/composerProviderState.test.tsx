import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { getComposerProviderState, getComposerReasoningStep } from "./composerProviderState";

const PROVIDER = ProviderDriverKind.make("neopi");
const MODEL = "native/model";
const INSTANCE = ProviderInstanceId.make("neopi");

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  const defaultId = options.find((option) => option.isDefault)?.id;
  return {
    id,
    label: id,
    type: "select",
    options: [...options],
    ...(defaultId ? { currentValue: defaultId } : {}),
  };
}

function booleanDescriptor(
  id: string,
  currentValue?: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return {
    id,
    label: id,
    type: "boolean",
    ...(typeof currentValue === "boolean" ? { currentValue } : {}),
  };
}

function modelWith(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return [
    { slug: MODEL, name: MODEL, isCustom: false, capabilities: { optionDescriptors: descriptors } },
  ];
}

function selections(
  ...entries: Array<[string, string | boolean]>
): ReadonlyArray<ProviderOptionSelection> {
  return entries.map(([id, value]) => ({ id, value }));
}

describe("native composer options", () => {
  it("does not turn native defaults into explicit dispatch overrides", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("reasoningEffort", [{ id: "high", label: "High", isDefault: true }]),
        booleanDescriptor("fastMode", true),
      ]),
      modelOptions: undefined,
    });
    expect(state.modelOptionsForDispatch).toBeUndefined();
  });

  it("preserves explicit native defaults and a fast-mode opt-out", () => {
    const explicit = selections(["reasoningEffort", "high"], ["fastMode", false]);
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("reasoningEffort", [{ id: "high", label: "High", isDefault: true }]),
        booleanDescriptor("fastMode", true),
      ]),
      modelOptions: explicit,
    });
    expect(state.modelOptionsForDispatch).toEqual(explicit);
  });

  it("validates known-model options through aliases without filtering native agent choices", () => {
    const models = modelWith([
      selectDescriptor("effort", [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
      ]),
      selectDescriptor("agent", [
        { id: "build", label: "Build", isDefault: true },
        { id: "plan", label: "Plan" },
      ]),
    ]).map((model) => ({ ...model, aliases: ["native-role-model"] }));
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: "native-role-model",
      models,
      modelOptions: selections(["effort", "low"], ["agent", "plan"], ["unknown", "value"]),
    });
    expect(state.modelOptionsForDispatch).toEqual(selections(["effort", "low"], ["agent", "plan"]));
  });

  it("preserves saved native options when the selected model is absent", () => {
    const saved = selections(["variant", "max"], ["agent", "build"]);
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: "native/missing",
      models: modelWith([]),
      modelOptions: saved,
    });
    expect(state.modelOptionsForDispatch).toEqual(saved);
  });

  it("does not invent controls when the native model has no capability metadata", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: [{ slug: MODEL, name: MODEL, isCustom: false, capabilities: null }],
      modelOptions: undefined,
    });
    expect(state.modelOptionsForDispatch).toBeUndefined();
  });
});

describe("native reasoning steps", () => {
  const levels = [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ];
  function step(input: Partial<Parameters<typeof getComposerReasoningStep>[0]>) {
    return getComposerReasoningStep({
      provider: PROVIDER,
      instanceId: INSTANCE,
      model: MODEL,
      models: modelWith([selectDescriptor("reasoningEffort", levels)]),
      modelOptions: undefined,
      direction: 1,
      ...input,
    });
  }

  it("wraps in catalog order while preserving unrelated native traits", () => {
    const models = modelWith([
      selectDescriptor("contextWindow", [
        { id: "200k", label: "200k", isDefault: true },
        { id: "1m", label: "1M" },
      ]),
      selectDescriptor("reasoningEffort", levels),
      booleanDescriptor("fastMode", true),
    ]);
    for (const [from, direction, to] of [
      ["low", -1, "high"],
      ["low", 1, "medium"],
      ["high", 1, "low"],
      ["high", -1, "medium"],
    ] as const) {
      expect(
        step({
          models,
          modelOptions: selections(
            ["contextWindow", "1m"],
            ["reasoningEffort", from],
            ["fastMode", true],
          ),
          direction,
        }),
      ).toEqual(selections(["contextWindow", "1m"], ["reasoningEffort", to], ["fastMode", true]));
    }
  });

  it("recognizes an opaque reasoning descriptor by its advertised role", () => {
    expect(
      step({
        models: modelWith([{ ...selectDescriptor("native-level", levels), role: "reasoning" }]),
      }),
    ).toEqual(selections(["native-level", "high"]));
  });

  it("uses reported effort only for the matching native instance and model", () => {
    const reported = {
      instanceId: INSTANCE,
      model: MODEL,
      options: selections(["reasoningEffort", "high"]),
    };
    for (const { modelOptions, reportedModelSelection, to } of [
      { modelOptions: undefined, reportedModelSelection: reported, to: "low" },
      {
        modelOptions: undefined,
        reportedModelSelection: { ...reported, instanceId: ProviderInstanceId.make("neopi-other") },
        to: "high",
      },
      {
        modelOptions: undefined,
        reportedModelSelection: { ...reported, model: "other-model" },
        to: "high",
      },
      {
        modelOptions: selections(["reasoningEffort", "low"]),
        reportedModelSelection: reported,
        to: "medium",
      },
      {
        modelOptions: undefined,
        reportedModelSelection: {
          ...reported,
          options: selections(["reasoningEffort", "outside-catalog"]),
        },
        to: "high",
      },
    ]) {
      expect(step({ modelOptions, reportedModelSelection })).toEqual(
        selections(["reasoningEffort", to]),
      );
    }
  });
});
