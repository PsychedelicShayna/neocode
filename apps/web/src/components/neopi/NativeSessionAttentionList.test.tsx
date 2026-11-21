// @vitest-environment jsdom

import {
  EnvironmentId,
  NeoPiNativeSessionsError,
  ProviderInstanceId,
  type NeoPiNativeSessionsListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { TooltipProvider } from "../ui/tooltip";
import { NativeEnvironmentAttentionList } from "./NativeSessionAttentionList";

const fixture = vi.hoisted(() => ({
  stopManaged: vi.fn(),
  setSettled: vi.fn(),
  refresh: vi.fn(),
  confirm: vi.fn(async () => true),
}));

vi.mock("../../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: {
      show: async (items: ReadonlyArray<{ id: string; label: string }>) =>
        items.find(({ label }) => label === "Force Stop")?.id,
    },
    dialogs: { confirm: fixture.confirm },
  }),
}));
vi.mock("../../state/neopiNativeSessions", async () => {
  // The hoisted mock factory runs before static imports are initialized.
  const { Atom } = await import("effect/unstable/reactivity");
  const activity = Atom.family(() => Atom.make(new Map()));
  return {
    nativeSessionAtoms: {
      list: () => "list",
      activity,
      setSettled: "set-settled",
      stopManaged: "stop-managed",
    },
    useNativeSessionSelection: () => null,
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "stop-managed" ? fixture.stopManaged : fixture.setSettled,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string | null) => ({
    data: query === "list" ? catalog : undefined,
    refresh: fixture.refresh,
  }),
}));

const environmentId = EnvironmentId.make("test-environment");
const ref = {
  providerInstanceId: ProviderInstanceId.make("neopi"),
  sessionFile: "/sessions/managed.jsonl",
};
const catalog = {
  sessions: [
    {
      ref,
      sessionId: "managed",
      cwd: "/project",
      title: "Managed session",
      firstMessage: "Hello",
      modifiedAt: "2026-11-20T00:00:00.000Z",
      owner: { kind: "process", pid: 123, attachable: true },
      managed: {
        imageId: "owner-image",
        liveness: "alive",
        stop: "unconfirmed",
        work: null,
        canForceStop: true,
      },
    },
  ],
  diagnostics: [],
} satisfies NeoPiNativeSessionsListResult;

it("shows why Force Stop was refused when the command resolves with a failure", async () => {
  const reason = "Could not signal the exact managed owner with a pidfd.";
  fixture.stopManaged.mockResolvedValue(
    AsyncResult.failure(
      Cause.fail(new NeoPiNativeSessionsError({ message: reason, code: "tmux_force_unconfirmed" })),
    ),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <NativeEnvironmentAttentionList environmentId={environmentId} query="" open={vi.fn()} />
        </TooltipProvider>,
      );
    });
    const row = container.querySelector('[role="button"][aria-label^="Managed session"]');
    expect(row).not.toBeNull();
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });

    expect(fixture.stopManaged).toHaveBeenCalledWith({
      environmentId,
      input: { ref, action: "force", imageId: "owner-image" },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(reason);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
