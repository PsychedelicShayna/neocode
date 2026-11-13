import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import type { SettingsTarget } from "./settings-environment-filter";
import {
  managedSettingReason,
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";

const firstId = "first" as EnvironmentId;
const secondId = "second" as EnvironmentId;
const firstProject = "first-project" as ProjectId;
const secondProject = "second-project" as ProjectId;

describe("mobile usage-limit settings across environments", () => {
  it.each(["autoResumeLimitedThreads", "snoozeLimitedThreads"] as const)(
    "shows %s as mixed and can enable it everywhere without changing other settings",
    (key) => {
      const targets = resolveMobileSettingsTargets(
        [
          environment(firstId, {
            ...DEFAULT_SERVER_SETTINGS,
            [key]: true,
            defaultAutoPull: true,
          }),
          environment(secondId, {
            ...DEFAULT_SERVER_SETTINGS,
            [key]: false,
            defaultAutoPull: false,
          }),
        ],
        null,
      );

      expect(uniformMobileSetting(targets, key)).toBeNull();
      const writes = planMobileScopedSettingsPatch(targets, false, { [key]: true });
      expect(writes).toEqual([
        { environmentId: firstId, patch: { [key]: true } },
        { environmentId: secondId, patch: { [key]: true } },
      ]);
      const updatedTargets = targets.map((target) => ({
        ...target,
        settings: writes.reduce(
          (settings, write) =>
            write.environmentId === target.environment.environmentId
              ? applyServerSettingsPatch(settings, write.patch)
              : settings,
          target.settings,
        ),
      }));
      expect(uniformMobileSetting(updatedTargets, key)).toBe(true);
      expect(updatedTargets.map((target) => target.settings.defaultAutoPull)).toEqual([
        true,
        false,
      ]);
      expect(uniformMobileSetting(targets.slice(0, 1), key)).toBe(true);
      expect(uniformMobileSetting(targets.slice(1), key)).toBe(false);
      expect(uniformMobileSetting([], key)).toBeNull();
    },
  );
});

function environment(
  environmentId: EnvironmentId,
  settings: ServerSettings,
  supportsPatches = true,
): SettingsTarget {
  return {
    environmentId,
    serverConfig: {
      settings,
      environment: {
        capabilities: {
          projectSettingsOverrides: true,
          ...(supportsPatches ? { projectSettingsOverridePatches: true } : {}),
        },
      },
    },
  } as SettingsTarget;
}

describe("mobile project settings scope", () => {
  it("edits each checkout's own override without changing either environment default", () => {
    const firstSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "paragraph",
      projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } },
    };
    const secondSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "turn",
      projectSettingsOverrides: {},
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, firstSettings), environment(secondId, secondSettings)],
      [
        { environmentId: firstId, id: firstProject },
        { environmentId: secondId, id: secondProject },
      ],
    );

    const writes = planMobileScopedSettingsPatch(targets, true, {
      responseStreamingMode: "turn",
    });
    expect(writes).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: { set: { responseStreamingMode: "turn" } },
          },
        },
      },
      {
        environmentId: secondId,
        patch: {
          projectSettingsOverrides: { [secondProject]: { set: { responseStreamingMode: "turn" } } },
        },
      },
    ]);
    expect(firstSettings.responseStreamingMode).toBe("paragraph");
    expect(secondSettings.responseStreamingMode).toBe("turn");
  });

  it("removes a project override when a picker sends null for a key that cannot store it", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultThreadEnvMode: "worktree", defaultAutoPull: true },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );
    expect(planMobileScopedSettingsPatch(targets, true, { defaultThreadEnvMode: null })).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: { [firstProject]: { clear: ["defaultThreadEnvMode"] } },
        },
      },
    ]);
    expect(planMobileScopedSettingsPatch(targets, true, { defaultModelSelection: null })).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: { set: { defaultModelSelection: null } },
          },
        },
      },
    ]);
  });

  it("resets only the selected page's override and rejects environment-wide writes", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultAutoPull: true, responseStreamingMode: "turn" },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );

    expect(planMobileScopedSettingsClear(targets, ["responseStreamingMode"])).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: { [firstProject]: { clear: ["responseStreamingMode"] } },
        },
      },
    ]);
    expect(
      planMobileScopedSettingsPatch(targets, true, {
        storageCleanup: DEFAULT_SERVER_SETTINGS.storageCleanup,
      }),
    ).toEqual([]);
  });

  it("preserves unrelated edits and resets planned from one stale snapshot", () => {
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, DEFAULT_SERVER_SETTINGS)],
      [{ environmentId: firstId, id: firstProject }],
    );
    const first = planMobileScopedSettingsPatch(targets, true, { defaultAutoPull: true });
    const second = planMobileScopedSettingsPatch(targets, true, {
      enableAgentBrowserAccess: false,
    });
    const clear = planMobileScopedSettingsClear(targets, ["defaultAutoPull"]);
    let settings = DEFAULT_SERVER_SETTINGS;
    for (const write of [...first, ...second])
      settings = applyServerSettingsPatch(settings, write.patch);
    expect(settings.projectSettingsOverrides[firstProject]).toEqual({
      defaultAutoPull: true,
      enableAgentBrowserAccess: false,
    });
    for (const write of clear) settings = applyServerSettingsPatch(settings, write.patch);
    expect(settings.projectSettingsOverrides[firstProject]).toEqual({
      enableAgentBrowserAccess: false,
    });
  });

  it("does not send key mutations to servers that only support entry replacement", () => {
    const old = environment(firstId, DEFAULT_SERVER_SETTINGS, false);
    const targets = resolveMobileSettingsTargets(
      [old],
      [{ environmentId: firstId, id: firstProject }],
    );
    expect(planMobileScopedSettingsPatch(targets, true, { defaultAutoPull: true })).toEqual([]);
    expect(planMobileScopedSettingsClear(targets, ["defaultAutoPull"])).toEqual([]);
  });
});

describe("managed settings across environments", () => {
  it("names the manager when any selected environment locks the setting", () => {
    const managed = {
      ...environment(secondId, DEFAULT_SERVER_SETTINGS),
      serverConfig: {
        ...environment(secondId, DEFAULT_SERVER_SETTINGS).serverConfig,
        managedPolicy: { organization: "Example Corp", lockedSettings: ["storageCleanup"] },
      },
    } as SettingsTarget;
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, DEFAULT_SERVER_SETTINGS), managed],
      null,
    );

    expect(managedSettingReason(targets, "storageCleanup.logsAfterDays")).toBe(
      "Managed by Example Corp.",
    );
    expect(managedSettingReason(targets, "defaultAutoPull", "storageCleanup")).toBe(
      "Managed by Example Corp.",
    );
    expect(managedSettingReason(targets, "defaultAutoPull")).toBeUndefined();
    expect(managedSettingReason(targets.slice(0, 1), "storageCleanup")).toBeUndefined();
  });
});
