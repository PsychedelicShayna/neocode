import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerConfig,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  buildModelOptions,
  groupByProvider,
  isModelSelectionUnavailable,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
  resolveSelectableModelSelection,
} from "./modelOptions";

const model = (
  slug: string,
  overrides: Partial<ServerProviderModel> = {},
): ServerProviderModel => ({ slug, name: slug, isCustom: false, capabilities: null, ...overrides });
const provider = (
  instanceId = "neopi",
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("neopi"),
  displayName: "NeoPi",
  enabled: true,
  installed: true,
  status: "ready",
  version: "1.0.0",
  auth: { status: "unknown" },
  checkedAt: "2026-10-22T00:00:00.000Z",
  models: [model("openai-codex/current", { isDefault: true }), model("anthropic/current")],
  skills: [],
  slashCommands: [],
  ...overrides,
});
const config = (...providers: ReadonlyArray<ServerProvider>): ServerConfig =>
  ({
    providers,
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: Object.fromEntries(
        providers.map((entry) => [
          entry.instanceId,
          { driver: entry.driver, enabled: entry.enabled, config: {} },
        ]),
      ),
    },
  }) as unknown as ServerConfig;
const select = (instanceId = "neopi", model = "openai-codex/current"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});
const choose = (
  modelOptions: ReturnType<typeof buildModelOptions>,
  draftSelection: ModelSelection | null = null,
  projectDefaultSelection: ModelSelection | null = null,
  stickySelection: ModelSelection | null = null,
) =>
  resolveNewTaskModelSelection({
    modelOptions,
    draftSelection,
    projectDefaultSelection,
    stickySelection,
  });

describe("mobile NeoPi model options", () => {
  it("groups native model backends without changing inference-provider identifiers", () => {
    const native = provider("work", {
      displayName: "NeoPi Work",
      models: [
        model("openai-codex/current", { name: "Current", subProvider: "OpenAI Codex" }),
        model("anthropic/current", { name: "Current", subProvider: "Anthropic" }),
        model("cursor/current", { subProvider: "Cursor" }),
        model("openrouter/current", { subProvider: "OpenRouter" }),
        model("google/current", { subProvider: "Google", isLegacy: true }),
      ],
    });
    const options = buildModelOptions(config(native), null, undefined, null);
    expect(options.map((option) => option.selection.model)).toEqual(
      native.models.map((entry) => entry.slug),
    );
    expect(options.map((option) => option.subtitle)).toEqual([
      "OpenAI Codex",
      "Anthropic",
      "Cursor",
      "OpenRouter",
      "Google",
    ]);
    expect(options.at(-1)?.isLegacy).toBe(true);
    expect(groupByProvider(options)).toEqual([
      { providerKey: "work", providerLabel: "NeoPi Work", models: options },
    ]);
  });

  it("keeps native accounts in the continuation group without admitting retired drivers", () => {
    const environment = config(
      provider("first", { models: [model("test")], continuation: { groupKey: "shared" } }),
      provider("same", { models: [model("test")], continuation: { groupKey: "shared" } }),
      provider("other", { models: [model("test")], continuation: { groupKey: "other" } }),
      provider("legacy", {
        driver: ProviderDriverKind.make("codex"),
        models: [model("test")],
        continuation: { groupKey: "shared" },
      }),
    );
    expect(
      buildModelOptions(environment, null, ProviderInstanceId.make("first"), null).map(
        (option) => option.providerKey,
      ),
    ).toEqual(["first", "same"]);
    expect(
      buildModelOptions(environment, null, undefined, null).map((option) => option.providerKey),
    ).toEqual(["first", "same", "other"]);
  });

  it("carries account badges into catalog and saved fallback models", () => {
    const environment = config(
      provider("personal", { displayName: "Personal" }),
      provider("work", { displayName: "Work", accentColor: "#123456" }),
    );
    const saved = select("work", "saved");
    const options = buildModelOptions(environment, saved, undefined, null);
    expect(options.find((option) => option.providerKey === "personal")?.providerBadge).toEqual({
      displayName: "Personal",
      showBadge: true,
    });
    expect(options.find((option) => option.selection === saved)?.providerBadge).toEqual({
      displayName: "Work",
      accentColor: "#123456",
      showBadge: true,
    });
    expect(
      buildModelOptions(config(provider("personal")), null, undefined, null)[0]?.providerBadge
        ?.showBadge,
    ).toBe(false);
  });

  it("keeps saved option choices without materializing catalog defaults", () => {
    const native = provider("neopi", {
      models: [
        model("openai-codex/current", {
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Thinking",
                type: "select",
                options: [
                  { id: "low", label: "Low", isDefault: true },
                  { id: "high", label: "High" },
                ],
                currentValue: "low",
              },
            ],
          },
        }),
      ],
    });
    const environment = config(native);
    expect(
      buildModelOptions(environment, select(), undefined, null)[0]?.selection.options,
    ).toBeUndefined();
    const selection = { ...select(), options: [{ id: "reasoningEffort", value: "high" }] };
    expect(
      buildModelOptions(environment, selection, undefined, null)[0]?.selection.options,
    ).toEqual(selection.options);
  });

  it.each([
    "codex",
    "claudeAgent",
    "cursor",
    "grok",
    "opencode",
    "antigravity",
    "pi",
    "acpRegistry",
  ])("does not offer %s as a runtime or a new-task default", (driver) => {
    const legacy = provider(driver, {
      driver: ProviderDriverKind.make(driver),
      displayName: driver,
    });
    const saved = select(driver, "saved-model");
    const environment = config(legacy, provider());
    const options = buildModelOptions(environment, saved, undefined, null);
    expect(options.every((option) => option.providerDriver === "neopi")).toBe(true);
    expect(resolveSelectableModelSelection(environment, saved, null)).toBeNull();
    expect(resolveDefaultableModelSelection(environment, saved, null)).toBeNull();
    expect(isModelSelectionUnavailable(environment, saved, null)).toBe(true);
    expect(choose(options, saved)).toEqual(select());
    expect(saved).toEqual(select(driver, "saved-model"));
  });

  it("does not resurrect an obsolete offline default as a phantom model option", () => {
    const saved = select("claudeAgent", "saved-model");
    expect(buildModelOptions(null, saved, undefined, null)).toEqual([]);
    expect(choose([], saved)).toBeNull();
    // The stored value survives until the environment can resolve its real runtime.
    expect(resolveSelectableModelSelection(null, saved, null)).toBe(saved);
  });

  it("uses runtime metadata rather than an instance id that happens to name an old runtime", () => {
    const native = provider("codex_work");
    const environment = config(native);
    const saved = select("codex_work", "anthropic/current");
    expect(resolveSelectableModelSelection(environment, saved, null)).toBe(saved);
    expect(choose(buildModelOptions(environment, saved, undefined, null), saved)).toBe(saved);
    expect(isModelSelectionUnavailable(environment, saved, null)).toBe(false);
  });

  it.each([
    { enabled: false },
    { installed: false },
    { auth: { status: "unauthenticated" as const } },
    { availability: "unavailable" as const },
  ])("rejects unavailable native configurations for new selections: %j", (state) => {
    const environment = config(provider("neopi", state));
    expect(resolveSelectableModelSelection(environment, select(), null)).toBeNull();
    expect(isModelSelectionUnavailable(environment, select(), null)).toBe(true);
  });

  it("retains an explicit native model when its catalog temporarily disappears", () => {
    const saved = {
      ...select("neopi", "anthropic/saved"),
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const environment = config(provider("neopi", { models: [], status: "error" }));
    const options = buildModelOptions(environment, saved, undefined, null);
    expect(options).toHaveLength(1);
    expect(options[0]?.selection).toBe(saved);
    expect(options[0]?.isUnavailable).toBe(true);
    expect(choose(options, saved)).toBe(saved);
  });

  it("does not choose retired native models implicitly but preserves an explicit selection", () => {
    const saved = select("neopi", "anthropic/retired");
    const environment = config(
      provider("neopi", { models: [model(saved.model, { isLegacy: true })] }),
    );
    expect(resolveDefaultableModelSelection(environment, saved, null)).toBeNull();
    expect(resolveSelectableModelSelection(environment, saved, null)).toBe(saved);
  });

  it("preserves draft, project, then sticky native choices before choosing the native default", () => {
    const environment = config(provider(), provider("work"));
    const options = buildModelOptions(environment, null, undefined, null);
    const draft = select("work", "anthropic/current");
    const project = select("neopi", "anthropic/current");
    const sticky = select("work", "openai-codex/current");
    expect(choose(options, draft, project, sticky)).toBe(draft);
    expect(choose(options, null, project, sticky)).toBe(project);
    expect(choose(options, null, null, sticky)).toBe(sticky);
    expect(choose(options)).toEqual(select());
  });

  it("skips an obsolete higher-priority preference without losing a valid native project choice", () => {
    const options = buildModelOptions(config(provider()), null, undefined, null);
    const project = select("neopi", "anthropic/current");
    expect(choose(options, select("codex", "saved"), project)).toBe(project);
  });

  it("prefers a ready native instance over an unavailable default and returns null without usable options", () => {
    const environment = config(provider("neopi", { status: "error" }), provider("work"));
    expect(choose(buildModelOptions(environment, null, undefined, null))).toEqual(select("work"));
    expect(
      choose(buildModelOptions(config(provider("neopi", { models: [] })), null, undefined, null)),
    ).toBeNull();
  });

  describe("project-aware enablement", () => {
    const projectId = ProjectId.make("project-a");
    const instanceId = ProviderInstanceId.make("codex_work");

    function configWith(settings: ServerSettings): ServerConfig {
      return {
        ...config(provider(String(instanceId), { models: [model("model-a")] })),
        settings,
      };
    }

    it("refuses to send a native model the project turned off", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("neopi"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const selection = { instanceId, model: "model-a" };

      expect(isModelSelectionUnavailable(configWith(settings), selection, projectId)).toBe(true);
      expect(isModelSelectionUnavailable(configWith(settings), selection, null)).toBe(false);
    });

    it("hides an instance the project disables even though the machine enables it", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("neopi"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };

      expect(buildModelOptions(configWith(settings), null, undefined, projectId)).toEqual([]);
    });

    it("hides a machine-disabled instance for a project with no override, even though another project's keep-alive left it running", () => {
      const otherProjectId = ProjectId.make("project-b");
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("neopi"), enabled: false },
        },
        projectSettingsOverrides: {
          [otherProjectId]: { providerInstances: { [instanceId]: { enabled: true } } },
        },
      };

      expect(buildModelOptions(configWith(settings), null, undefined, projectId)).toEqual([]);
    });

    it("refuses to send an instance the project merely inherits as disabled, not just an explicit override", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("neopi"), enabled: false },
        },
      };
      const selection = { instanceId, model: "model-a" };

      expect(isModelSelectionUnavailable(configWith(settings), selection, projectId)).toBe(true);
      expect(isModelSelectionUnavailable(configWith(settings), selection, null)).toBe(true);
    });

    it("marks a project-disabled instance's fallback selection unavailable instead of reviving it", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("neopi"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const fallback = { instanceId, model: "model-a" };

      const options = buildModelOptions(configWith(settings), fallback, undefined, projectId);

      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({ selection: fallback, isUnavailable: true });
      expect(resolveSelectableModelSelection(configWith(settings), fallback, projectId)).toBeNull();
      expect(resolveSelectableModelSelection(configWith(settings), fallback, null)).toBe(fallback);
      expect(
        resolveSelectableModelSelection(
          { ...configWith(settings), providers: [] },
          fallback,
          projectId,
        ),
      ).toBeNull();
    });
  });
});

describe("synchronized mobile model visibility", () => {
  const provider = ProviderInstanceId.make("codex_work");
  const other = ProviderInstanceId.make("codex_personal");
  const models = [
    { slug: "hidden", name: "Hidden", isCustom: false, capabilities: null },
    { slug: "first", name: "First", isCustom: false, capabilities: null },
    { slug: "second", name: "Second", isCustom: false, capabilities: null },
    { slug: "custom", name: "Custom", isCustom: true, capabilities: null },
  ];
  const config = {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [provider]: { driver: ProviderDriverKind.make("neopi"), enabled: true },
        [other]: { driver: ProviderDriverKind.make("neopi"), enabled: true },
      },
      providerModelPreferences: {
        [provider]: {
          hiddenModels: ["hidden", "custom", "missing"],
          modelOrder: ["second", "first"],
        },
      },
    },
    providers: [provider, other].map((instanceId) => ({
      instanceId,
      continuation: { groupKey: instanceId },
      driver: "neopi",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models,
    })),
  } as unknown as ServerConfig;

  it("applies server visibility and ordering independently to each provider instance", () => {
    const options = buildModelOptions(config, null, undefined, null);
    expect(
      options
        .filter((option) => option.providerKey === provider)
        .map((option) => option.selection.model),
    ).toEqual(["second", "first", "custom"]);
    expect(
      options
        .filter((option) => option.providerKey === other)
        .map((option) => option.selection.model),
    ).toEqual(["hidden", "first", "second", "custom"]);
  });

  it("exposes hidden built-ins for management without offering custom visibility controls", () => {
    const options = buildModelOptions(
      config,
      { instanceId: provider, model: "hidden" },
      provider,
      null,
      true,
    );
    expect(options.map((option) => option.selection.model)).toEqual([
      "second",
      "first",
      "hidden",
      "custom",
    ]);
    expect(options.find((option) => option.selection.model === "hidden")).toMatchObject({
      isHidden: true,
      canHide: true,
    });
    expect(options.find((option) => option.selection.model === "custom")).toMatchObject({
      isHidden: false,
      canHide: false,
    });
  });

  it.each(["hidden", "missing"])("does not resurrect the hidden fallback %s", (model) => {
    expect(
      buildModelOptions(config, { instanceId: provider, model }, provider, null).map(
        (option) => option.selection.model,
      ),
    ).toEqual(["second", "first", "custom"]);
  });

  // regression: #16816 sync model favorites and visibility across clients
  it("keeps custom models visible and restores built-in models when the server clears hidden models", () => {
    expect(
      buildModelOptions(config, { instanceId: provider, model: "custom" }, provider, null).map(
        (option) => option.selection.model,
      ),
    ).toContain("custom");
    const cleared = { ...config, settings: { ...config.settings, providerModelPreferences: {} } };
    expect(
      buildModelOptions(cleared, null, provider, null).map((option) => option.selection.model),
    ).toEqual(["hidden", "first", "second", "custom"]);
  });

  describe("managed provider policy", () => {
    const config = {
      providers: [
        {
          instanceId: "neopi",
          driver: "neopi",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "gpt-5.6-sol", name: "GPT", isCustom: false, capabilities: null }],
        },
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "claude-sonnet-5", name: "Sonnet", isCustom: false, capabilities: null },
          ],
        },
      ],
      managedPolicy: {
        organization: "Example Corp",
        lockedSettings: [],
        limits: { providers: { allowedDrivers: [ProviderDriverKind.make("codex")] } },
      },
    } as unknown as ServerConfig;
    const disallowed = {
      instanceId: ProviderInstanceId.make("neopi"),
      model: "gpt-5.6-sol",
    };

    it("applies the managed policy without offering allowed retired drivers", () => {
      expect(
        buildModelOptions(config, null, undefined, null).map((option) => option.providerKey),
      ).toEqual([]);
      const allowed: ServerConfig = {
        ...config,
        managedPolicy: {
          ...config.managedPolicy!,
          limits: { providers: { allowedDrivers: [ProviderDriverKind.make("neopi")] } },
        },
      };
      expect(
        buildModelOptions(allowed, null, undefined, null).map((option) => option.providerKey),
      ).toEqual(["neopi"]);
    });

    it("marks a thread's selection unavailable when its native driver is disallowed", () => {
      expect(
        buildModelOptions(config, disallowed, undefined, null).find(
          (option) => option.providerKey === "neopi",
        )?.isUnavailable,
      ).toBe(true);
      expect(isModelSelectionUnavailable(config, disallowed, null)).toBe(true);
    });
  });
});
