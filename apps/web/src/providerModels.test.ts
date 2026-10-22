import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderModelCapabilities, resolveSelectableProvider } from "./providerModels";

const PROVIDER = ProviderDriverKind.make("claudeAgent");

function capabilities(id: string): ModelCapabilities {
  return {
    optionDescriptors: [{ id, label: id, type: "boolean" }],
  };
}

function model(input: {
  slug: string;
  capabilities: ModelCapabilities;
  aliases?: ReadonlyArray<string>;
  isCustom?: boolean;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.slug,
    ...(input.aliases ? { aliases: [...input.aliases] } : {}),
    isCustom: input.isCustom ?? false,
    capabilities: input.capabilities,
  };
}

describe("getProviderModelCapabilities", () => {
  it("resolves model-declared aliases", () => {
    const aliasCapabilities = capabilities("aliased-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["Legacy-Synthetic-Model"],
        capabilities: aliasCapabilities,
      }),
    ];

    expect(getProviderModelCapabilities(models, "legacy-synthetic-model", PROVIDER)).toEqual(
      aliasCapabilities,
    );
  });

  it("prefers an exact custom slug over a built-in model alias", () => {
    const customCapabilities = capabilities("custom-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["custom-model"],
        capabilities: capabilities("built-in-option"),
      }),
      model({ slug: "custom-model", capabilities: customCapabilities, isCustom: true }),
    ];

    expect(getProviderModelCapabilities(models, " custom-model ", PROVIDER)).toEqual(
      customCapabilities,
    );
  });

  it("returns empty capabilities for an unknown slug", () => {
    const models = [
      model({
        slug: "default-model",
        capabilities: capabilities("default-option"),
      }),
    ];

    expect(getProviderModelCapabilities(models, "unknown-model", PROVIDER)).toEqual({
      optionDescriptors: [],
    });
  });
});

describe("resolveSelectableProvider", () => {
  const provider = (driver: string, instanceId = driver, overrides: Partial<ServerProvider> = {}): ServerProvider => ({ driver: ProviderDriverKind.make(driver), instanceId: ProviderInstanceId.make(instanceId), enabled: true, installed: true, version: null, status: "ready", auth: { status: "unknown" }, checkedAt: "2026-10-22T00:00:00.000Z", models: [model({ slug: "openai-codex/current", capabilities: {} })], skills: [], slashCommands: [], ...overrides });
  it("resolves unset and obsolete runtime choices to NeoPi", () => {
    const providers = [provider("codex"), provider("neopi")];
    expect(resolveSelectableProvider(providers, null)).toBe("neopi");
    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("codex"))).toBe("neopi");
    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("removed"))).toBe("neopi");
  });
  it("recognizes a native custom instance even when its id names an inference provider", () => {
    const selected = provider("neopi", "anthropic-work", { status: "error" });
    expect(resolveSelectableProvider([selected], selected.instanceId)).toBe("neopi");
  });
  it("does not resurrect another runtime when NeoPi is unavailable", () => {
    expect(resolveSelectableProvider([provider("codex"), provider("neopi", "neopi", { enabled: false })], ProviderInstanceId.make("codex"))).toBe("neopi");
  });
});;
