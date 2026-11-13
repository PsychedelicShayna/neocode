import { workspaceKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
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
    onCloseTerminal: (id: string) => void;
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
function setup() {
  vi.clearAllMocks();
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  useTerminalUiStateStore
    .getState()
    .ensureTerminal(target, terminalId, { open: true, active: true });
}

describe("native terminal close receipt", () => {
  it.each(["drawer", "panel"] as const)(
    "retains a pending or failed %s close and removes it only after a successful retry",
    async (mode) => {
      setup();
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
      await using screen = await render(
        <NativeSessionTerminal
          target={target}
          cwd="/workspace"
          mode={mode}
          keybindings={[]}
          {...(surface ? { surface } : {})}
        />,
      );
      await screen.getByRole("button", { name: `Close ${terminalId}` }).click();
      expect(terminalUi().terminalIds).toContain(terminalId);
      expect(suppressedIds()).not.toContain(terminalId);
      if (surface) expect(panelUi().surfaces).toContainEqual(surface);
      await act(() => resolveClose({ _tag: "Failure" }));
      expect(terminalUi().terminalIds).toContain(terminalId);
      expect(suppressedIds()).not.toContain(terminalId);
      if (surface) expect(panelUi().surfaces).toContainEqual(surface);
      commands.close.mockResolvedValueOnce({ _tag: "Success" });
      await screen.getByRole("button", { name: `Close ${terminalId}` }).click();
      expect(terminalUi().terminalIds).not.toContain(terminalId);
      expect(suppressedIds()).toContain(terminalId);
      if (surface) expect(panelUi().surfaces).not.toContainEqual(surface);
    },
  );
  it.each(["drawer", "panel"] as const)(
    "lazily mounts a %s once and retains its viewport until the native workspace changes",
    async (mode) => {
      setup();
      if (mode === "panel") useRightPanelStore.getState().openTerminal(target, terminalId);
      const surface =
        mode === "panel" ? panelUi().surfaces.find((item) => item.kind === "terminal") : undefined;
      const panel = (visible: boolean, currentTarget = target) => (
        <NativeSessionTerminal
          target={currentTarget}
          cwd="/workspace"
          visible={visible}
          mode={mode}
          keybindings={[]}
          {...(surface ? { surface } : {})}
        />
      );
      await using screen = await render(panel(false));
      expect(screen.container.querySelector("button")).toBeNull();
      expect(terminalUi().terminalOpen).toBe(mode === "panel");
      await screen.rerender(panel(true));
      await expect
        .element(screen.getByRole("button", { name: `Close ${terminalId}` }))
        .toBeVisible();
      const viewportButton = screen.container.querySelector("button");
      await screen.rerender(panel(false));
      expect(screen.container.querySelector("button")).toBe(viewportButton);
      expect(terminalUi().terminalOpen).toBe(mode === "panel");
      await screen.rerender(panel(true));
      expect(screen.container.querySelector("button")).toBe(viewportButton);
      expect(terminalUi().terminalOpen).toBe(true);
      await screen.rerender(
        panel(false, {
          ...target,
          ref: { ...target.ref, sessionFile: "/sessions/another-native-workspace.jsonl" },
        }),
      );
      expect(screen.container.querySelector("button")).toBeNull();
      expect(viewportButton?.isConnected).toBe(false);
    },
  );
});
