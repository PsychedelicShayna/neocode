import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "./providerInstances";
import {
  getAppModelOptionsForInstance,
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
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

it("preserves newly selected native roles and virtual IDs before the catalog refreshes", () => {
  const work = provider("work", { models: [model("cached/default", true)] });
  const personal = provider("personal", { models: [model("personal/default", true)] });
  for (const selector of ["@new-project-role", "custom-route/virtual/Review.V2:Exact"]) {
    expect(
      resolveAppModelSelectionForInstance(work.instanceId, settings(), [work, personal], selector),
    ).toBe(selector);
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
