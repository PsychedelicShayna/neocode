import { describe, expect, it } from "vite-plus/test";
import type { NeoPiModelsConfiguration, NeoPiNativeModel } from "@t3tools/contracts";
import {
  isModelRuleSelectorValid,
  modelContextLabel,
  modelDisplayName,
  modelEffortLabel,
  modelPriceLabel,
  modelProviderGroups,
  modelRoleForScope,
  modelsForView,
  modelsIndex,
  moveModelItem,
} from "./modelsPresentation";

describe("Models catalog presentation", () => {
  it("uses a model's id instead of empty or descriptive names", () => {
    expect(modelDisplayName({ id: "model-id", name: " " })).toBe("model-id");
    expect(modelDisplayName({ id: "model-id", name: "x".repeat(48) })).toBe("x".repeat(48));
    expect(modelDisplayName({ id: "model-id", name: "x".repeat(49) })).toBe("model-id");
    expect(modelDisplayName({ id: "model-id", name: "  Model name  " })).toBe("Model name");
  });

  it("formats native binary-million context and keeps unknown separate from zero", () => {
    expect(modelContextLabel(1_048_576)).toBe("1M");
    expect(modelContextLabel(272_000)).toBe("272K");
    expect(modelContextLabel(null)).toBe("—");
    expect(modelContextLabel(0)).toBe("0");
  });

  it("removes floating tails while preserving small nonzero prices and rounding boundaries", () => {
    expect(modelPriceLabel({ input: 0.020999999999999998, output: 0.061599999999999995 })).toBe(
      "$0.021 / $0.0616",
    );
    expect(modelPriceLabel({ input: 0.049999999999999996, output: 0.000001 })).toBe(
      "$0.05 / $0.000001",
    );
    expect(modelPriceLabel({ input: 0.9999, output: 9.999 })).toBe("$1 / $10");
  });

  it("distinguishes both-zero prices from a single zero component", () => {
    expect(modelPriceLabel({ input: 0, output: 0 })).toBe("—");
    expect(modelPriceLabel({ input: 0, output: 2 })).toBe("$0 / $2");
    expect(modelPriceLabel({ input: 2, output: 0 })).toBe("$2 / $0");
  });

  it("replaces every negative component without hiding the known counterpart", () => {
    expect(modelPriceLabel({ input: -1_000_000, output: -0.001 })).toBe("- / -");
    expect(modelPriceLabel({ input: -0.001, output: 0.049999999999999996 })).toBe("- / $0.05");
    expect(modelPriceLabel({ input: 12, output: -1_000_000 })).toBe("$12 / -");
    expect(modelPriceLabel({ input: -1, output: 0 })).toBe("- / $0");
    expect(modelPriceLabel({ input: 0, output: -1 })).toBe("$0 / -");
  });

  it("collapses only contiguous canonical effort runs, regardless of input order", () => {
    expect(modelEffortLabel(["xhigh", "low", "high", "medium"])).toBe("low–xhigh");
    expect(modelEffortLabel(["max", "off", "high", "xhigh"])).toBe("off, high–max");
    expect(modelEffortLabel(["low", "high"])).toBe("low, high");
    expect(modelEffortLabel(["max", "max"])).toBe("max");
    expect(modelEffortLabel([])).toBe("—");
  });
});

describe("Models ordered rule edits", () => {
  it("moves exactly one item without changing the source or out-of-range order", () => {
    const items = ["exact/model", "re:^provider/", "provider/*"];
    expect(moveModelItem(items, 1, -1)).toEqual(["re:^provider/", "exact/model", "provider/*"]);
    expect(moveModelItem(items, 1, 1)).toEqual(["exact/model", "provider/*", "re:^provider/"]);
    expect(moveModelItem(items, 0, -1)).toEqual(items);
    expect(items).toEqual(["exact/model", "re:^provider/", "provider/*"]);
  });

  it("prevents malformed explicit regexes and missing provider/model parts before save", () => {
    expect(isModelRuleSelectorValid("re:[")).toBe(false);
    expect(isModelRuleSelectorValid("re:^gpt-6")).toBe(true);
    expect(isModelRuleSelectorValid("anthropic/*")).toBe(true);
    expect(isModelRuleSelectorValid("*gpt*")).toBe(false);
    expect(isModelRuleSelectorValid("/gpt*")).toBe(false);
    expect(isModelRuleSelectorValid("openai*/")).toBe(false);
    expect(isModelRuleSelectorValid("provider/model")).toBe(true);
    expect(isModelRuleSelectorValid("provider/")).toBe(false);
    expect(isModelRuleSelectorValid("/model")).toBe(false);
    expect(isModelRuleSelectorValid("")).toBe(false);
  });
});

describe("native Ready provider catalog", () => {
  const provider = (
    id: string,
    available: boolean,
    authenticated: boolean,
  ): NeoPiModelsConfiguration["providers"][number] => ({
    id,
    name: `A misleading login name for ${id}`,
    mark: { text: "unused", seed: id, icon: "" },
    available,
    authenticated,
    authSource: null,
    disabled: false,
    acceptsKeys: true,
    loginProviders: [],
    envVars: [],
    discovery: null,
  });
  const model = (provider: string, id: string, available = true): NeoPiNativeModel => ({
    provider,
    id,
    name: `Display ${id}`,
    available,
    kind: "chat",
    contextWindow: null,
    effectiveContextWindow: 0,
    maxTokens: null,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    supportsFastMode: false,
    supportedThinkingLevels: [],
    permittedEfforts: [],
  });
  const configuration = {
    providers: [
      provider("z-public", true, false),
      provider("a-signed-in", false, true),
      provider("m-ready", true, true),
    ],
    models: [
      model("a-signed-in", "catalog-only", false),
      model("z-public", "anonymous"),
      model("m-ready", "private"),
    ],
  };

  it("groups and sorts exact provider ids by availability, not authentication or login names", () => {
    const groups = modelProviderGroups(configuration.providers, "");
    expect(groups.ready.map((provider) => provider.id)).toEqual(["m-ready", "z-public"]);
    expect(groups.notSetUp.map((provider) => provider.id)).toEqual(["a-signed-in"]);
    expect(
      modelProviderGroups(configuration.providers, " PUBLIC ").ready.map((provider) => provider.id),
    ).toEqual(["z-public"]);
  });

  it("keeps unconfigured provider catalogs visible but excludes them from All models", () => {
    expect(modelsForView(configuration, null, "").map((model) => model.id)).toEqual([
      "anonymous",
      "private",
    ]);
    expect(modelsForView(configuration, "a-signed-in", "").map((model) => model.id)).toEqual([
      "catalog-only",
    ]);
    expect(
      modelsForView(configuration, null, " DISPLAY PRIVATE ").map((model) => model.id),
    ).toEqual(["private"]);
    expect(modelsForView(configuration, null, "a-signed-in")).toEqual([]);
    expect(configuration.models.map((model) => model.id)).toEqual([
      "catalog-only",
      "anonymous",
      "private",
    ]);
  });
});

describe("Models catalog index", () => {
  const entry = (provider: string, id: string, name: string) =>
    ({ provider, id, name, available: true }) as NeoPiNativeModel;
  const models = [
    entry("a", "one", "First"),
    entry("a", "one", "Duplicate"),
    entry("b", "x/y", "Two"),
  ];

  it("resolves provider/id selectors to the first matching row, including slashes in ids", () => {
    const index = modelsIndex(models);
    expect(index.bySelector.get("a/one")?.name).toBe("First");
    expect(index.bySelector.get("b/x/y")?.name).toBe("Two");
    expect(index.bySelector.get("a/missing")).toBeUndefined();
  });

  it("builds once per catalog snapshot and rebuilds for a new one", () => {
    expect(modelsIndex(models)).toBe(modelsIndex(models));
    expect(modelsIndex([...models])).not.toBe(modelsIndex(models));
    const index = modelsIndex(models);
    expect(index.searchKeys()).toBe(index.searchKeys());
    expect(index.searchKeys()).toEqual(["a/one first", "a/one duplicate", "b/x/y two"]);
  });
});

describe("native role editing scopes", () => {
  const globalEffort = { mode: "fixed", level: "high" } as const;
  const role = {
    global: { selector: "@advisor:high", effort: globalEffort },
    project: { selector: "re:^project/", effort: null },
    resolved: { provider: "runtime", modelId: "overlay" },
    scopedResolutions: {
      global: { provider: "global-provider", modelId: "global" },
      project: { provider: "project-provider", modelId: "project" },
    },
  };
  it("uses the edited native scope rather than runtime resolution or selector parsing", () => {
    expect(modelRoleForScope(role, "global")).toEqual({
      selector: "@advisor:high",
      effort: globalEffort,
      resolution: role.scopedResolutions.global,
    });
    expect(modelRoleForScope(role, "project")).toEqual({
      selector: "re:^project/",
      effort: globalEffort,
      resolution: role.scopedResolutions.project,
    });
  });
  it("inherits selector and effort independently and keeps unresolved aliases unresolved", () => {
    const projectEffort = { mode: "fixed", level: "low" } as const;
    expect(
      modelRoleForScope(
        {
          ...role,
          project: { selector: null, effort: projectEffort },
          scopedResolutions: { ...role.scopedResolutions, project: null },
        },
        "project",
      ),
    ).toEqual({
      selector: "@advisor:high",
      effort: projectEffort,
      resolution: null,
    });
  });
});
