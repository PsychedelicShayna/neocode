import {
  AuthProvidersManageScope,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import {
  buildProviderInstanceOverridePatch,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";

const decodeSettingsPatch = Schema.decodeSync(ServerSettingsPatch);

describe("buildProviderInstanceOverridePatch", () => {
  const projectId = ProjectId.make("project-a");
  const instanceId = ProviderInstanceId.make("codex_work");

  it("writes the same choice to every checkout of the project", () => {
    const siblingId = ProjectId.make("project-a-worktree");
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [siblingId]: { newWorktreesStartFromOrigin: true },
      },
    };

    const patch = decodeSettingsPatch({
      projectSettingsOverrides: buildProviderInstanceOverridePatch(
        settings,
        [projectId, siblingId],
        instanceId,
        false,
      ),
    });
    const result = applyServerSettingsPatch(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: true,
        projectSettingsOverrides: {
          ...settings.projectSettingsOverrides,
          [siblingId]: { newWorktreesStartFromOrigin: false, defaultAutoPull: true },
        },
      },
      patch,
    );
    expect(
      result.projectSettingsOverrides[projectId]?.providerInstances?.[instanceId]?.enabled,
    ).toBe(false);
    expect(result.projectSettingsOverrides[siblingId]).toEqual({
      newWorktreesStartFromOrigin: false,
      defaultAutoPull: true,
      providerInstances: { [instanceId]: { enabled: false } },
    });
  });

  it.each([false, true])(
    "resets only the provider override while other settings are present: %s",
    (withOtherSettings) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: true,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("neopi"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: {
            ...(withOtherSettings ? { newWorktreesStartFromOrigin: true } : {}),
            providerInstances: { [instanceId]: { enabled: false } },
          },
        },
      };
      const patch = decodeSettingsPatch({
        projectSettingsOverrides: buildProviderInstanceOverridePatch(
          settings,
          [projectId],
          instanceId,
          undefined,
        ),
      });
      const result = applyServerSettingsPatch(settings, patch);
      expect(resolveProjectProviderInstanceEnabled(result, projectId, instanceId)).toBe(true);
      if (withOtherSettings) {
        expect(result.projectSettingsOverrides[projectId]?.newWorktreesStartFromOrigin).toBe(true);
      }
    },
  );
});

describe("remote operate access", () => {
  it("does not treat the old orchestration grant as provider management", () => {
    expect(
      resolveRemoteOperateAccess({
        session: {
          authenticated: true,
          scopes: ["orchestration:operate"],
          auth: { serverUpdateScope: "environment:maintain" },
        },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("accepts the orchestration grant from a server that predates providers:manage", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
  });
  it("derives access from the environment session's granted scopes", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthProvidersManageScope] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });
});
