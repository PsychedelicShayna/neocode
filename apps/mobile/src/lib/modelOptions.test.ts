import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind, ProviderInstanceId, type ModelSelection, type ServerConfig, type ServerProvider, type ServerProviderModel } from "@t3tools/contracts";
import { buildModelOptions, groupByProvider, isModelSelectionUnavailable, resolveDefaultableModelSelection, resolveNewTaskModelSelection, resolveSelectableModelSelection } from "./modelOptions";

const model = (slug: string, overrides: Partial<ServerProviderModel> = {}): ServerProviderModel => ({ slug, name: slug, isCustom: false, capabilities: null, ...overrides });
const provider = (instanceId = "neopi", overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId), driver: ProviderDriverKind.make("neopi"), displayName: "NeoPi",
  enabled: true, installed: true, status: "ready", version: "1.0.0", auth: { status: "unknown" },
  checkedAt: "2026-10-22T00:00:00.000Z", models: [model("openai-codex/current", { isDefault: true }), model("anthropic/current")], skills: [], slashCommands: [], ...overrides,
});
const config = (...providers: ReadonlyArray<ServerProvider>): ServerConfig => ({
  providers,
  settings: { ...DEFAULT_SERVER_SETTINGS, providerInstances: Object.fromEntries(providers.map((entry) => [entry.instanceId, { driver: entry.driver, enabled: entry.enabled, config: {} }])) },
} as unknown as ServerConfig);
const select = (instanceId = "neopi", model = "openai-codex/current"): ModelSelection => ({ instanceId: ProviderInstanceId.make(instanceId), model });
const choose = (modelOptions: ReturnType<typeof buildModelOptions>, draftSelection: ModelSelection | null = null, projectDefaultSelection: ModelSelection | null = null, stickySelection: ModelSelection | null = null) => resolveNewTaskModelSelection({ modelOptions, draftSelection, projectDefaultSelection, stickySelection });

describe("mobile NeoPi model options", () => {
  it("groups native model backends without changing inference-provider identifiers", () => {
    const native = provider("work", { displayName: "NeoPi Work", models: [
      model("openai-codex/current", { name: "Current", subProvider: "OpenAI Codex" }),
      model("anthropic/current", { name: "Current", subProvider: "Anthropic" }),
      model("cursor/current", { subProvider: "Cursor" }),
      model("openrouter/current", { subProvider: "OpenRouter" }),
      model("google/current", { subProvider: "Google", isLegacy: true }),
    ] });
    const options = buildModelOptions(config(native), null);
    expect(options.map((option) => option.selection.model)).toEqual(native.models.map((entry) => entry.slug));
    expect(options.map((option) => option.subtitle)).toEqual(["OpenAI Codex", "Anthropic", "Cursor", "OpenRouter", "Google"]);
    expect(options.at(-1)?.isLegacy).toBe(true);
    expect(groupByProvider(options)).toEqual([{ providerKey: "work", providerLabel: "NeoPi Work", models: options }]);
  });

  it("keeps saved option choices without materializing catalog defaults", () => {
    const native = provider("neopi", { models: [model("openai-codex/current", { capabilities: { optionDescriptors: [
      { id: "reasoningEffort", label: "Thinking", type: "select", options: [{ id: "low", label: "Low", isDefault: true }, { id: "high", label: "High" }], currentValue: "low" },
    ] } })] });
    const environment = config(native);
    expect(buildModelOptions(environment, select())[0]?.selection.options).toBeUndefined();
    const selection = { ...select(), options: [{ id: "reasoningEffort", value: "high" }] };
    expect(buildModelOptions(environment, selection)[0]?.selection.options).toEqual(selection.options);
  });

  it.each(["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"])("does not offer %s as a runtime or a new-task default", (driver) => {
    const legacy = provider(driver, { driver: ProviderDriverKind.make(driver), displayName: driver });
    const saved = select(driver, "saved-model");
    const environment = config(legacy, provider());
    const options = buildModelOptions(environment, saved);
    expect(options.every((option) => option.providerDriver === "neopi")).toBe(true);
    expect(resolveSelectableModelSelection(environment, saved)).toBeNull();
    expect(resolveDefaultableModelSelection(environment, saved)).toBeNull();
    expect(isModelSelectionUnavailable(environment, saved)).toBe(true);
    expect(choose(options, saved)).toEqual(select());
    expect(saved).toEqual(select(driver, "saved-model"));
  });

  it("does not resurrect an obsolete offline default as a phantom model option", () => {
    const saved = select("claudeAgent", "saved-model");
    expect(buildModelOptions(null, saved)).toEqual([]);
    expect(choose([], saved)).toBeNull();
    // The stored value survives until the environment can resolve its real runtime.
    expect(resolveSelectableModelSelection(null, saved)).toBe(saved);
  });

  it("uses runtime metadata rather than an instance id that happens to name an old runtime", () => {
    const native = provider("codex_work");
    const environment = config(native);
    const saved = select("codex_work", "anthropic/current");
    expect(resolveSelectableModelSelection(environment, saved)).toBe(saved);
    expect(choose(buildModelOptions(environment, saved), saved)).toBe(saved);
    expect(isModelSelectionUnavailable(environment, saved)).toBe(false);
  });

  it.each([
    { enabled: false }, { installed: false }, { auth: { status: "unauthenticated" as const } },
    { availability: "unavailable" as const },
  ])("rejects unavailable native configurations for new selections: %j", (state) => {
    const environment = config(provider("neopi", state));
    expect(resolveSelectableModelSelection(environment, select())).toBeNull();
    expect(isModelSelectionUnavailable(environment, select())).toBe(true);
  });

  it("retains an explicit native model when its catalog temporarily disappears", () => {
    const saved = { ...select("neopi", "anthropic/saved"), options: [{ id: "reasoningEffort", value: "high" }] };
    const environment = config(provider("neopi", { models: [], status: "error" }));
    const options = buildModelOptions(environment, saved);
    expect(options).toHaveLength(1);
    expect(options[0]?.selection).toBe(saved);
    expect(options[0]?.isUnavailable).toBe(true);
    expect(choose(options, saved)).toBe(saved);
  });

  it("does not choose retired native models implicitly but preserves an explicit selection", () => {
    const saved = select("neopi", "anthropic/retired");
    const environment = config(provider("neopi", { models: [model(saved.model, { isLegacy: true })] }));
    expect(resolveDefaultableModelSelection(environment, saved)).toBeNull();
    expect(resolveSelectableModelSelection(environment, saved)).toBe(saved);
  });

  it("preserves draft, project, then sticky native choices before choosing the native default", () => {
    const environment = config(provider(), provider("work"));
    const options = buildModelOptions(environment, null);
    const draft = select("work", "anthropic/current");
    const project = select("neopi", "anthropic/current");
    const sticky = select("work", "openai-codex/current");
    expect(choose(options, draft, project, sticky)).toBe(draft);
    expect(choose(options, null, project, sticky)).toBe(project);
    expect(choose(options, null, null, sticky)).toBe(sticky);
    expect(choose(options)).toEqual(select());
  });

  it("skips an obsolete higher-priority preference without losing a valid native project choice", () => {
    const options = buildModelOptions(config(provider()), null);
    const project = select("neopi", "anthropic/current");
    expect(choose(options, select("codex", "saved"), project)).toBe(project);
  });

  it("prefers a ready native instance over an unavailable default and returns null without usable options", () => {
    const environment = config(provider("neopi", { status: "error" }), provider("work"));
    expect(choose(buildModelOptions(environment, null))).toEqual(select("work"));
    expect(choose(buildModelOptions(config(provider("neopi", { models: [] })), null))).toBeNull();
  });
});
