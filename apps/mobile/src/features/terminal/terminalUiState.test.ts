import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { workspaceResourceId } from "@t3tools/client-runtime/environment";

import { cacheTerminalGridSize, getCachedTerminalGridSize } from "./terminalUiState";

describe("terminalUiState", () => {
  it("does not reuse a native grid across environments, provider profiles or session files", () => {
    const workspace = {
      environmentId: EnvironmentId.make("native-grid-isolation"),
      ref: {
        providerInstanceId: ProviderInstanceId.make("neopi-a"),
        sessionFile: "/sessions/native.jsonl",
      },
    };
    const target = {
      environmentId: workspace.environmentId,
      threadId: workspaceResourceId(workspace),
      terminalId: "default",
    };
    const others = [
      { ...workspace, environmentId: EnvironmentId.make("env-other") },
      {
        ...workspace,
        ref: { ...workspace.ref, providerInstanceId: ProviderInstanceId.make("neopi-b") },
      },
      { ...workspace, ref: { ...workspace.ref, sessionFile: "/sessions/other.jsonl" } },
    ];
    cacheTerminalGridSize(target, { cols: 120, rows: 40 });
    for (const other of others) {
      expect(
        getCachedTerminalGridSize({
          environmentId: other.environmentId,
          threadId: workspaceResourceId(other),
          terminalId: "default",
        }),
      ).toBeNull();
    }
    expect(getCachedTerminalGridSize(target)).toEqual({ cols: 120, rows: 40 });
  });
});
