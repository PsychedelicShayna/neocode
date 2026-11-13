import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  projectSettingsOverridePatch,
  hasProjectSettingsOverrides,
  resolveNewThreadEnvMode,
  resolveProjectSettings,
  resolveSendEnvMode,
  resolveWorktreeCleanup,
} from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");

describe("resolveSendEnvMode", () => {
  // regression: #21404 non-git projects send from the current checkout, git repos keep their mode
  it.each(["local", "worktree"] as const)(
    "uses local for non-git projects requesting %s",
    (mode) => {
      expect(resolveSendEnvMode({ requestedEnvMode: mode, isGitRepo: false })).toBe("local");
    },
  );

  it.each(["local", "worktree"] as const)("preserves %s for git repositories", (mode) => {
    expect(resolveSendEnvMode({ requestedEnvMode: mode, isGitRepo: true })).toBe(mode);
  });
});

describe("resolveProjectSettings", () => {
  it("ignores an override left undefined by a forward-compatible decode", () => {
    const resolved = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        defaultRuntimeMode: "full-access",
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      },
      projectId,
    );
    expect(resolved.settings.defaultRuntimeMode).toBe("full-access");
    expect(resolved.sources.defaultRuntimeMode).toBe("environment");
    expect(
      hasProjectSettingsOverrides({
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      }),
    ).toBe(false);
  });

  it("applies overrides per key and reports their source", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultAutoPull: true,
      sidebarAutoSettleAfterDays: 3,
      projectSettingsOverrides: {
        [projectId]: { set: { defaultAutoPull: false, sidebarAutoSettleAfterDays: null } },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultAutoPull).toBe(false);
    expect(resolved.settings.sidebarAutoSettleAfterDays).toBeNull();
    expect(resolved.settings.defaultThreadEnvMode).toBe(settings.defaultThreadEnvMode);
    expect(resolved.sources.defaultAutoPull).toBe("project");
    expect(resolved.sources.sidebarAutoSettleAfterDays).toBe("project");
    expect(resolved.sources.defaultThreadEnvMode).toBe("environment");
    expect(resolveProjectSettings(settings, otherProjectId).settings.defaultAutoPull).toBe(true);
  });

  it("keeps the environment text generation model when the override's provider is disabled", () => {
    const disabledId = ProviderInstanceId.make("neopi_disabled");
    const disabledSelection = createModelSelection(disabledId, "openai-codex/gpt-6-luna");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: {
        [disabledId]: { driver: ProviderDriverKind.make("neopi"), enabled: false, config: {} },
      },
      projectSettingsOverrides: {
        [projectId]: { set: { textGenerationModelSelection: disabledSelection } },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.textGenerationModelSelection).toEqual(
      settings.textGenerationModelSelection,
    );
    expect(resolved.sources.textGenerationModelSelection).toBe("environment");
  });

  it("honours the aggregate's own fields only until the server has folded them", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: {
        [ProviderInstanceId.make("neopi")]: {
          driver: ProviderDriverKind.make("neopi"),
          enabled: true,
          config: {},
        },
      },
      defaultModelSelection: null,
    });
    const aggregateModel = createModelSelection(
      ProviderInstanceId.make("neopi"),
      "openai-codex/gpt-6",
    );
    const project = {
      defaultModelSelection: aggregateModel,
      defaultThreadEnvMode: "local" as const,
    };
    const unfolded = resolveProjectSettings(
      { ...settings, projectSettingsFolded: false },
      projectId,
      project,
    );
    expect(unfolded.settings.defaultModelSelection).toEqual(aggregateModel);
    expect(unfolded.settings.defaultThreadEnvMode).toBe("local");
    expect(unfolded.sources.defaultModelSelection).toBe("project");
    const overridden = resolveProjectSettings(
      {
        ...settings,
        projectSettingsFolded: false,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "worktree" } },
      },
      projectId,
      project,
    );
    expect(overridden.settings.defaultThreadEnvMode).toBe("worktree");
    const folded = resolveProjectSettings(
      { ...settings, projectSettingsFolded: true },
      projectId,
      project,
    );
    expect(folded.settings.defaultModelSelection).toBeNull();
    expect(folded.sources.defaultModelSelection).toBe("environment");
  });

  it("keeps the environment default model when the override's provider is disabled", () => {
    const disabledId = ProviderInstanceId.make("neopi_disabled");
    const disabledSelection = createModelSelection(disabledId, "openai-codex/gpt-6-luna");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: {
        [disabledId]: { driver: ProviderDriverKind.make("neopi"), enabled: false, config: {} },
      },
      projectSettingsOverrides: {
        [projectId]: { set: { defaultModelSelection: disabledSelection } },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultModelSelection).toBeNull();
    expect(resolved.sources.defaultModelSelection).toBe("environment");
  });

  it("moves text generation off an instance the project turned off", () => {
    const native = ProviderInstanceId.make("neopi");
    const alternate = ProviderInstanceId.make("neopi_work");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(native, "openai-codex/gpt-6-luna"),
      providerInstances: {
        [native]: { driver: ProviderDriverKind.make("neopi"), enabled: true, config: {} },
        [alternate]: { driver: ProviderDriverKind.make("neopi"), enabled: true, config: {} },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [native]: { enabled: false } } },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(alternate);
    expect(
      resolveProjectSettings(settings, otherProjectId).settings.textGenerationModelSelection,
    ).toEqual(settings.textGenerationModelSelection);
  });

  it("falls back to a configured native instance instead of a retained legacy provider", () => {
    const legacy = ProviderInstanceId.make("codex");
    const native = ProviderInstanceId.make("neopi_work");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(legacy, "gpt-5"),
      providerInstances: {
        [legacy]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
        [native]: { driver: ProviderDriverKind.make("neopi"), enabled: true, config: {} },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [legacy]: { enabled: false } } },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(native);
  });
});

describe("resolveProjectSettings with a t3.json", () => {
  it("walks project override, environment value, file, then built-in for file-backed keys", () => {
    const file = { defaultThreadEnvMode: "worktree" as const };
    const fromOverride = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "local" } },
      },
      projectId,
      null,
      file,
    );
    expect(fromOverride.settings.defaultThreadEnvMode).toBe("local");
    expect(fromOverride.sources.defaultThreadEnvMode).toBe("project");

    const fromEnvironment = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" },
      projectId,
      null,
      file,
    );
    expect(fromEnvironment.settings.defaultThreadEnvMode).toBe("local");
    expect(fromEnvironment.sources.defaultThreadEnvMode).toBe("environment");

    const fromFile = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, file);
    expect(fromFile.settings.defaultThreadEnvMode).toBe("worktree");
    expect(fromFile.sources.defaultThreadEnvMode).toBe("t3.json");

    const builtIn = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, null);
    expect(builtIn.settings.defaultThreadEnvMode).toBe("local");
    expect(builtIn.sources.defaultThreadEnvMode).toBe("environment");
    const nullOverride = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: null } as never },
      },
      projectId,
      null,
      file,
    );
    expect(nullOverride.settings.defaultThreadEnvMode).toBe("worktree");
    expect(nullOverride.sources.defaultThreadEnvMode).toBe("t3.json");
    expect(
      resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, {}).sources
        .defaultThreadEnvMode,
    ).toBe("environment");
  });
});

describe("resolveNewThreadEnvMode", () => {
  const worktreeEnvironment = resolveProjectSettings(
    { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
    projectId,
    null,
    null,
  );
  const newProject = {
    projectSettings: worktreeEnvironment,
    workspaceRoot: "/data/projects/pinball-stats",
    newProjectsRoot: "/data/projects/",
    projectHasThreads: false,
  };

  it("starts a new project's first thread in its checkout", () => {
    expect(resolveNewThreadEnvMode(newProject)).toBe("local");
    expect(
      resolveNewThreadEnvMode({
        ...newProject,
        workspaceRoot: "C:\\Data\\Projects\\Pinball-Stats",
        newProjectsRoot: "c:/data/projects",
      }),
    ).toBe("local");
  });

  it("keeps the configured default once the project has a thread or is not a new project", () => {
    expect(resolveNewThreadEnvMode({ ...newProject, projectHasThreads: true })).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects" })).toBe(
      "worktree",
    );
    expect(
      resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects/a/nested" }),
    ).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects-old/a" })).toBe(
      "worktree",
    );
    expect(resolveNewThreadEnvMode({ ...newProject, newProjectsRoot: undefined })).toBe("worktree");
  });

  it("lets a project override, or a t3.json the environment defers to, keep worktree mode", () => {
    for (const projectSettings of [
      resolveProjectSettings(
        {
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "worktree" } },
        },
        projectId,
        null,
        null,
      ),
      resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, {
        defaultThreadEnvMode: "worktree",
      }),
    ]) {
      expect(resolveNewThreadEnvMode({ ...newProject, projectSettings })).toBe("worktree");
    }
  });
});

describe("projectSettingsOverrides patches", () => {
  it("merges named keys, clears only named keys, and removes empty entries", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { set: { defaultAutoPull: true } },
        [otherProjectId]: { set: { defaultAutoPull: false } },
      },
    });
    const second = applyServerSettingsPatch(first, {
      projectSettingsOverrides: { [projectId]: { set: { enableAgentBrowserAccess: false } } },
    });
    expect(second.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      enableAgentBrowserAccess: false,
    });
    const cleared = applyServerSettingsPatch(second, {
      projectSettingsOverrides: { [projectId]: { clear: ["defaultAutoPull"] } },
    });
    expect(cleared.projectSettingsOverrides[projectId]).toEqual({
      enableAgentBrowserAccess: false,
    });
    expect(cleared.projectSettingsOverrides[otherProjectId]).toEqual({ defaultAutoPull: false });
    const unchanged = applyServerSettingsPatch(
      cleared,
      // JavaScript callers can retain undefined values that the wire schema does not admit.
      {
        projectSettingsOverrides: { [projectId]: { set: { defaultAutoPull: undefined } } },
      } as unknown as Parameters<typeof applyServerSettingsPatch>[1],
    );
    expect(unchanged.projectSettingsOverrides).toEqual(cleared.projectSettingsOverrides);
    const emptied = applyServerSettingsPatch(cleared, {
      projectSettingsOverrides: { [projectId]: { clear: ["enableAgentBrowserAccess"] } },
    });
    expect(emptied.projectSettingsOverrides[projectId]).toBeUndefined();
    const removed = applyServerSettingsPatch(second, {
      projectSettingsOverrides: { [projectId]: null },
    });
    expect(removed.projectSettingsOverrides).toEqual({
      [otherProjectId]: { defaultAutoPull: false },
    });
    expect(hasProjectSettingsOverrides(second)).toBe(true);
    expect(hasProjectSettingsOverrides(DEFAULT_SERVER_SETTINGS)).toBe(false);
  });

  it("merges partial object edits from the authoritative project value", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: {
          set: {
            sourceControlWritingStyle: { customInstructions: "Keep it short." },
            worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
          },
        },
      },
    });
    const second = applyServerSettingsPatch(first, {
      projectSettingsOverrides: {
        [projectId]: {
          set: {
            sourceControlWritingStyle: { mode: "custom" },
            worktreeCleanup: { mode: "custom", rules: { worktreeOnDelete: true } },
          },
        },
      },
    });
    expect(second.projectSettingsOverrides[projectId]?.sourceControlWritingStyle).toMatchObject({
      mode: "custom",
      customInstructions: "Keep it short.",
    });
    expect(second.projectSettingsOverrides[projectId]?.worktreeCleanup).toMatchObject({
      mode: "custom",
      rules: {
        worktreeAfterDays: 8,
        worktreeOnDelete: true,
      },
    });
  });

  it("distinguishes nullable values from explicit inheritance resets", () => {
    const written = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { set: { defaultModelSelection: null, defaultAutoPull: true } },
      },
    });
    expect(written.projectSettingsOverrides[projectId]?.defaultModelSelection).toBeNull();
    const cleared = applyServerSettingsPatch(written, {
      projectSettingsOverrides: { [projectId]: { clear: ["defaultModelSelection"] } },
    });
    expect(cleared.projectSettingsOverrides[projectId]).toEqual({ defaultAutoPull: true });
  });

  it("derives the legacy per-key maps from the generic record", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { set: { defaultAutoPull: true, enableAgentBrowserAccess: false } },
        [otherProjectId]: { set: { defaultProjectScripts: [] } },
      },
    });
    expect(settings.projectAutoPullOverrides).toEqual({ [projectId]: true });
    expect(settings.projectAgentBrowserAccessOverrides).toEqual({ [projectId]: false });
    expect(settings.projectScriptOverrides).toEqual({ [otherProjectId]: [] });
  });

  it("translates legacy per-key patches into the generic record", () => {
    const written = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectAutoPullOverrides: { [projectId]: true },
      projectAgentBrowserAccessOverrides: { [projectId]: false, [otherProjectId]: true },
    });
    expect(written.projectSettingsOverrides).toEqual({
      [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
      [otherProjectId]: { enableAgentBrowserAccess: true },
    });
    const cleared = applyServerSettingsPatch(written, {
      projectAgentBrowserAccessOverrides: { [projectId]: null, [otherProjectId]: null },
    });
    expect(cleared.projectSettingsOverrides).toEqual({ [projectId]: { defaultAutoPull: true } });
  });

  it("lets a canonical entry win over a legacy map for the same project", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: { [projectId]: { set: { defaultAutoPull: true } } },
    });
    const next = applyServerSettingsPatch(current, {
      projectSettingsOverrides: {
        [projectId]: { set: { defaultThreadEnvMode: "local" }, clear: ["defaultAutoPull"] },
      },
      projectAutoPullOverrides: { [projectId]: true, [otherProjectId]: false },
    });
    expect(next.projectSettingsOverrides).toEqual({
      [projectId]: { defaultThreadEnvMode: "local" },
      [otherProjectId]: { defaultAutoPull: false },
    });
  });

  it("plans only changed keys and preserves partial object patches", () => {
    expect(
      projectSettingsOverridePatch({
        defaultAutoPull: true,
        defaultThreadEnvMode: null,
        defaultModelSelection: null,
        sourceControlWritingStyle: { customInstructions: "Be terse." },
      }),
    ).toEqual({
      set: {
        defaultAutoPull: true,
        defaultModelSelection: null,
        sourceControlWritingStyle: { customInstructions: "Be terse." },
      },
      clear: ["defaultThreadEnvMode"],
    });
  });
});

describe("resolveWorktreeCleanup", () => {
  it("inherits machine rules, disables one project and keeps custom rules isolated", () => {
    const machine = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: {
        worktreeAfterDays: 8,
        worktreeSettledAfterDays: 2,
        worktreeKeepWhen: "any-local-files",
        worktreeOnDelete: true,
        logsAfterDays: 3,
      },
    });
    const inherited = resolveWorktreeCleanup(machine, projectId);
    expect(inherited).toMatchObject({
      worktreeSettledAfterDays: 2,
      worktreeKeepWhen: "any-local-files",
    });
    const off = applyServerSettingsPatch(machine, {
      projectSettingsOverrides: {
        [projectId]: { set: { worktreeCleanup: { mode: "off" } } },
      },
    });
    expect(resolveWorktreeCleanup(off, projectId)).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnDelete: false,
      worktreeOnMerge: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "any-local-files",
    });
    expect(resolveWorktreeCleanup(off, otherProjectId)).toEqual(inherited);
    const custom = applyServerSettingsPatch(off, {
      projectSettingsOverrides: {
        [projectId]: {
          set: {
            worktreeCleanup: {
              mode: "custom",
              rules: { ...inherited, worktreeAfterDays: 15, worktreeSettledAfterDays: 0 },
            },
          },
        },
      },
    });
    expect(resolveWorktreeCleanup(custom, projectId).worktreeAfterDays).toBe(15);
    expect(resolveWorktreeCleanup(custom, projectId).worktreeSettledAfterDays).toBe(0);
    expect(resolveWorktreeCleanup(custom, otherProjectId)).toEqual(inherited);
    expect(custom.storageCleanup.logsAfterDays).toBe(3);
    const reset = applyServerSettingsPatch(custom, {
      projectSettingsOverrides: {
        [projectId]: { clear: ["worktreeCleanup"] },
      },
    });
    expect(resolveWorktreeCleanup(reset, projectId)).toEqual(inherited);
  });
  it("completes partial machine custom rules and preserves them across edits", () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: { worktreeAfterDays: 8, worktreeSettledAfterDays: 0, worktreeOnDelete: true },
    });
    const custom = applyServerSettingsPatch(initial, {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnMerge: true } },
    });
    const edited = applyServerSettingsPatch(custom, {
      worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 15 } },
    });
    expect(resolveWorktreeCleanup(edited, null)).toEqual({
      worktreeAfterDays: 15,
      worktreeSettledAfterDays: 0,
      worktreeOnDelete: true,
      worktreeOnMerge: true,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
    });
    expect(
      resolveWorktreeCleanup(applyServerSettingsPatch(edited, { worktreeCleanup: null }), null)
        .worktreeAfterDays,
    ).toBe(8);
  });
});

it("keeps project speech vocabulary on its originating project and clears it to inherit", () => {
  const words = [{ term: "Effect", aliases: ["a fact"] }];
  const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    projectSettingsOverrides: {
      [projectId]: { set: { speechProjectCustomWords: words, defaultAutoPull: true } },
    },
  });
  expect(resolveProjectSettings(settings, projectId).settings.speechProjectCustomWords).toEqual(
    words,
  );
  expect(
    resolveProjectSettings(settings, otherProjectId).settings.speechProjectCustomWords,
  ).toEqual([]);
  const restored = applyServerSettingsPatch(settings, {
    projectSettingsOverrides: { [projectId]: { clear: ["speechProjectCustomWords"] } },
  });
  expect(resolveProjectSettings(restored, projectId).settings.speechProjectCustomWords).toEqual([]);
  expect(restored.projectSettingsOverrides[projectId]?.defaultAutoPull).toBe(true);
});
