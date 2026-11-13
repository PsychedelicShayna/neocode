import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  resolveScopedSettingsTargets,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  selectScopedSettingsEnvironments,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

function environment(
  id: string,
  options: {
    connected?: boolean;
    loaded?: boolean;
    settings?: Partial<ServerSettings>;
    projectOverrides?: boolean;
  } = {},
) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: {
      phase: options.connected === false ? ("offline" as const) : ("connected" as const),
    },
    serverConfig:
      options.loaded === false
        ? null
        : {
            settings: { ...DEFAULT_SERVER_SETTINGS, ...options.settings },
            environment: {
              capabilities: {
                projectSettingsOverrides: true,
                projectSettingsOverridePatches: options.projectOverrides !== false,
              },
            },
          },
  };
}

const laptop = environment("Laptop");
const server = environment("Server");
const offline = environment("Offline", { connected: false });
const loading = environment("Loading", { loaded: false });
const environments = [laptop, server, offline, loading];
const all = resolveSettingsScope({}, [], environments);
const named = resolveSettingsScope({ machine: server.environmentId }, [], environments);

const projectId = ProjectId.make("project");
const laptopProjectId = ProjectId.make("laptop-project");
const member = {
  id: projectId,
  environmentId: server.environmentId,
  title: "Project",
  workspaceRoot: "/repo",
  physicalProjectKey: `${server.environmentId}:/repo`,
  environmentLabel: server.label,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const laptopMember = {
  ...member,
  id: laptopProjectId,
  environmentId: laptop.environmentId,
  physicalProjectKey: `${laptop.environmentId}:/repo`,
  environmentLabel: laptop.label,
};
const group: SidebarProjectSnapshot = {
  ...member,
  projectKey: "project-group",
  displayName: "Project",
  memberProjects: [member, laptopMember],
  memberProjectRefs: [
    { environmentId: server.environmentId, projectId },
    { environmentId: laptop.environmentId, projectId: laptopProjectId },
  ],
  groupedProjectCount: 2,
  environmentPresence: "remote-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: [server.label, laptop.label],
  pinned: false,
  archived: false,
};
const project = resolveSettingsScope({ project: group.projectKey }, [group], environments);
const checkout = resolveSettingsScope(
  { project: group.projectKey, machine: server.environmentId, checkout: member.physicalProjectKey },
  [group],
  environments,
);

describe("scoped settings targets", () => {
  it("uses the named environment even when a different primary is available", () => {
    const selected = selectScopedSettingsEnvironments(named, environments, laptop.environmentId);
    expect(selected.environments).toEqual([server]);
    expect(selected.environment).toBe(server);
  });

  it("keeps an offline named environment selected without falling back to primary", () => {
    const scope = resolveSettingsScope({ machine: offline.environmentId }, [], environments);
    const selected = selectScopedSettingsEnvironments(scope, environments, laptop.environmentId);
    expect(selected.environments).toEqual([offline]);
    expect(selected.connectedEnvironments).toEqual([]);
    expect(selected.environment).toBeNull();
    expect(
      planScopedSettingsPatch(scope, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "Connect Offline to save this setting.",
    });
  });

  it("resolves each member's effective settings and source at project scope", () => {
    const overridden = environment("Server", {
      settings: {
        defaultAutoPull: false,
        projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
      },
    });
    const targets = resolveScopedSettingsTargets(project, [laptop, overridden]);
    expect(targets.map((target) => [target.projectId, target.settings.defaultAutoPull])).toEqual([
      [projectId, true],
      [laptopProjectId, false],
    ]);
    expect(scopedSettingsSource(targets, ["defaultAutoPull"])).toBe("mixed");
    expect(scopedSettingsSource([targets[0]!], ["defaultAutoPull"])).toBe("project");
    expect(scopedSettingsSource(targets, ["enableProviderUpdateChecks"])).toBe("environment");
    expect(scopedSettingsAreMixed(targets, ["defaultAutoPull"])).toBe(true);
  });
});

describe("scoped settings writes", () => {
  it("edits the effective machine policy without changing other machines' rules", () => {
    const custom = environment("Laptop", {
      settings: {
        worktreeCleanup: {
          mode: "custom",
          rules: {
            worktreeAfterDays: 12,
            worktreeSettledAfterDays: null,
            worktreeOnDelete: true,
            worktreeOnMerge: true,
            worktreeUnchanged: false,
            worktreeKeepWhen: "uncommitted-changes",
          },
        },
      },
    });
    const disabled = environment("Server", {
      settings: { worktreeCleanup: { mode: "off" } },
    });
    const targets = [custom, disabled];
    const plan = planScopedSettingsPatch(all, targets, {
      storageCleanup: { worktreeOnDelete: false },
    });
    const policies = plan.serverWrites.map((write, index) =>
      resolveWorktreeCleanup(
        applyServerSettingsPatch(targets[index]!.serverConfig!.settings, write.patch),
        null,
      ),
    );
    expect(policies).toEqual([
      {
        worktreeAfterDays: 12,
        worktreeSettledAfterDays: null,
        worktreeOnDelete: false,
        worktreeOnMerge: true,
        worktreeUnchanged: false,
        worktreeKeepWhen: "uncommitted-changes",
      },
      {
        worktreeAfterDays: null,
        worktreeSettledAfterDays: null,
        worktreeOnDelete: false,
        worktreeOnMerge: false,
        worktreeUnchanged: false,
        worktreeKeepWhen: "uncommitted-changes",
      },
    ]);
  });

  describe("an environment that saves but drops keys it does not know", () => {
    const upgradedLaptop = (saved: Partial<ServerSettings>) =>
      vi.fn(async ({ environmentId }: { environmentId: EnvironmentId }) => ({
        _tag: "Success" as const,
        value: {
          ...DEFAULT_SERVER_SETTINGS,
          ...(environmentId === laptop.environmentId ? saved : {}),
        },
      }));
    const outcome = async (
      plan: ReturnType<typeof planScopedSettingsPatch>,
      persistServer: ReturnType<typeof upgradedLaptop>,
    ) => {
      const result = await persistScopedSettingsPatch(plan, persistServer, vi.fn());
      return {
        saved: result.savedEnvironments.map(({ label }) => label),
        failed: result.failedEnvironments.map(({ label, message }) => ({ label, message })),
      };
    };
    const unsupported = [
      {
        label: server.label,
        message: "This environment does not support this setting. Update T3 Code on it.",
      },
    ];

    it("reports a dropped toggle", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { reviewGuidesEnabled: true }),
          upgradedLaptop({ reviewGuidesEnabled: true }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    it("reports dropped text but accepts the server trimming it", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { reviewGuideInstructions: " Read tests " }),
          upgradedLaptop({ reviewGuideInstructions: "Read tests" }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    // regression: #18334 an environment silently dropped a setting with no warning
    it("reports a dropped key inside a project override", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(project, environments, { defaultAutoPull: true }),
          upgradedLaptop({
            projectSettingsOverrides: { [laptopProjectId]: { defaultAutoPull: true } },
          }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
      const withOverrides = environment("Server", {
        settings: {
          projectSettingsOverrides: {
            [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
          },
        },
      });
      const reset = planScopedSettingsClear(checkout, [withOverrides], ["defaultAutoPull"]);
      const ignored = await persistScopedSettingsPatch(
        reset,
        async () => ({ _tag: "Success", value: withOverrides.serverConfig!.settings }),
        vi.fn(),
      );
      expect(ignored.savedEnvironments).toEqual([]);
      expect(ignored.failedEnvironments.map(({ environmentId }) => environmentId)).toEqual([
        server.environmentId,
      ]);
      const applied = await persistScopedSettingsPatch(
        reset,
        async () => ({
          _tag: "Success",
          value: {
            ...withOverrides.serverConfig!.settings,
            projectSettingsOverrides: {
              [projectId]: { enableAgentBrowserAccess: false },
            },
          },
        }),
        vi.fn(),
      );
      expect(applied.failedEnvironments).toEqual([]);
      expect(applied.savedEnvironments.map(({ environmentId }) => environmentId)).toEqual([
        server.environmentId,
      ]);
    });

    it("accepts a write that matches what the environment already had", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { reviewGuidesEnabled: false }),
          upgradedLaptop({}),
        ),
      ).toEqual({ saved: [laptop.label, server.label], failed: [] });
    });
  });

  it("writes project overrides into each member's entry on its environment", () => {
    const withExisting = environment("Server", {
      settings: {
        projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
      },
    });
    const plan = planScopedSettingsPatch(project, [laptop, withExisting], {
      defaultAutoPull: true,
    });
    expect(plan.unavailableReason).toBeNull();
    expect(plan.serverWrites).toEqual([
      {
        environmentId: server.environmentId,
        label: server.label,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: {
            [projectId]: { set: { defaultAutoPull: true } },
          },
        },
      },
      {
        environmentId: laptop.environmentId,
        label: laptop.label,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: { [laptopProjectId]: { set: { defaultAutoPull: true } } },
        },
      },
    ]);
    expect(
      planScopedSettingsPatch(checkout, [laptop, server], { defaultAutoPull: true }),
    ).toMatchObject({
      serverWrites: [{ environmentId: server.environmentId }],
    });
  });

  it("keeps each project's other cleanup rules when changing one rule across machines", () => {
    const machine = environment("Laptop", {
      settings: {
        storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeAfterDays: 30 },
      },
    });
    const customized = environment("Server", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: {
            defaultAutoPull: true,
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: 8,
                worktreeSettledAfterDays: null,
                worktreeOnDelete: false,
                worktreeOnMerge: true,
                worktreeUnchanged: false,
                worktreeKeepWhen: "uncommitted-changes",
              },
            },
          },
        },
      },
    });
    const plan = planScopedSettingsPatch(project, [machine, customized], {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnDelete: true } },
    });
    const serverWrite = plan.serverWrites.find(
      (write) => write.environmentId === server.environmentId,
    )!;
    const laptopWrite = plan.serverWrites.find(
      (write) => write.environmentId === laptop.environmentId,
    )!;
    const updatedServer = applyServerSettingsPatch(
      customized.serverConfig!.settings,
      serverWrite.patch,
    );
    const updatedLaptop = applyServerSettingsPatch(
      machine.serverConfig!.settings,
      laptopWrite.patch,
    );
    expect(resolveWorktreeCleanup(updatedServer, projectId)).toEqual({
      worktreeAfterDays: 8,
      worktreeSettledAfterDays: null,
      worktreeOnDelete: true,
      worktreeOnMerge: true,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
    });
    expect(resolveWorktreeCleanup(updatedLaptop, laptopProjectId)).toEqual({
      worktreeAfterDays: 30,
      worktreeSettledAfterDays: null,
      worktreeOnDelete: true,
      worktreeOnMerge: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
    });
    expect(updatedServer.projectSettingsOverrides[projectId]?.defaultAutoPull).toBe(true);
    const settledPlan = planScopedSettingsPatch(project, [machine, customized], {
      worktreeCleanup: { mode: "custom", rules: { worktreeSettledAfterDays: 0 } },
    });
    for (const write of settledPlan.serverWrites) {
      const previous =
        write.environmentId === server.environmentId
          ? customized.serverConfig!.settings
          : machine.serverConfig!.settings;
      const targetProject =
        write.environmentId === server.environmentId ? projectId : laptopProjectId;
      expect(
        resolveWorktreeCleanup(applyServerSettingsPatch(previous, write.patch), targetProject),
      ).toMatchObject({ worktreeSettledAfterDays: 0 });
    }
    expect(
      planScopedSettingsClear(checkout, [customized], ["worktreeCleanup"]).serverWrites[0]?.patch,
    ).toEqual({
      projectSettingsOverrides: { [projectId]: { clear: ["worktreeCleanup"] } },
    });
    expect(
      planScopedSettingsPatch(project, [machine, customized], {
        storageCleanup: { browserArtifactsAfterDays: 8 },
      }).serverWrites,
    ).toEqual([]);
  });

  // regression: #11541 device settings were written to the wrong scope
  it("scopes agent device access to projects while keeping hub and hosts environment-wide", () => {
    const plan = planScopedSettingsPatch(project, [laptop, server], {
      enableAgentDeviceAccess: true,
    });
    expect(plan.serverWrites.map((write) => write.patch)).toEqual([
      { projectSettingsOverrides: { [projectId]: { set: { enableAgentDeviceAccess: true } } } },
      {
        projectSettingsOverrides: { [laptopProjectId]: { set: { enableAgentDeviceAccess: true } } },
      },
    ]);
    for (const patch of [{ enableDeviceSupport: true }, { deviceHosts: [] }]) {
      expect(planScopedSettingsPatch(project, environments, patch).serverWrites).toEqual([]);
    }
  });

  it("refuses environment-wide keys at project scope", () => {
    expect(
      planScopedSettingsPatch(project, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "This setting is environment-wide and cannot be overridden by a project.",
    });
  });

  it("clears overrides per member and removes an emptied entry", () => {
    const withOverrides = environment("Server", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        },
      },
    });
    const plan = planScopedSettingsClear(checkout, [laptop, withOverrides], ["defaultAutoPull"]);
    expect(plan.serverWrites).toEqual([
      {
        environmentId: server.environmentId,
        label: server.label,
        previous: expect.anything(),
        patch: { projectSettingsOverrides: { [projectId]: { clear: ["defaultAutoPull"] } } },
      },
    ]);
    expect(
      planScopedSettingsClear(
        checkout,
        [laptop, withOverrides],
        ["defaultAutoPull", "enableAgentBrowserAccess"],
      ).serverWrites[0]?.patch,
    ).toEqual({
      projectSettingsOverrides: {
        [projectId]: { clear: ["defaultAutoPull", "enableAgentBrowserAccess"] },
      },
    });
  });

  it("preserves independent edits and resets planned before the configuration refreshes", () => {
    const first = planScopedSettingsPatch(checkout, [server], { defaultAutoPull: true });
    const second = planScopedSettingsPatch(checkout, [server], { enableAgentBrowserAccess: false });
    const reset = planScopedSettingsClear(checkout, [server], ["defaultAutoPull"]);
    let settings = server.serverConfig!.settings;
    for (const write of [...first.serverWrites, ...second.serverWrites]) {
      settings = applyServerSettingsPatch(settings, write.patch);
    }
    expect(settings.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      enableAgentBrowserAccess: false,
    });
    for (const write of reset.serverWrites)
      settings = applyServerSettingsPatch(settings, write.patch);
    expect(settings.projectSettingsOverrides[projectId]).toEqual({
      enableAgentBrowserAccess: false,
    });
  });

  it("never substitutes an environment-default write for an invalid scope", () => {
    const scope = resolveSettingsScope({ machine: "removed" }, [group], environments);
    const plan = planScopedSettingsPatch(scope, environments, { enableAgentBrowserAccess: false });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.hasClientWrite).toBe(false);
    expect(plan.unavailableReason).not.toBeNull();
  });

  it("waits for every target and identifies both RPC failures and rejected writes", async () => {
    const third = environment("Third");
    const fourth = environment("Fourth");
    const selected = [...environments, third, fourth];
    const scope = resolveSettingsScope({}, [], selected);
    const persistServer = vi
      .fn()
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: "settings:write",
            message: "This connection lacks permission to change settings.",
          }),
        ),
      })
      .mockRejectedValueOnce(new Error("Disconnected during save"))
      .mockResolvedValueOnce({ _tag: "Success" });
    const result = await persistScopedSettingsPatch(
      planScopedSettingsPatch(scope, selected, { enableAgentBrowserAccess: false }),
      persistServer,
      vi.fn(),
    );
    expect(result.savedEnvironmentCount).toBe(2);
    expect(result.savedEnvironments.map(({ label }) => label)).toEqual([
      laptop.label,
      fourth.label,
    ]);
    expect(result.failedEnvironments.map(({ message }) => message)).toEqual([
      "This connection lacks permission to change settings.",
      "Disconnected during save",
    ]);
    expect(result.failedEnvironments.map(({ label }) => label)).toEqual([
      server.label,
      third.label,
    ]);
    expect(persistServer).toHaveBeenCalledTimes(4);
  });

  it("waits for a client-only write and reports its rejection", async () => {
    let failClient!: (error: Error) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const persistClient = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          failClient = reject;
          signalStarted();
        }),
    );
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    let settled = false;
    const pending = persistScopedSettingsPatch(
      planScopedSettingsPatch(named, environments, { diffIgnoreWhitespace: false }),
      persistServer,
      persistClient,
    ).then((result) => {
      settled = true;
      return result;
    });
    await started;
    expect(settled).toBe(false);
    failClient(new Error("Storage unavailable"));

    expect(await pending).toEqual({
      failedEnvironments: [],
      failedClientWrite: true,
      savedEnvironments: [],
      savedEnvironmentCount: 0,
    });
    expect(persistServer).not.toHaveBeenCalled();
  });

  it("collects client and server failures without losing successful server writes", async () => {
    const persistServer = vi
      .fn()
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({ _tag: "Failure" });
    const result = await persistScopedSettingsPatch(
      planScopedSettingsPatch(all, environments, {
        diffIgnoreWhitespace: false,
        enableProviderUpdateChecks: false,
      }),
      persistServer,
      vi.fn().mockRejectedValue(new Error("Storage unavailable")),
    );

    expect(result.failedClientWrite).toBe(true);
    expect(result.savedEnvironmentCount).toBe(1);
    expect(result.failedEnvironments.map(({ label }) => label)).toEqual([server.label]);
    expect(persistServer).toHaveBeenCalledTimes(2);
  });
});

describe("scoped settings mixed values", () => {
  it("treats independently decoded equal nested settings as the same value", () => {
    const style = {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      mode: "custom" as const,
      customInstructions: "Use plain language",
    };
    const first = environment("First", { settings: { sourceControlWritingStyle: { ...style } } });
    const second = environment("Second", { settings: { sourceControlWritingStyle: { ...style } } });
    const targets = resolveScopedSettingsTargets(all, [first, second]);
    expect(scopedSettingsAreMixed(targets, ["sourceControlWritingStyle"])).toBe(false);
  });
});

describe("project overrides at environment scope", () => {
  const laptop = EnvironmentId.make("laptop");
  const fleet = ProjectId.make("fleet");
  const t3 = ProjectId.make("t3");
  const environment = (
    environmentId: EnvironmentId,
    overrides: ServerSettings["projectSettingsOverrides"],
  ) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" as const },
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides: overrides },
      environment: { capabilities: { projectSettingsOverridePatches: true } },
    },
  });

  it("clears only those keys and drops entries that become empty", () => {
    const plan = planProjectOverridesClear(
      [
        environment(laptop, {
          [fleet]: { defaultAutoPull: true, defaultThreadEnvMode: "local" },
          [t3]: { defaultAutoPull: true },
        }),
      ],
      [
        { environmentId: laptop, projectId: fleet },
        { environmentId: laptop, projectId: t3 },
      ],
      ["defaultAutoPull"],
    );
    expect(plan.serverWrites).toEqual([
      {
        environmentId: laptop,
        label: laptop,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: {
            [fleet]: { clear: ["defaultAutoPull"] },
            [t3]: { clear: ["defaultAutoPull"] },
          },
        },
      },
    ]);
  });
});

describe("null patches at project scope", () => {
  it("removes the override for keys that cannot store null and keeps it for keys that can", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const scope = {
      kind: "project" as const,
      group: {} as never,
      environmentId: null,
      label: "fleet",
      members: [{ id: projectId, environmentId } as never],
      environmentIds: [environmentId],
    };
    const environments = [
      {
        environmentId,
        label: "Laptop",
        connection: { phase: "connected" as const },
        serverConfig: {
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            projectSettingsOverrides: {
              [projectId]: { defaultThreadEnvMode: "worktree" as const, defaultAutoPull: true },
            },
          },
          environment: { capabilities: { projectSettingsOverridePatches: true } },
        },
      },
    ];
    expect(
      planScopedSettingsPatch(scope, environments, { defaultThreadEnvMode: null }).serverWrites[0]
        ?.patch,
    ).toEqual({ projectSettingsOverrides: { [projectId]: { clear: ["defaultThreadEnvMode"] } } });
    expect(
      planScopedSettingsPatch(scope, environments, { defaultModelSelection: null }).serverWrites[0]
        ?.patch,
    ).toEqual({
      projectSettingsOverrides: {
        [projectId]: { set: { defaultModelSelection: null } },
      },
    });
  });
});

describe("partial object patches at project scope", () => {
  it("leaves partial writing style edits for the server to rebase", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const member = {
      id: projectId,
      environmentId,
      physicalProjectKey: "laptop:/repo",
      environmentLabel: "Laptop",
      title: "fleet",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "Keep it short.",
            followChangeRequestTemplates: false,
          },
        },
      },
    };
    const plan = planScopedSettingsPatch(
      {
        kind: "project",
        group: {} as never,
        environmentId: null,
        label: "fleet",
        members: [member as never],
        environmentIds: [environmentId],
      },
      [
        {
          environmentId,
          label: "Laptop",
          connection: { phase: "connected" },
          serverConfig: {
            settings,
            environment: { capabilities: { projectSettingsOverridePatches: true } },
          },
        },
      ],
      { sourceControlWritingStyle: { customInstructions: "Be terse." } },
    );
    expect(plan.serverWrites[0]?.patch).toEqual({
      projectSettingsOverrides: {
        [projectId]: {
          set: { sourceControlWritingStyle: { customInstructions: "Be terse." } },
        },
      },
    });
    const saved = applyServerSettingsPatch(settings, plan.serverWrites[0]!.patch);
    expect(saved.projectSettingsOverrides[projectId]?.sourceControlWritingStyle).toEqual({
      mode: "custom",
      customInstructions: "Be terse.",
      followChangeRequestTemplates: false,
    });
  });
});

it("routes legacy model preference keys exclusively to the selected environment", () => {
  const patch = {
    favorites: [{ provider: ProviderInstanceId.make("codex"), model: "sol" }],
    providerModelPreferences: {},
  };
  const plan = planScopedSettingsPatch(named, environments, patch);
  expect(plan.clientPatch).toEqual({});
  expect(plan.hasClientWrite).toBe(false);
  expect(plan.serverWrites).toEqual([
    {
      environmentId: server.environmentId,
      label: server.label,
      previous: expect.anything(),
      patch,
    },
  ]);
});

describe("model selection patches at project scope", () => {
  const codex = ProviderInstanceId.make("neopi");
  const claude = ProviderInstanceId.make("neopi-secondary");
  const saved = {
    instanceId: codex,
    model: "gpt-5.6",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const customized = environment("Server", {
    settings: {
      projectSettingsOverrides: {
        [projectId]: {
          defaultModelSelection: saved,
          sourceControlWriterModelSelection: saved,
          reviewGuideModelSelection: saved,
          textGenerationModelSelection: saved,
        },
      },
    },
  });

  // regression: #16581 changing a project's model kept the old model's options
  it("replaces old options when changing model selections", () => {
    const plan = planScopedSettingsPatch(checkout, [customized], {
      defaultModelSelection: { instanceId: claude, model: "claude-opus-4-8" },
      sourceControlWriterModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      reviewGuideModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      textGenerationModelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
    });
    const updated = applyServerSettingsPatch(
      customized.serverConfig!.settings,
      plan.serverWrites[0]!.patch,
    );
    expect(updated.projectSettingsOverrides[projectId]).toEqual({
      defaultModelSelection: { instanceId: claude, model: "claude-opus-4-8" },
      sourceControlWriterModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      reviewGuideModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      textGenerationModelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
    });
  });

  it("completes partial text-generation selections without retaining old options", () => {
    const modelPlan = planScopedSettingsPatch(checkout, [customized], {
      textGenerationModelSelection: { model: "gpt-5.6-mini" },
    });
    expect(
      applyServerSettingsPatch(customized.serverConfig!.settings, modelPlan.serverWrites[0]!.patch)
        .projectSettingsOverrides[projectId]?.textGenerationModelSelection,
    ).toEqual({ instanceId: codex, model: "gpt-5.6-mini" });

    const options = [{ id: "reasoningEffort", value: "low" }];
    const optionsPlan = planScopedSettingsPatch(checkout, [customized], {
      textGenerationModelSelection: { options },
    });
    expect(
      applyServerSettingsPatch(
        customized.serverConfig!.settings,
        optionsPlan.serverWrites[0]!.patch,
      ).projectSettingsOverrides[projectId]?.textGenerationModelSelection,
    ).toEqual({ ...saved, options });
  });
});
