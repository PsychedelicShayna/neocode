import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries, NO_PROVIDER_MODEL_SELECTION } from "./providerInstances";
import {
  getAppModelOptionsForInstance,
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
} from "./modelSelection";

const model = (slug: string, isDefault = false) => ({
  slug,
  name: slug,
  isDefault,
  isCustom: false,
  capabilities: null,
});
const provider = (id = "neopi", overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  driver: ProviderDriverKind.make("neopi"),
  instanceId: ProviderInstanceId.make(id),
  enabled: true,
  installed: true,
  status: "ready",
  version: "1.0.0",
  auth: { status: "unknown" },
  checkedAt: "2026-10-22T00:00:00.000Z",
  models: [model("openai-codex/current", true), model("anthropic/current")],
  skills: [],
  slashCommands: [],
  ...overrides,
});
const settings = (overrides: Partial<UnifiedSettings> = {}): UnifiedSettings => ({
  ...DEFAULT_UNIFIED_SETTINGS,
  ...overrides,
});

it("replaces an obsolete runtime default without carrying its model or options into NeoPi", () => {
  const old = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "old-model",
    options: [{ id: "effort", value: "max" }],
  };
  const configured = settings({ textGenerationModelSelection: old });
  const legacy = provider("claudeAgent", { driver: ProviderDriverKind.make("claudeAgent") });
  expect(resolveAppModelSelectionState(configured, [legacy, provider()])).toEqual({
    instanceId: ProviderInstanceId.make("neopi"),
    model: "openai-codex/current",
  });
  expect(configured.textGenerationModelSelection).toBe(old);
});

it("preserves explicit NeoPi instance and inference-provider selection", () => {
  const selected = { instanceId: ProviderInstanceId.make("personal"), model: "anthropic/current" };
  expect(
    resolveAppModelSelectionState(settings({ textGenerationModelSelection: selected }), [
      provider(),
      provider("personal"),
    ]),
  ).toEqual(selected);
});

it("preserves newly selected native roles and virtual IDs before the catalog refreshes", () => {
  const work = provider("work", { models: [model("cached/default", true)] });
  const personal = provider("personal", { models: [model("personal/default", true)] });
  for (const selector of ["@new-project-role", "custom-route/virtual/Review.V2:Exact"]) {
    const selected = { instanceId: work.instanceId, model: selector };
    expect(
      resolveAppModelSelectionForInstance(work.instanceId, settings(), [work, personal], selector),
    ).toBe(selector);
    expect(
      resolveAppModelSelectionState(settings({ textGenerationModelSelection: selected }), [
        work,
        personal,
      ]),
    ).toEqual(selected);
  }
});

it("does not expose old runtime models as selectable instance options", () => {
  const legacy = provider("codex", { driver: ProviderDriverKind.make("codex") });
  expect(
    resolveAppModelSelectionForInstance(
      legacy.instanceId,
      settings(),
      [legacy],
      "openai-codex/current",
    ),
  ).toBeNull();
  expect([...getCustomModelOptionsByInstance(settings(), [legacy, provider()]).keys()]).toEqual([
    ProviderInstanceId.make("neopi"),
  ]);
});

it("retains the complete native inference-provider catalog", () => {
  const models = [
    model("openai-codex/a"),
    model("anthropic/b"),
    model("cursor/c"),
    model("openrouter/d"),
    model("google/e"),
  ];
  const [entry] = deriveProviderInstanceEntries([provider("neopi", { models })]);
  expect(getAppModelOptionsForInstance(settings(), entry!).map((option) => option.slug)).toEqual(
    models.map((entry) => entry.slug),
  );
});

it("keeps custom-model settings scoped to their NeoPi instance", () => {
  const personal = provider("personal");
  const work = provider("work");
  const configured = settings({
    providerInstances: {
      [personal.instanceId]: {
        driver: personal.driver,
        config: { customModels: ["custom-personal"] },
      },
      [work.instanceId]: { driver: work.driver, config: { customModels: ["custom-work"] } },
    },
  });
  const options = getCustomModelOptionsByInstance(configured, [personal, work]);
  expect(
    options.get(personal.instanceId)?.some((option) => option.slug === "custom-personal"),
  ).toBe(true);
  expect(options.get(personal.instanceId)?.some((option) => option.slug === "custom-work")).toBe(
    false,
  );
});

it("respects hidden native models and the instance model order", () => {
  const current = provider();
  const configured = settings({
    providerModelPreferences: {
      [current.instanceId]: {
        hiddenModels: ["openai-codex/current"],
        modelOrder: ["anthropic/current"],
      },
    },
  });
  const [entry] = deriveProviderInstanceEntries([current]);
  expect(getAppModelOptionsForInstance(configured, entry!).map((option) => option.slug)).toEqual([
    "anthropic/current",
  ]);
});

it("retains a missing native selection and shows it as unavailable in the cached catalog", () => {
  const current = provider();
  const configured = settings();
  expect(
    resolveAppModelSelectionForInstance(
      current.instanceId,
      configured,
      [current],
      "anthropic/retired",
      { preserveUnavailableSelection: true },
    ),
  ).toBe("anthropic/retired");
  expect(
    resolveAppModelSelectionForInstance(
      current.instanceId,
      configured,
      [current],
      "anthropic/retired",
    ),
  ).toBe("anthropic/retired");
  const [entry] = deriveProviderInstanceEntries([current]);
  expect(
    getAppModelOptionsForInstance(configured, entry!, "anthropic/retired").find(
      (option) => option.slug === "anthropic/retired",
    )?.isUnavailable,
  ).toBe(true);
});

it("does not invent a usable model when no NeoPi catalog is available", () => {
  const legacy = provider("codex", { driver: ProviderDriverKind.make("codex") });
  expect(resolveAppModelSelectionState(settings(), [legacy])).toEqual(NO_PROVIDER_MODEL_SELECTION);
  expect(
    resolveAppModelSelectionState(
      settings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("removed"),
          model: "old",
        },
      }),
      [provider("neopi", { models: [] })],
    ),
  ).toEqual(NO_PROVIDER_MODEL_SELECTION);
});
