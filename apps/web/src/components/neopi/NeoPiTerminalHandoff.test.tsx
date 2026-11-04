// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NeoPiTerminalHandoff } from "./NeoPiTerminalHandoff";
import { TooltipProvider } from "../ui/tooltip";

const boundary = vi.hoisted(() => ({
  handoff: vi.fn(),
  copy: vi.fn(),
  select: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../state/neopiNativeSessions", () => ({
  nativeSessionAtoms: { handoff: {} },
  selectNativeSession: boundary.select,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => boundary.handoff }));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: boundary.copy }));
vi.mock("../ui/toast", () => ({ toastManager: { add: boundary.toast } }));

const target = {
  environmentId: EnvironmentId.make("remote"),
  ref: {
    providerInstanceId: ProviderInstanceId.make("neopi-work"),
    sessionFile: "/native/a session.jsonl",
  },
};
const result = {
  sessionFile: target.ref.sessionFile,
  sessionId: "native-session",
  cwd: "/workspace/project",
  command: "cd '/workspace/project' && npi --session '/native/a session.jsonl'",
};
let root: Root;
let container: HTMLDivElement;
async function render(connected = true) {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <NeoPiTerminalHandoff target={target} connected={connected} />
      </TooltipProvider>,
    );
  });
  return container.querySelector<HTMLButtonElement>('button[aria-label="Continue in terminal"]')!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  boundary.handoff.mockResolvedValue({ _tag: "Success", value: result });
  boundary.copy.mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("native terminal handoff", () => {
  it("releases the selected native file, copies the server command, then returns to selection", async () => {
    const button = await render();
    await act(async () => button.click());
    expect(boundary.handoff).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { ref: target.ref },
    });
    expect(boundary.copy).toHaveBeenCalledExactlyOnceWith(result.command, "NeoPi terminal command");
    expect(boundary.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        description: result.command,
      }),
    );
    expect(boundary.select).toHaveBeenCalledExactlyOnceWith(null);
    expect(boundary.copy.mock.invocationCallOrder[0]).toBeLessThan(
      boundary.select.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the released command available and leaves the workspace even if clipboard access fails", async () => {
    boundary.copy.mockRejectedValue(new Error("Clipboard denied"));
    const button = await render();
    await act(async () => button.click());
    expect(boundary.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        description: result.command,
        timeout: 0,
      }),
    );
    expect(boundary.select).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("keeps the current session selected and reports a native failure without copying a command", async () => {
    boundary.handoff.mockRejectedValue(new Error("The native owner changed"));
    const button = await render();
    await act(async () => button.click());
    expect(boundary.select).not.toHaveBeenCalled();
    expect(boundary.copy).not.toHaveBeenCalled();
    expect(boundary.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: "The native owner changed",
      }),
    );
    expect(button.disabled).toBe(false);
  });

  it("does not hand off a disconnected session", async () => {
    const button = await render(false);
    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    expect(boundary.handoff).not.toHaveBeenCalled();
    expect(boundary.select).not.toHaveBeenCalled();
  });
});
