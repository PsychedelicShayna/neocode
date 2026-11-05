import { workspaceKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";
import { NativeSessionTerminal } from "./NativeSessionTerminal";

const commands = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn<() => Promise<{ _tag: "Success" | "Failure" }>>(),
  write: vi.fn(),
}));

vi.mock("~/state/terminal", () => ({
  terminalEnvironment: { open: "open", close: "close", write: "write" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof commands) => commands[command],
}));
vi.mock("~/state/terminalSessions", () => ({ useKnownTerminalSessions: () => [] }));
vi.mock("~/lib/terminalCloseConfirm", () => ({ confirmTerminalClose: async () => true }));
vi.mock("../ThreadTerminalDrawer", () => ({
  default: ({
    terminalIds,
    onCloseTerminal,
  }: {
    terminalIds: string[];
    onCloseTerminal: (terminalId: string) => void;
  }) => (
    <div>
      {terminalIds.map((id) => (
        <button key={id} aria-label={`Close ${id}`} onClick={() => onCloseTerminal(id)}>
          {id}
        </button>
      ))}
    </div>
  ),
}));

const target = {
  environmentId: EnvironmentId.make("terminal-test-environment"),
  ref: {
    providerInstanceId: ProviderInstanceId.make("neopi"),
    sessionFile: "/sessions/terminal-test.jsonl",
  },
};
const terminalId = "terminal-1";
const terminalUi = () =>
  selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    target,
  );
const panelUi = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, target);
const suppressedIds = () =>
  useTerminalUiStateStore.getState().suppressedTerminalIdsByThreadKey[workspaceKey(target)] ?? [];

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
});

afterEach(() => vi.unstubAllGlobals());

describe("native terminal close receipt", () => {
  it.each(["drawer", "panel"] as const)(
    "retains a pending or failed %s close and removes it only after a successful retry",
    async (mode) => {
      if (mode === "panel") useRightPanelStore.getState().openTerminal(target, terminalId);
      const surface =
        mode === "panel" ? panelUi().surfaces.find((item) => item.kind === "terminal") : undefined;
      let resolveClose!: (result: { _tag: "Success" | "Failure" }) => void;
      commands.close.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveClose = resolve;
          }),
      );
      const renderer = await act(() =>
        create(
          <NativeSessionTerminal
            target={target}
            cwd="/workspace"
            mode={mode}
            keybindings={[]}
            {...(surface ? { surface } : {})}
          />,
        ),
      );
      try {
        const close = () =>
          renderer.root.findByProps({ "aria-label": `Close ${terminalId}` }).props.onClick();
        await act(close);
        expect(terminalUi().terminalIds).toContain(terminalId);
        expect(suppressedIds()).not.toContain(terminalId);
        if (surface) expect(panelUi().surfaces).toContainEqual(surface);

        await act(() => resolveClose({ _tag: "Failure" }));
        expect(terminalUi().terminalIds).toContain(terminalId);
        expect(suppressedIds()).not.toContain(terminalId);
        if (surface) expect(panelUi().surfaces).toContainEqual(surface);
        expect(commands.write).not.toHaveBeenCalled();

        commands.close.mockResolvedValueOnce({ _tag: "Success" });
        await act(close);
        expect(commands.close).toHaveBeenCalledTimes(2);
        expect(terminalUi().terminalIds).not.toContain(terminalId);
        expect(suppressedIds()).toContain(terminalId);
        if (surface) expect(panelUi().surfaces).not.toContainEqual(surface);
        expect(commands.write).not.toHaveBeenCalled();
      } finally {
        await act(() => renderer.unmount());
      }
    },
  );
});
