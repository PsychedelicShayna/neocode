// @vitest-environment jsdom

import { workspaceResourceId } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getLastFocusedTerminal } from "~/lib/terminalFocus";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";
import { closeNativeTerminal } from "./closeNativeTerminal";
import { NativeSessionTerminal, type NativeSessionTerminalHandle } from "./NativeSessionTerminal";

const fixture = vi.hoisted(() => ({
  close: vi.fn<() => Promise<{ _tag: "Success" | "Failure" }>>(),
  confirm: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("~/state/terminal", () => ({
  terminalEnvironment: { open: "open", close: "close" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "close" ? fixture.close : vi.fn()),
}));
vi.mock("~/state/terminalSessions", () => ({ useKnownTerminalSessions: () => [] }));
vi.mock("~/lib/terminalCloseConfirm", () => ({ confirmTerminalClose: fixture.confirm }));
vi.mock("../ThreadTerminalDrawer", () => ({ default: () => null }));

const target = {
  environmentId: EnvironmentId.make("focus-record-environment"),
  ref: {
    providerInstanceId: ProviderInstanceId.make("neopi"),
    sessionFile: "/sessions/focus-record.jsonl",
  },
};
const threadId = workspaceResourceId(target);
const terminalId = "terminal-1";
const record = { environmentId: target.environmentId, threadId, terminalId };

/** Gives the terminal focus the way its viewport does, then moves focus elsewhere. */
function focusTerminalThenLeave() {
  const viewport = document.createElement("div");
  viewport.dataset.terminalId = terminalId;
  viewport.dataset.terminalThreadId = threadId;
  viewport.dataset.terminalEnvironmentId = target.environmentId;
  const input = document.createElement("textarea");
  viewport.append(input);
  const elsewhere = document.createElement("input");
  document.body.append(viewport, elsewhere);
  input.focus();
  elsewhere.focus();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  useTerminalUiStateStore
    .getState()
    .ensureTerminal(target, terminalId, { open: true, active: true });
  focusTerminalThenLeave();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("the last-focused terminal record", () => {
  describe("closed from the drawer's controller, as :q does", () => {
    let root: Root;
    const controller = createRef<NativeSessionTerminalHandle>();

    beforeEach(async () => {
      root = createRoot(document.createElement("div"));
      await act(async () =>
        root.render(
          <NativeSessionTerminal target={target} cwd="/workspace" controllerRef={controller} />,
        ),
      );
    });

    afterEach(async () => {
      await act(async () => root.unmount());
    });

    it("survives a cancelled confirmation", async () => {
      fixture.confirm.mockResolvedValue(false);
      await act(async () => controller.current?.closeTerminal(terminalId));
      expect(fixture.close).not.toHaveBeenCalled();
      expect(getLastFocusedTerminal()).toEqual(record);
    });

    it("survives a failed close and dies with a successful one", async () => {
      fixture.confirm.mockResolvedValue(true);
      fixture.close.mockResolvedValueOnce({ _tag: "Failure" });
      await act(async () => controller.current?.closeTerminal(terminalId));
      expect(getLastFocusedTerminal()).toEqual(record);

      fixture.close.mockResolvedValueOnce({ _tag: "Success" });
      await act(async () => controller.current?.closeTerminal(terminalId));
      expect(getLastFocusedTerminal()).toBeNull();
    });
  });

  it("dies with a right-panel tab's terminal, which closes through the same helper", async () => {
    useRightPanelStore.getState().openTerminal(target, terminalId);
    const surfaceId =
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, target).surfaces.find(
        (surface) => surface.kind === "terminal",
      )?.id ?? null;
    expect(surfaceId).not.toBeNull();
    await closeNativeTerminal({
      close: async () => ({ _tag: "Failure" }),
      target,
      threadId,
      terminalId,
      surfaceId,
    });
    expect(getLastFocusedTerminal()).toEqual(record);

    await closeNativeTerminal({
      close: async () => ({ _tag: "Success" }),
      target,
      threadId,
      terminalId,
      surfaceId,
    });
    expect(getLastFocusedTerminal()).toBeNull();
  });

  it("ignores the close of a different terminal", async () => {
    await closeNativeTerminal({
      close: async () => ({ _tag: "Success" }),
      target,
      threadId,
      terminalId: "terminal-9",
      surfaceId: null,
    });
    expect(getLastFocusedTerminal()).toEqual(record);
  });
});
