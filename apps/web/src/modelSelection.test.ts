import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { createModelSelection } from "@t3tools/shared/model";
import { deriveEffectiveComposerModelState } from "./composerDraftStore";
import { getComposerProviderState } from "./components/chat/composerProviderState";
import { deriveProviderInstanceEntries, NO_PROVIDER_MODEL_SELECTION } from "./providerInstances";
import {
  defaultModelSelectionsAreMixed,
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

it("compares automatic defaults across native environments, projects and model preferences", () => {
  const personal = provider("personal", { models: [model("anthropic/current", true)] });
  const work = provider("work");
  const first = {
    projectId: null,
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [work.instanceId]: { driver: work.driver, enabled: true },
        [personal.instanceId]: { driver: personal.driver, enabled: true },
      },
    },
    providers: [work],
  };
  const second = { ...first, providers: [personal] };
  expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [first, second])).toBe(true);
  expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [second, first])).toBe(true);
  expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [first, { ...first }])).toBe(
    false,
  );
  expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [first])).toBe(false);
  expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [])).toBe(false);
  expect(
    defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [first, { ...first, providers: [] }]),
  ).toBe(true);
  expect(
    defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [
      first,
      { ...first, providers: [provider("work", { models: [model("google/current", true)] })] },
    ]),
  ).toBe(true);

  const projectId = ProjectId.make("personal-only");
  const project = {
    projectId,
    settings: {
      ...first.settings,
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [work.instanceId]: { enabled: false } } },
      },
    },
    providers: [work, personal],
  };
  const remoteProject = { ...second, projectId: ProjectId.make("remote") };
  expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [project, remoteProject])).toBe(
    false,
  );
  expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [remoteProject, project])).toBe(
    false,
  );
  expect(
    defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [
      project,
      { ...project, projectId: ProjectId.make("other-project") },
    ]),
  ).toBe(true);

  const configured = {
    ...first,
    settings: {
      ...first.settings,
      providerModelPreferences: {
        [work.instanceId]: { hiddenModels: ["openai-codex/current"], modelOrder: [] },
      },
    },
  };
  expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [configured, first])).toBe(true);
  expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [first, configured])).toBe(true);
  const clientSettings = {
    ...DEFAULT_CLIENT_SETTINGS,
    providerModelPreferences: configured.settings.providerModelPreferences,
  };
  expect(defaultModelSelectionsAreMixed(clientSettings, [configured, first])).toBe(false);
  expect(defaultModelSelectionsAreMixed(clientSettings, [first, configured])).toBe(false);
  expect(
    defaultModelSelectionsAreMixed(clientSettings, [
      { ...first, settings: { ...first.settings, providerModelPreferences: {} } },
      first,
    ]),
  ).toBe(true);
});

it("distinguishes automatic defaults from explicit native roles and saved options", () => {
  const current = provider();
  const selected = {
    projectId: null,
    providers: [current],
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: createModelSelection(current.instanceId, "@review"),
    },
  };
  expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [selected, { ...selected }])).toBe(
    false,
  );
  expect(
    defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [
      selected,
      { ...selected, settings: DEFAULT_SERVER_SETTINGS },
    ]),
  ).toBe(true);
  expect(
    defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [
      selected,
      {
        ...selected,
        settings: {
          ...selected.settings,
          defaultModelSelection: {
            ...selected.settings.defaultModelSelection,
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          },
        },
      },
    ]),
  ).toBe(true);
});

it("offers every saved custom model without reviving stale catalog rows or expanding aliases", () => {
  const customModels = ["current", ...Array.from({ length: 40 }, (_, i) => `proxy/model-${i}`)];
  const current = provider("work", {
    models: [
      { ...model("anthropic/current"), aliases: ["current"] },
      { ...model("removed/custom"), isCustom: true },
    ],
  });
  const configured = settings({
    providerInstances: {
      [current.instanceId]: { driver: current.driver, config: { customModels } },
    },
  });
  const [entry] = deriveProviderInstanceEntries([current]);
  const options = getAppModelOptionsForInstance(configured, entry!);
  expect(options.map((option) => option.slug)).toEqual(["anthropic/current", ...customModels]);
  for (const slug of ["current", "proxy/model-39"]) {
    expect(
      resolveAppModelSelectionForInstance(current.instanceId, configured, [current], slug),
    ).toBe(slug);
  }
});

it("falls back only to native instances that support text generation", () => {
  const unsupported = provider("work", { supportsTextGeneration: false });
  const supported = provider("personal");
  const configured = settings({
    textGenerationModelSelection: createModelSelection(unsupported.instanceId, "@work"),
  });
  expect(resolveAppModelSelectionState(configured, [unsupported, supported])).toEqual(
    createModelSelection(supported.instanceId, "openai-codex/current"),
  );
  expect(resolveAppModelSelectionState(configured, [unsupported])).toEqual(
    NO_PROVIDER_MODEL_SELECTION,
  );
});

it("keeps native fallback options with their model and prefers the destination's saved options", () => {
  const requested = provider("work", { enabled: false });
  const selected = provider("personal");
  const providers = [requested, selected];
  const picked = createModelSelection(requested.instanceId, "@review", [
    { id: "reasoningEffort", value: "xhigh" },
  ]);
  for (const destinationOptions of [undefined, [{ id: "reasoningEffort", value: "high" }]]) {
    const destination = createModelSelection(selected.instanceId, "@review", destinationOptions);
    const state = deriveEffectiveComposerModelState({
      draft: destinationOptions
        ? {
            activeProvider: requested.instanceId,
            modelSelectionByProvider: {
              [requested.instanceId]: picked,
              [selected.instanceId]: destination,
            },
          }
        : null,
      providers,
      selectedProvider: selected.driver,
      selectedInstanceId: selected.instanceId,
      requestedInstanceId: requested.instanceId,
      threadModelSelection: picked,
      projectModelSelection: null,
      settings: settings(),
    });
    const dispatch = getComposerProviderState({
      provider: selected.driver,
      model: state.selectedModel,
      models: selected.models,
      modelOptions: state.modelOptions?.[selected.instanceId],
    });
    expect(
      createModelSelection(
        selected.instanceId,
        state.selectedModel,
        dispatch.modelOptionsForDispatch,
      ),
    ).toEqual(
      createModelSelection(selected.instanceId, "@review", destinationOptions ?? picked.options),
    );
  }
  const state = deriveEffectiveComposerModelState({
    draft: {
      activeProvider: selected.instanceId,
      modelSelectionByProvider: {
        [selected.instanceId]: createModelSelection(selected.instanceId, "@different-role"),
      },
    },
    providers,
    selectedProvider: selected.driver,
    selectedInstanceId: selected.instanceId,
    requestedInstanceId: requested.instanceId,
    threadModelSelection: picked,
    projectModelSelection: null,
    settings: settings(),
  });
  expect(state.selectedModel).toBe("@different-role");
  expect(state.modelOptions?.[selected.instanceId]).toBeUndefined();
});
