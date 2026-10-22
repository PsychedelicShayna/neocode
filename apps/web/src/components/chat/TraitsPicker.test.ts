import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor, type ServerProviderModel } from "@t3tools/contracts";
import { buildTraitsTriggerDisplay, buildUnavailableModelOptionDescriptors, shouldRenderTraitsControls } from "./TraitsPicker";

function selectDescriptor(id: string, options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>, currentValue: string): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}
const fastMode = (currentValue: boolean): Extract<ProviderOptionDescriptor, { type: "boolean" }> => ({ id: "fastMode", label: "Fast mode", type: "boolean", currentValue });
const THINKING = selectDescriptor("reasoningEffort", [{ id: "high", label: "High" }, { id: "max", label: "Max" }], "high");
const CONTEXT = selectDescriptor("contextWindow", [{ id: "200k", label: "200k" }, { id: "1m", label: "1M" }], "1m");
const display = (descriptors: ReadonlyArray<ProviderOptionDescriptor>) => buildTraitsTriggerDisplay({ descriptors });

describe("native trait trigger display", () => {
  it("shows thinking and context without a false fast-mode indicator", () => {
    expect(display([THINKING, fastMode(false), CONTEXT])).toEqual({ label: "High · 1M", showFastModeIcon: false });
  });
  it("shows the bolt only for an advertised native fast-mode boolean", () => {
    expect(display([THINKING, fastMode(true), CONTEXT])).toEqual({ label: "High · 1M", showFastModeIcon: true });
  });
  it("does not reinterpret an arbitrary service-tier selector as Codex fast mode", () => {
    const tier = (value: string) => selectDescriptor("serviceTier", [{ id: "default", label: "Standard" }, { id: "priority", label: "Fast" }, { id: "flex", label: "Flex" }], value);
    expect(display([THINKING, tier("default")])).toEqual({ label: "High · Standard", showFastModeIcon: false });
    expect(display([THINKING, tier("priority")])).toEqual({ label: "High · Fast", showFastModeIcon: false });
    expect(display([THINKING, tier("flex")])).toEqual({ label: "High · Flex", showFastModeIcon: false });
  });
  it("keeps other native boolean controls as text", () => {
    const enabled: ProviderOptionDescriptor = { id: "native-toggle", label: "Native toggle", type: "boolean", currentValue: true };
    expect(display([THINKING, enabled])).toEqual({ label: "High · Native toggle On", showFastModeIcon: false });
  });
  it("uses text when fast mode is the only trait", () => {
    expect(display([fastMode(true)])).toEqual({ label: "Fast", showFastModeIcon: false });
    expect(display([fastMode(false)])).toEqual({ label: "Normal", showFastModeIcon: false });
  });
  it("does not invent a Normal label without fast-mode metadata", () => {
    const unresolved: ProviderOptionDescriptor = { id: "reasoningEffort", label: "Thinking", type: "select", options: [{ id: "low", label: "Low" }] };
    expect(display([unresolved])).toEqual({ label: "", showFastModeIcon: false });
    expect(display([])).toEqual({ label: "", showFastModeIcon: false });
  });
});

describe("native trait availability", () => {
  const provider = ProviderDriverKind.make("neopi");
  const model: ServerProviderModel = { slug: "anthropic/current", name: "Current", isCustom: false, aliases: ["native-role-model"], capabilities: { optionDescriptors: [{ id: "native-extra", label: "Native extra", type: "boolean", currentValue: true }] } };
  it("renders advertised native options without a hard-coded option-id list", () => {
    expect(shouldRenderTraitsControls({ provider, models: [model], model: model.slug, modelOptions: undefined })).toBe(true);
  });
  it("uses the native model alias without declaring its metadata unavailable", () => {
    expect(shouldRenderTraitsControls({ provider, models: [{ ...model, capabilities: null }], model: "native-role-model", modelOptions: [{ id: "saved", value: "opaque" }] })).toBe(false);
  });
  it("keeps saved values visible as read-only data when native metadata is unavailable", () => {
    expect(shouldRenderTraitsControls({ provider, models: [], model: "anthropic/saved", modelOptions: [{ id: "reasoningEffort", value: "high" }] })).toBe(true);
    expect(shouldRenderTraitsControls({ provider, models: [], model: "anthropic/saved", modelOptions: undefined })).toBe(false);
    expect(buildUnavailableModelOptionDescriptors([{ id: "reasoningEffort", value: "high" }, { id: "fastMode", value: true }])).toEqual([
      { id: "reasoningEffort", label: "Reasoning effort", type: "select", options: [{ id: "high", label: "high" }], currentValue: "high" },
      { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: true },
    ]);
  });
});
