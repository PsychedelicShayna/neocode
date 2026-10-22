import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { isCurrentPreviewRuntimeTab, previewRuntimeTabId } from "./previewRuntimeTabId";

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

  it("is stable for the same runtime tab", () => {
    const ref = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };
    expect(previewRuntimeTabId(ref, null, "tab_1")).toBe(previewRuntimeTabId(ref, null, "tab_1"));
  });

  it("rejects a pinned operation target after the server epoch changes", () => {
    const ref = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };
    const runtimeTabId = previewRuntimeTabId(ref, "epoch-a", "tab_1");

    expect(isCurrentPreviewRuntimeTab(ref, "epoch-a", "tab_1", runtimeTabId)).toBe(true);
    expect(isCurrentPreviewRuntimeTab(ref, "epoch-b", "tab_1", runtimeTabId)).toBe(false);
  });
});
