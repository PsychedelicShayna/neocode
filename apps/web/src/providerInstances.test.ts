import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyProviderInstanceSettings,
  brandProviderInstanceEntries,
  deriveProviderEntriesByEnvironment,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  resolveDefaultProviderModelSelection,
  resolveSelectableProviderInstance,
  sortProviderInstanceEntries,
  shouldShowInstanceBadge,
} from "./providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  accentColor?: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
  supportsTextGeneration?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

const model = (slug: string, isCustom = false, isDefault = false) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {},
});

describe("isProviderInstancePickerReady", () => {
  it("rejects a disabled instance even while its last probe status is ready", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("neopi"),
        instanceId: "neopi",
        enabled: false,
      }),
    ]);

    expect(entry?.status).toBe("ready");
    expect(entry && isProviderInstancePickerReady(entry)).toBe(false);
  });

  it("accepts an enabled, available, ready instance", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("neopi"), instanceId: "neopi" }),
    ]);

    expect(entry && isProviderInstancePickerReady(entry)).toBe(true);
  });
  it("rejects a legacy runtime even when an older server reports it ready", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);
    expect(entry && isProviderInstancePickerReady(entry)).toBe(false);
  });
});

describe("isProviderInstancePickerVisible", () => {
  it("keeps enabled instances in the rail and removes disabled instances", () => {
    const [enabledEntry, disabledEntry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("neopi"), instanceId: "neopi" }),
      provider({
        provider: ProviderDriverKind.make("neopi"),
        instanceId: "native-work",
        enabled: false,
      }),
    ]);

    expect(enabledEntry && isProviderInstancePickerVisible(enabledEntry)).toBe(true);
    expect(disabledEntry && isProviderInstancePickerVisible(disabledEntry)).toBe(false);
  });
  it("does not expose legacy runtimes on the picker rail", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "legacy" }),
    ]);
    expect(entry && isProviderInstancePickerVisible(entry)).toBe(false);
  });
});

describe("applyProviderInstanceSettings", () => {
  it("uses settings when a streamed snapshot still reports a disabled default as enabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);
    const [entry] = applyProviderInstanceSettings(
      entries,
      {
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
          },
        },
        projectSettingsOverrides: {},
      },
      null,
    );

    expect(entry?.enabled).toBe(false);
  });

  it.each(["constructor", "toString"])(
    "treats a removed custom instance named %s as disabled",
    (instanceId) => {
      const entries = deriveProviderInstanceEntries([
        provider({
          provider: ProviderDriverKind.make("claudeAgent"),
          instanceId,
        }),
      ]);
      const [entry] = applyProviderInstanceSettings(
        entries,
        {
          providerInstances: {},
          projectSettingsOverrides: {},
        },
        null,
      );

      expect(entry?.enabled).toBe(false);
    },
  );

  // regression: #8337 provider ids matching Object.prototype keys resolved to prototype members
  it("uses settings for a configured custom instance named constructor", () => {
    const instanceId = ProviderInstanceId.make("constructor");
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId,
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(
      entries,
      {
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: false,
          },
        },
        projectSettingsOverrides: {},
      },
      null,
    );

    expect(entry?.enabled).toBe(false);
  });

  it("uses the driver default for an unconfigured built-in default instance", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("neopi"), instanceId: "neopi", enabled: false }),
      provider({ provider: ProviderDriverKind.make("grok"), instanceId: "grok", enabled: true }),
    ]);
    const [native, grok] = applyProviderInstanceSettings(
      entries,
      {
        providerInstances: {},
        projectSettingsOverrides: {},
      },
      null,
    );

    expect(native?.enabled).toBe(true);
    expect(grok?.enabled).toBe(false);
  });
});

describe("deriveProviderEntriesByEnvironment", () => {
  it("resolves registry branding from each environment's settings", () => {
    const instanceId = "custom-acp";
    const snapshot = provider({ provider: ProviderDriverKind.make("acpRegistry"), instanceId });
    const byEnvironment = deriveProviderEntriesByEnvironment(
      ["devin", "other-agent"].map(
        (agentId) =>
          [
            agentId,
            [snapshot],
            {
              providerInstances: {
                [instanceId]: {
                  driver: ProviderDriverKind.make("acpRegistry"),
                  enabled: true,
                  config: { agentId, registryIconUrl: `https://example.com/${agentId}.svg` },
                },
              },
              projectSettingsOverrides: {},
            },
          ] as const,
      ),
    );
    expect(byEnvironment.get("devin")?.get(instanceId)?.acpRegistryAgentId).toBe("devin");
    expect(byEnvironment.get("devin")?.get(instanceId)?.acpRegistryIconUrl).toBe(
      "https://example.com/devin.svg",
    );
    expect(byEnvironment.get("other-agent")?.get(instanceId)?.acpRegistryAgentId).toBe(
      "other-agent",
    );
  });

  // regression: #7292 sidebar provider icons resolved from the wrong environment
  it("keeps same-id default instances distinct per environment", () => {
    const byEnvironment = deriveProviderEntriesByEnvironment([
      [
        "local",
        [
          provider({
            provider: ProviderDriverKind.make("claude"),
            instanceId: "claude",
            displayName: "Claude Local",
            accentColor: "#112233",
          }),
        ],
      ],
      [
        "remote",
        [
          provider({
            provider: ProviderDriverKind.make("claude"),
            instanceId: "claude",
            displayName: "Claude Remote",
            accentColor: "#445566",
          }),
        ],
      ],
    ]);

    expect(byEnvironment.get("local")?.get("claude")?.displayName).toBe("Claude Local");
    expect(byEnvironment.get("local")?.get("claude")?.accentColor).toBe("#112233");
    expect(byEnvironment.get("remote")?.get("claude")?.displayName).toBe("Claude Remote");
    expect(byEnvironment.get("remote")?.get("claude")?.accentColor).toBe("#445566");
  });

  it("keeps an instance a project turns on as a sibling for the instance badge", () => {
    const codex = ProviderDriverKind.make("codex");
    const byEnvironment = deriveProviderEntriesByEnvironment([
      [
        "local",
        [
          provider({ provider: codex, instanceId: "codex" }),
          provider({ provider: codex, instanceId: "codex_work" }),
        ],
        {
          providerInstances: {
            [ProviderInstanceId.make("codex_work")]: { driver: codex, enabled: false },
          },
          projectSettingsOverrides: {
            [ProjectId.make("project-work")]: {
              providerInstances: { [ProviderInstanceId.make("codex_work")]: { enabled: true } },
            },
          },
        },
      ],
    ]);
    const entries = byEnvironment.get("local");
    const personal = entries?.get("codex");

    expect(personal && shouldShowInstanceBadge(personal, entries?.values() ?? [])).toBe(true);
  });
});

describe("brandProviderInstanceEntries", () => {
  it("keeps an instance a project turns on as a sibling for the instance badge", () => {
    const codex = ProviderDriverKind.make("codex");
    const settings = {
      providerInstances: {
        [ProviderInstanceId.make("codex_work")]: { driver: codex, enabled: false },
      },
      projectSettingsOverrides: {
        [ProjectId.make("project-work")]: {
          providerInstances: { [ProviderInstanceId.make("codex_work")]: { enabled: true } },
        },
      },
    };
    const entries = brandProviderInstanceEntries(
      deriveProviderInstanceEntries([
        provider({ provider: codex, instanceId: "codex" }),
        provider({ provider: codex, instanceId: "codex_work" }),
      ]),
      settings,
    );
    const personal = entries.find((entry) => entry.instanceId === "codex");

    expect(personal && shouldShowInstanceBadge(personal, entries)).toBe(true);
  });
});

describe("sortProviderInstanceEntries", () => {
  it("puts all NeoPi instances first, defaults before customs, and keeps other driver order", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claude_work" }),
      provider({ provider: ProviderDriverKind.make("neopi"), instanceId: "neopi_work" }),
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex_work" }),
      provider({ provider: ProviderDriverKind.make("neopi"), instanceId: "neopi" }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
      provider({ provider: ProviderDriverKind.make("neopi"), instanceId: "neopi_personal" }),
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);
    const originalOrder = entries.map((entry) => entry.instanceId);

    expect(sortProviderInstanceEntries(entries).map((entry) => entry.instanceId)).toEqual([
      "neopi",
      "neopi_work",
      "neopi_personal",
      "claudeAgent",
      "claude_work",
      "codex",
      "codex_work",
    ]);
    expect(entries.map((entry) => entry.instanceId)).toEqual(originalOrder);
  });
});

describe("resolveSelectableProviderInstance", () => {
  const native = (
    instanceId = "neopi",
    overrides: Pick<Partial<ServerProvider>, "enabled" | "availability" | "status" | "models"> = {},
  ) =>
    provider({
      provider: ProviderDriverKind.make("neopi"),
      instanceId,
      models: [model("openai-codex/current")],
      ...overrides,
    });

  it("keeps an explicit native instance and its probe error", () => {
    const requested = ProviderInstanceId.make("personal");
    expect(
      resolveSelectableProviderInstance(
        [native(), native(requested, { status: "error" })],
        requested,
      ),
    ).toBe(requested);
  });
  it("prefers the native default before custom configurations", () => {
    expect(resolveSelectableProviderInstance([native("work"), native()], undefined)).toBe("neopi");
  });
  it.each(["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"])(
    "never selects the removed %s runtime",
    (driver) => {
      const legacy = provider({
        provider: ProviderDriverKind.make(driver),
        instanceId: driver,
        models: [model("saved")],
      });
      expect(resolveSelectableProviderInstance([legacy], legacy.instanceId)).toBeUndefined();
      expect(resolveSelectableProviderInstance([legacy, native()], legacy.instanceId)).toBe(
        "neopi",
      );
    },
  );
  it.each([
    { enabled: false },
    { availability: "unavailable" as const },
    { status: "error" as const },
    { models: [] },
  ])("uses another ready native configuration when the default cannot start: %j", (state) => {
    expect(
      resolveSelectableProviderInstance([native("neopi", state), native("work")], undefined),
    ).toBe("work");
  });
  it("prefers a ready native instance over a pending probe", () => {
    expect(
      resolveSelectableProviderInstance(
        [native("neopi", { status: "warning" }), native("work")],
        undefined,
      ),
    ).toBe("work");
  });
  it("can select an unprobed native configuration without inventing an errored one", () => {
    expect(
      resolveSelectableProviderInstance(
        [native("neopi", { status: "error" }), native("work", { status: "warning" })],
        undefined,
      ),
    ).toBe("work");
    expect(
      resolveSelectableProviderInstance([native("neopi", { status: "error" })], undefined),
    ).toBeUndefined();
  });
  it("returns no fresh choice when every native configuration is disabled or unavailable", () => {
    expect(
      resolveSelectableProviderInstance(
        [native("neopi", { enabled: false }), native("work", { availability: "unavailable" })],
        ProviderInstanceId.make("removed"),
      ),
    ).toBeUndefined();
  });
});

describe("getDefaultProviderInstanceModel", () => {
  it("uses the instance's own models, not the default instance of the kind", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        models: [model("openai/gpt-5.5", true), model("claude-opus-4-8")],
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-sonnet-5")],
      }),
    ];

    expect(
      getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claude_openrouter")),
    ).toBe("claude-opus-4-8");
  });

  it("does not invent a native model when the instance reports no catalog", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("neopi"), instanceId: "neopi" }),
    ];
    expect(
      getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("neopi")),
    ).toBeUndefined();
  });

  it("honors the instance's declared default before model-list order", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-sonnet-5"), model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claudeAgent"))).toBe(
      "claude-opus-4-8",
    );
  });
});

describe("resolveDefaultProviderModelSelection", () => {
  const native = (
    instanceId = "neopi",
    overrides: Pick<Partial<ServerProvider>, "enabled" | "availability" | "status" | "models"> = {},
  ) =>
    provider({
      provider: ProviderDriverKind.make("neopi"),
      instanceId,
      models: [model("openai-codex/current", false, true)],
      ...overrides,
    });
  it("uses another native configuration when the default catalog is empty", () => {
    expect(
      resolveDefaultProviderModelSelection([native("neopi", { models: [] }), native("work")], null),
    ).toEqual({ instanceId: "work", model: "openai-codex/current" });
  });
  it("keeps an explicit native selection including saved inference options", () => {
    const stored = {
      instanceId: ProviderInstanceId.make("work"),
      model: "anthropic/saved",
      options: [{ id: "thinking", value: "high" }],
    };
    expect(resolveDefaultProviderModelSelection([native(), native("work")], stored)).toBe(stored);
  });
  it("replaces an obsolete runtime default without rewriting the stored object", () => {
    const stored = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "saved",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const legacy = provider({
      provider: ProviderDriverKind.make("codex"),
      instanceId: "codex",
      models: [model("saved")],
    });
    expect(resolveDefaultProviderModelSelection([legacy, native()], stored)).toEqual({
      instanceId: "neopi",
      model: "openai-codex/current",
    });
    expect(stored.instanceId).toBe("codex");
    expect(stored.model).toBe("saved");
  });
  it("resets a missing native instance to the fallback instance's own model", () => {
    expect(
      resolveDefaultProviderModelSelection([native()], {
        instanceId: ProviderInstanceId.make("removed"),
        model: "anthropic/stale",
      }),
    ).toEqual({ instanceId: "neopi", model: "openai-codex/current" });
  });
  it.each([{ enabled: false }, { availability: "unavailable" as const }])(
    "replaces an unavailable native default with a ready native configuration: %j",
    (state) => {
      expect(
        resolveDefaultProviderModelSelection([native("neopi", state), native("work")], {
          instanceId: ProviderInstanceId.make("neopi"),
          model: "saved",
        }),
      ).toEqual({ instanceId: "work", model: "openai-codex/current" });
    },
  );
  it("returns no selection for empty or unsupported catalogs", () => {
    expect(resolveDefaultProviderModelSelection([], null)).toBeNull();
    for (const state of [
      { enabled: false },
      { availability: "unavailable" as const },
      { status: "error" as const },
      { models: [] },
    ]) {
      expect(resolveDefaultProviderModelSelection([native("neopi", state)], null)).toBeNull();
    }
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("claudeAgent"),
            instanceId: "claudeAgent",
            models: [model("saved")],
          }),
        ],
        null,
      ),
    ).toBeNull();
  });
});

describe("provider icon metadata", () => {
  it("clears stale registry branding when an instance switches to a local command", () => {
    const instanceId = ProviderInstanceId.make("custom-acp");
    const driver = ProviderDriverKind.make("acpRegistry");
    const iconUrl = "https://cdn.agentclientprotocol.com/registry/icons/swe-agent.svg";
    const snapshots = deriveProviderInstanceEntries([
      { ...provider({ provider: driver, instanceId }), iconUrl },
    ]);
    const registryConfig = { agentId: "swe-agent", registryIconUrl: iconUrl };
    const brandedEntries = applyProviderInstanceSettings(
      snapshots,
      {
        providerInstances: { [instanceId]: { driver, enabled: true, config: registryConfig } },
        projectSettingsOverrides: {},
      },
      null,
    );
    expect(brandedEntries[0]?.acpRegistryAgentId).toBe("swe-agent");
    expect(brandedEntries[0]?.acpRegistryIconUrl).toBe(iconUrl);

    const [localEntry] = applyProviderInstanceSettings(
      brandedEntries,
      {
        providerInstances: {
          [instanceId]: {
            driver,
            enabled: false,
            config: { ...registryConfig, source: "local", commandPath: "dsh" },
          },
        },
        projectSettingsOverrides: {},
      },
      null,
    );
    expect(localEntry?.acpRegistryAgentId).toBeUndefined();
    expect(localEntry?.acpRegistryIconUrl).toBeUndefined();
    expect(localEntry?.enabled).toBe(false);
    expect(localEntry?.snapshot).toBe(snapshots[0]?.snapshot);

    const [restoredEntry] = applyProviderInstanceSettings(
      localEntry ? [localEntry] : [],
      {
        providerInstances: { [instanceId]: { driver, enabled: true, config: registryConfig } },
        projectSettingsOverrides: {},
      },
      null,
    );
    expect(restoredEntry?.acpRegistryAgentId).toBe("swe-agent");
    expect(restoredEntry?.acpRegistryIconUrl).toBe(iconUrl);
    expect(restoredEntry?.enabled).toBe(true);
  });
});
