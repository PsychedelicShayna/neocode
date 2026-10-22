import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyProviderInstanceSettings,
  deriveProviderEntriesByEnvironment,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  resolveDefaultProviderModelSelection,
  resolveSelectableProviderInstance,
  sortProviderInstanceEntries,
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
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
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
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
      },
      providers: {} as never,
    });

    expect(entry?.enabled).toBe(false);
  });

  it("treats a removed custom instance snapshot as disabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_work",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {},
      providers: {} as never,
    });

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
      const [entry] = applyProviderInstanceSettings(entries, {
        providerInstances: {},
        providers: {} as never,
      });

      expect(entry?.enabled).toBe(false);
    },
  );

  it("uses settings for a configured custom instance named constructor", () => {
    const instanceId = ProviderInstanceId.make("constructor");
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId,
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
        },
      },
      providers: {} as never,
    });

    expect(entry?.enabled).toBe(false);
  });

  it("treats a removed default instance for a fork driver as disabled", () => {
    const driver = ProviderDriverKind.make("constructor");
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: driver,
        instanceId: "constructor",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {},
      providers: {} as never,
    });

    expect(entry?.isDefault).toBe(true);
    expect(entry?.enabled).toBe(false);
  });

  it("uses legacy settings for a built-in default instance", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {},
      providers: { codex: { enabled: false } } as never,
    });

    expect(entry?.enabled).toBe(false);
  });
});

describe("deriveProviderInstanceEntries", () => {
  it("uses explicit instance id and driver kind from the snapshot", () => {
    const snapshot = provider({
      provider: ProviderDriverKind.make("codex"),
      instanceId: "codex_personal",
    });
    const [entry] = deriveProviderInstanceEntries([snapshot]);

    expect(entry?.instanceId).toBe("codex_personal");
    expect(entry?.driverKind).toBe("codex");
    expect(entry?.isDefault).toBe(false);
  });
});

describe("deriveProviderEntriesByEnvironment", () => {
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

  it("never falls back to another environment's instances", () => {
    const byEnvironment = deriveProviderEntriesByEnvironment([
      ["local", [provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" })]],
      ["empty", []],
    ]);

    expect(byEnvironment.get("empty")?.get("codex")).toBeUndefined();
    // Every environment gets its own bucket, so an absent lookup is a real
    // "this environment has no such instance", not a missing key.
    expect(byEnvironment.get("empty")?.size).toBe(0);
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
  const native = (instanceId = "neopi", overrides: Pick<Partial<ServerProvider>, "enabled" | "availability" | "status" | "models"> = {}) => provider({ provider: ProviderDriverKind.make("neopi"), instanceId, models: [model("openai-codex/current")], ...overrides });

  it("keeps an explicit native instance and its probe error", () => {
    const requested = ProviderInstanceId.make("personal");
    expect(resolveSelectableProviderInstance([native(), native(requested, { status: "error" })], requested)).toBe(requested);
  });
  it("prefers the native default before custom configurations", () => {
    expect(resolveSelectableProviderInstance([native("work"), native()], undefined)).toBe("neopi");
  });
  it.each(["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"])("never selects the removed %s runtime", (driver) => {
    const legacy = provider({ provider: ProviderDriverKind.make(driver), instanceId: driver, models: [model("saved")] });
    expect(resolveSelectableProviderInstance([legacy], legacy.instanceId)).toBeUndefined();
    expect(resolveSelectableProviderInstance([legacy, native()], legacy.instanceId)).toBe("neopi");
  });
  it.each([{ enabled: false }, { availability: "unavailable" as const }, { status: "error" as const }, { models: [] }])("uses another ready native configuration when the default cannot start: %j", (state) => {
    expect(resolveSelectableProviderInstance([native("neopi", state), native("work")], undefined)).toBe("work");
  });
  it("prefers a ready native instance over a pending probe", () => {
    expect(resolveSelectableProviderInstance([native("neopi", { status: "warning" }), native("work")], undefined)).toBe("work");
  });
  it("can select an unprobed native configuration without inventing an errored one", () => {
    expect(resolveSelectableProviderInstance([native("neopi", { status: "error" }), native("work", { status: "warning" })], undefined)).toBe("work");
    expect(resolveSelectableProviderInstance([native("neopi", { status: "error" })], undefined)).toBeUndefined();
  });
  it("returns no fresh choice when every native configuration is disabled or unavailable", () => {
    expect(resolveSelectableProviderInstance([native("neopi", { enabled: false }), native("work", { availability: "unavailable" })], ProviderInstanceId.make("removed"))).toBeUndefined();
  });
});;

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

  it("falls back to the driver default when the instance reports no models", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];

    const resolved = getDefaultProviderInstanceModel(
      providers,
      ProviderInstanceId.make("claudeAgent"),
    );
    expect(typeof resolved).toBe("string");
    expect(resolved?.length).toBeGreaterThan(0);
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

  it("returns undefined for an unknown instance", () => {
    expect(
      getDefaultProviderInstanceModel([], ProviderInstanceId.make("removed_instance")),
    ).toBeUndefined();
  });
});

describe("resolveDefaultProviderModelSelection", () => {
  const native = (instanceId = "neopi", overrides: Pick<Partial<ServerProvider>, "enabled" | "availability" | "status" | "models"> = {}) => provider({ provider: ProviderDriverKind.make("neopi"), instanceId, models: [model("openai-codex/current", false, true)], ...overrides });
  it("uses another native configuration when the default catalog is empty", () => {
    expect(resolveDefaultProviderModelSelection([native("neopi", { models: [] }), native("work")], null)).toEqual({ instanceId: "work", model: "openai-codex/current" });
  });
  it("keeps an explicit native selection including saved inference options", () => {
    const stored = { instanceId: ProviderInstanceId.make("work"), model: "anthropic/saved", options: [{ id: "thinking", value: "high" }] };
    expect(resolveDefaultProviderModelSelection([native(), native("work")], stored)).toBe(stored);
  });
  it("replaces an obsolete runtime default without rewriting the stored object", () => {
    const stored = { instanceId: ProviderInstanceId.make("codex"), model: "saved", options: [{ id: "reasoningEffort", value: "high" }] };
    const legacy = provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex", models: [model("saved")] });
    expect(resolveDefaultProviderModelSelection([legacy, native()], stored)).toEqual({ instanceId: "neopi", model: "openai-codex/current" });
    expect(stored.instanceId).toBe("codex");
    expect(stored.model).toBe("saved");
  });
  it("resets a missing native instance to the fallback instance's own model", () => {
    expect(resolveDefaultProviderModelSelection([native()], { instanceId: ProviderInstanceId.make("removed"), model: "anthropic/stale" })).toEqual({ instanceId: "neopi", model: "openai-codex/current" });
  });
  it.each([{ enabled: false }, { availability: "unavailable" as const }])("replaces an unavailable native default with a ready native configuration: %j", (state) => {
    expect(resolveDefaultProviderModelSelection([native("neopi", state), native("work")], { instanceId: ProviderInstanceId.make("neopi"), model: "saved" })).toEqual({ instanceId: "work", model: "openai-codex/current" });
  });
  it("returns no selection for empty or unsupported catalogs", () => {
    expect(resolveDefaultProviderModelSelection([], null)).toBeNull();
    for (const state of [{ enabled: false }, { availability: "unavailable" as const }, { status: "error" as const }, { models: [] }]) {
      expect(resolveDefaultProviderModelSelection([native("neopi", state)], null)).toBeNull();
    }
    expect(resolveDefaultProviderModelSelection([provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent", models: [model("saved")] })], null)).toBeNull();
  });
});;
