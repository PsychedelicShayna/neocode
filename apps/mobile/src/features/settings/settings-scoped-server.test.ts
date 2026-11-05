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
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
} from "./settings-scoped-server";

const firstId = "first" as EnvironmentId;
const secondId = "second" as EnvironmentId;
const firstProject = "first-project" as ProjectId;
const secondProject = "second-project" as ProjectId;

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
      responseStreamingMode: "token",
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
    expect(secondSettings.responseStreamingMode).toBe("token");
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
      planMobileScopedSettingsPatch(targets, true, { enableProviderUpdateChecks: false }),
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
