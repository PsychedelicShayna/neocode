import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { previewRuntimeTabId } from "./previewRuntimeTabId";

describe("previewRuntimeTabId", () => {
  it("does not reuse another renderer's native webview identity", async () => {
    const ref = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };
    const firstWindowId = previewRuntimeTabId(ref, "epoch-a", "tab_1");
    vi.resetModules();
    const secondWindow = await import("./previewRuntimeTabId");
    expect(secondWindow.previewRuntimeTabId(ref, "epoch-a", "tab_1")).not.toBe(firstWindowId);
  });

  it("scopes process-local tab ids to their environment, thread, and server epoch", () => {
    const base = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };

    expect(previewRuntimeTabId(base, "epoch-a", "tab_1")).not.toBe(
      previewRuntimeTabId(
        { ...base, environmentId: EnvironmentId.make("environment-b") },
        "epoch-a",
        "tab_1",
      ),
    );
    expect(previewRuntimeTabId(base, "epoch-a", "tab_1")).not.toBe(
      previewRuntimeTabId({ ...base, threadId: ThreadId.make("thread-b") }, "epoch-a", "tab_1"),
    );
    expect(previewRuntimeTabId(base, "epoch-a", "tab_1")).not.toBe(
      previewRuntimeTabId(base, "epoch-b", "tab_1"),
    );
  });
});

describe("native preview runtime ownership", () => {
  it("isolates identical tab ids across canonical sessions, providers and environments", () => {
    const target = {
      environmentId: EnvironmentId.make("native-environment"),
      ref: {
        providerInstanceId: ProviderInstanceId.make("profile-a"),
        sessionFile: "/sessions/a session.jsonl",
      },
    };
    const runtimeId = previewRuntimeTabId(target, "epoch", "tab_1");
    const others = [
      { ...target, environmentId: EnvironmentId.make("other-environment") },
      {
        ...target,
        ref: { ...target.ref, providerInstanceId: ProviderInstanceId.make("profile-b") },
      },
      { ...target, ref: { ...target.ref, sessionFile: "/sessions/b.jsonl" } },
    ];
    for (const other of others) {
      expect(previewRuntimeTabId(other, "epoch", "tab_1")).not.toBe(runtimeId);
    }
    expect(runtimeId).not.toContain(target.ref.sessionFile);
  });
});
