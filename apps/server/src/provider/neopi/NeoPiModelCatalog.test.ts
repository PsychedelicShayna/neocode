import { expect, it } from "vite-plus/test";
import {
  neoPiRoleFromModelSlug,
  neoPiRolesFromRpc,
  neoPiUsageProviderId,
  toServerProviderModels,
} from "./NeoPiModelCatalog.ts";

it("preserves each model's actual effort ladder and current default", () => {
  const models = toServerProviderModels(
    [
      {
        provider: "openai",
        id: "gpt/extended",
        name: "GPT",
        thinking: { efforts: ["low", "medium", "high"], defaultLevel: "medium" },
      },
      { provider: "local", id: "basic" },
    ],
    { provider: "openai", id: "gpt/extended" },
  );
  expect(models[0]?.isDefault).toBe(true);
  expect(models[0]?.slug).toBe("openai/gpt/extended");
  expect(models[0]?.capabilities?.optionDescriptors).toEqual([
    {
      id: "reasoningEffort",
      type: "select",
      label: "Thinking",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
  ]);
  expect(models[1]?.capabilities?.optionDescriptors).toEqual([]);
});

it("retains a current model absent from a refreshed catalog and reflects active fast mode", () => {
  const models = toServerProviderModels(
    [{ provider: "local", id: "basic" }],
    {
      provider: "openai",
      id: "gpt/extended",
      thinking: { efforts: ["low", "high"] },
      supportsFastMode: true,
    },
    true,
  );
  expect(models[1]?.isCustom).toBe(true);
  expect(models[1]?.isDefault).toBe(true);
  expect(models[1]?.capabilities?.optionDescriptors).toEqual([
    {
      id: "reasoningEffort",
      type: "select",
      label: "Thinking",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
    { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: true },
  ]);
});

it("keeps the native dynamic role inventory and selects the active role", () => {
  const roles = neoPiRolesFromRpc({
    roles: [
      {
        id: "smol",
        alias: "@smol",
        name: "Fast",
        tag: "SMOL",
        section: "chat",
        source: "builtin",
        patterns: ["openai/gpt-5.6-luna:low"],
        resolved: {
          provider: "openai",
          modelId: "gpt-5.6-luna",
          thinkingLevel: "low",
        },
      },
      {
        id: "private",
        alias: "@private",
        name: "Private",
        description: "A newly configured role",
        section: "chat",
        source: "configured",
        patterns: [],
        hidden: true,
      },
    ],
    activeRole: "smol",
  });
  expect(roles).toBeDefined();
  const models = toServerProviderModels(
    [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna", supportsFastMode: true }],
    { provider: "openai", id: "gpt-5.6-luna" },
    true,
    roles,
  );
  expect(models).toEqual([
    {
      slug: "@smol",
      name: "Fast",
      shortName: "SMOL",
      subProvider: "Roles",
      quotaProvider: "openai",
      aliases: ["smol"],
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: true },
        ],
      },
    },
    {
      slug: "@private",
      name: "Private",
      description: "A newly configured role",
      shortName: "private",
      subProvider: "Roles",
      aliases: ["private"],
      isCustom: false,
      capabilities: { optionDescriptors: [] },
    },
    {
      slug: "openai/gpt-5.6-luna",
      name: "Luna",
      shortName: "gpt-5.6-luna",
      subProvider: "openai",
      quotaProvider: "openai",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: true },
        ],
      },
    },
  ]);
  expect(neoPiRoleFromModelSlug("@smol")).toBe("smol");
  expect(neoPiRoleFromModelSlug("openai/gpt-5.6-luna")).toBeUndefined();
  expect(neoPiUsageProviderId(models)).toBe("openai");
  expect(models[0]?.subProvider).toBe("Roles");
});

it("does not treat the role picker group as a usage provider", () => {
  const unresolved = toServerProviderModels(
    [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna" }],
    { provider: "openai", id: "gpt-5.6-luna" },
    false,
    neoPiRolesFromRpc({
      roles: [
        {
          id: "smol",
          alias: "@smol",
          name: "Fast",
          source: "builtin",
          patterns: [],
          hidden: false,
        },
      ],
      activeRole: "smol",
    }),
  );
  expect(unresolved[0]?.subProvider).toBe("Roles");
  expect(unresolved[0]?.quotaProvider).toBeUndefined();
  expect(unresolved[0]?.capabilities?.optionDescriptors).toEqual([]);
  expect(neoPiUsageProviderId(unresolved)).toBe("");
});

it("rejects malformed role catalogs instead of exposing partial picker entries", () => {
  expect(
    neoPiRolesFromRpc({
      roles: [{ id: "smol", alias: "@smol", name: "Fast", source: "builtin" }],
    }),
  ).toBeUndefined();
});

it("does not turn a requested fast setting into support for every model", () => {
  const models = toServerProviderModels(
    [
      { provider: "future-proxy", id: "virtual/priority", supportsFastMode: true },
      {
        provider: "future-proxy",
        id: "virtual/standard",
        supportsFastMode: false,
        serviceTiers: ["priority"],
      },
      { provider: "future-proxy", id: "virtual/ultra", serviceTiers: ["priority", "ultrafast"] },
      { provider: "unknown", id: "model-without-capability-metadata" },
    ],
    { provider: "future-proxy", id: "virtual/standard" },
    true,
  );
  expect(models.map((model) => model.capabilities?.optionDescriptors)).toEqual([
    [{ id: "fastMode", type: "boolean", label: "Fast mode" }],
    [],
    [],
    [],
  ]);
});

it("reports a supported fast toggle while disabled without marking other models enabled", () => {
  const catalog = [
    { provider: "future-proxy", id: "one", supportsFastMode: true },
    { provider: "future-proxy", id: "two", supportsFastMode: true },
  ];
  const disabled = toServerProviderModels(catalog, catalog[0], false);
  const enabled = toServerProviderModels(catalog, catalog[0], true);
  expect(disabled[0]?.capabilities?.optionDescriptors).toEqual([
    { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: false },
  ]);
  expect(enabled[0]?.capabilities?.optionDescriptors).toEqual([
    { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: true },
  ]);
  expect(enabled[1]?.capabilities?.optionDescriptors).toEqual([
    { id: "fastMode", type: "boolean", label: "Fast mode" },
  ]);
});

it("inherits role capabilities from the exact resolved model, not its name or patterns", () => {
  const roles = neoPiRolesFromRpc({
    roles: [
      {
        id: "careful",
        alias: "@research",
        name: "Careful",
        source: "configured",
        patterns: ["wrong-provider/shared:low", "new-proxy/shared:high"],
        resolved: { provider: "new-proxy", modelId: "shared", thinkingLevel: "high" },
        hidden: false,
      },
      {
        id: "unresolved",
        alias: "@unresolved",
        name: "Reasoning fast",
        source: "configured",
        patterns: ["new-proxy/shared:high"],
        hidden: false,
      },
      {
        id: "missing",
        alias: "@missing",
        name: "Missing model",
        source: "configured",
        patterns: ["gone/model:high"],
        resolved: { provider: "gone", modelId: "model", thinkingLevel: "high" },
        hidden: false,
      },
      {
        id: "plain",
        alias: "@plain",
        name: "Plain",
        source: "configured",
        patterns: ["wrong-provider/shared"],
        resolved: { provider: "wrong-provider", modelId: "shared" },
        hidden: false,
      },
    ],
    activeRole: "careful",
  });
  const models = toServerProviderModels(
    [
      { provider: "wrong-provider", id: "shared", reasoning: false, supportsFastMode: false },
      {
        provider: "new-proxy",
        id: "shared",
        reasoning: true,
        thinking: { efforts: ["low", "high"], defaultLevel: "low" },
        supportsFastMode: true,
      },
    ],
    { provider: "new-proxy", id: "shared" },
    false,
    roles,
  );
  expect(models[0]?.aliases).toEqual(["careful", "@research"]);
  expect(models[0]?.capabilities?.optionDescriptors).toEqual([
    {
      id: "reasoningEffort",
      type: "select",
      label: "Thinking",
      options: [
        { id: "low", label: "Low", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "high",
    },
    { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: false },
  ]);
  expect(models[1]?.capabilities?.optionDescriptors).toEqual([]);
  expect(models[2]?.capabilities?.optionDescriptors).toEqual([]);
  expect(models[3]?.capabilities).toEqual({ reasoning: false, optionDescriptors: [] });
});

it("resolves role capabilities from a retained current model absent from the catalog", () => {
  const roles = neoPiRolesFromRpc({
    roles: [
      {
        id: "custom",
        alias: "@custom",
        name: "Custom",
        source: "configured",
        patterns: [],
        resolved: { provider: "proxy", modelId: "virtual/model", thinkingLevel: "high" },
        hidden: false,
      },
    ],
    activeRole: "custom",
  });
  const models = toServerProviderModels(
    [],
    {
      provider: "proxy",
      id: "virtual/model",
      reasoning: true,
      thinking: { efforts: ["low", "high"] },
      supportsFastMode: true,
    },
    true,
    roles,
  );
  expect(models[0]?.isDefault).toBe(true);
  expect(models[1]?.isCustom).toBe(true);
  expect(models[1]?.isDefault).toBeUndefined();
  expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
    id: "reasoningEffort",
    currentValue: "high",
  });
  expect(models[0]?.capabilities?.optionDescriptors?.[1]).toMatchObject({
    id: "fastMode",
    currentValue: true,
  });
});

it("preserves native reasoning support even when effort is not configurable", () => {
  const models = toServerProviderModels(
    [
      { provider: "neoproxy", id: "virtual/reasoner", reasoning: true },
      { provider: "neoproxy", id: "virtual/plain", reasoning: false },
      { provider: "neoproxy", id: "virtual/unknown" },
    ],
    undefined,
    false,
    neoPiRolesFromRpc({
      roles: [
        {
          id: "reasoner",
          alias: "@reasoner",
          name: "Reasoner",
          source: "configured",
          patterns: [],
          resolved: { provider: "neoproxy", modelId: "virtual/reasoner" },
          hidden: false,
        },
      ],
    }),
  );
  expect(models[0]?.capabilities).toEqual({ reasoning: true, optionDescriptors: [] });
  expect(models[1]?.capabilities).toEqual({ reasoning: true, optionDescriptors: [] });
  expect(models[2]?.capabilities).toEqual({ reasoning: false, optionDescriptors: [] });
  expect(models[3]?.capabilities).toEqual({ optionDescriptors: [] });
});

it("does not override explicit native non-reasoning metadata with a stale effort ladder", () => {
  const [model] = toServerProviderModels([
    {
      provider: "proxy",
      id: "plain",
      reasoning: false,
      thinking: { efforts: ["high"], defaultLevel: "high" },
    },
  ]);
  expect(model?.capabilities).toEqual({ reasoning: false, optionDescriptors: [] });
});

it("projects native facts without inventing missing prices, speed or intelligence", () => {
  const models = toServerProviderModels([
    {
      provider: "neoproxy",
      id: "virtual/review",
      int: 43,
      tps: 118,
      contextWindow: 200000,
      cost: { input: 0, output: 15 },
    },
    { provider: "local", id: "unknown", int: NaN, tps: 0, contextWindow: 0, cost: { input: -1 } },
  ]);
  expect(models[0]?.nativeFacts).toEqual({
    intelligence: 43,
    tokensPerSecond: 118,
    contextWindow: 200000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 15,
  });
  expect(models[0]?.nativeFacts?.ttftMs).toBeUndefined();
  expect(models[1]?.nativeFacts).toBeUndefined();
});

it("uses only the exact resolved model's facts for roles", () => {
  const models = toServerProviderModels(
    [{ provider: "custom", id: "virtual/v2", int: 40, contextWindow: 128000 }],
    undefined,
    false,
    neoPiRolesFromRpc({
      roles: [
        {
          id: "review",
          alias: "@review",
          name: "Review",
          source: "configured",
          patterns: ["custom/*"],
          resolved: { provider: "custom", modelId: "virtual/v2" },
          hidden: false,
        },
        {
          id: "unresolved",
          alias: "@unresolved",
          name: "Unresolved",
          source: "configured",
          patterns: ["custom/*"],
          hidden: false,
        },
      ],
    }),
  );
  expect(models[0]?.nativeFacts).toEqual({ intelligence: 40, contextWindow: 128000 });
  expect(models[1]?.nativeFacts).toBeUndefined();
});
