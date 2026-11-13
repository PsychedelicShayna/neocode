import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { buildTraitsTriggerDisplay } from "@t3tools/client-runtime/model-traits";
import { buildUnavailableModelOptionDescriptors, shouldRenderTraitsControls } from "./TraitsPicker";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

const fastMode = (
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> => ({
  id: "fastMode",
  label: "Fast mode",
  type: "boolean",
  currentValue,
});
const display = (descriptors: ReadonlyArray<ProviderOptionDescriptor>) =>
  buildTraitsTriggerDisplay({
    descriptors,
  });

describe("native trait speed metadata", () => {
  it("marks speed only when the native fast-mode boolean is enabled", () => {
    expect(display([fastMode(true)]).speedLabel).toBe("Fast");
    expect(display([fastMode(false)]).speedLabel).toBeNull();
    expect(display([]).speedLabel).toBeNull();
  });

  it("does not reinterpret an arbitrary service-tier selector as native fast mode", () => {
    for (const value of ["default", "priority", "flex"]) {
      const tier = selectDescriptor(
        "serviceTier",
        [
          { id: "default", label: "Standard" },
          { id: "priority", label: "Fast" },
          { id: "flex", label: "Flex" },
        ],
        value,
      );
      expect(display([tier]).speedLabel).toBeNull();
    }
  });
});

describe("native trait availability", () => {
  const provider = ProviderDriverKind.make("neopi");
  const model: ServerProviderModel = {
    slug: "anthropic/current",
    name: "Current",
    isCustom: false,
    aliases: ["native-role-model"],
    capabilities: {
      optionDescriptors: [
        { id: "native-extra", label: "Native extra", type: "boolean", currentValue: true },
      ],
    },
  };

  it("renders advertised native options without a hard-coded option-id list", () => {
    expect(
      shouldRenderTraitsControls({
        provider,
        models: [model],
        model: model.slug,
        modelOptions: undefined,
      }),
    ).toBe(true);
  });

  it("uses the native model alias without declaring its metadata unavailable", () => {
    expect(
      shouldRenderTraitsControls({
        provider,
        models: [{ ...model, capabilities: null }],
        model: "native-role-model",
        modelOptions: [{ id: "saved", value: "opaque" }],
      }),
    ).toBe(false);
  });

  it("keeps saved values visible as read-only data when native metadata is unavailable", () => {
    const modelOptions = [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ];
    expect(
      shouldRenderTraitsControls({ provider, models: [], model: "anthropic/saved", modelOptions }),
    ).toBe(true);
    expect(
      shouldRenderTraitsControls({
        provider,
        models: [],
        model: "anthropic/saved",
        modelOptions: undefined,
      }),
    ).toBe(false);
    expect(
      buildUnavailableModelOptionDescriptors(modelOptions).map(({ id, type, currentValue }) => ({
        id,
        type,
        currentValue,
      })),
    ).toEqual([
      { id: "reasoningEffort", type: "select", currentValue: "high" },
      { id: "fastMode", type: "boolean", currentValue: true },
    ]);
  });
});
