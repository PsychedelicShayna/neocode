// @vitest-environment jsdom

import { EMPTY_TERMINAL_BUFFER_STATE } from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { runCommand } from "~/commandTable";
import { TERMINAL_INPUT_CLASS_NAME } from "~/lib/terminalFocus";
import type * as GhosttySurface from "~/terminal/ghostty/surface";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";
import { NativeSessionWorkspacePanels } from "./NativeSessionWorkspacePanels";

const media = vi.hoisted(() => ({ narrow: false }));
vi.mock("~/hooks/useMediaQuery", () => ({
  useMediaQuery: (query: string) => query === RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY && media.narrow,
}));
vi.mock("~/state/terminalSessions", () => ({
  useKnownTerminalSessions: () => [],
  useAttachedTerminalSession: () => ({
    ...EMPTY_TERMINAL_BUFFER_STATE,
    status: "running",
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("~/terminal/ghostty/surface", async (importOriginal) => ({
  ...(await importOriginal<typeof GhosttySurface>()),
  GhosttyTerminalSurface: {
    create: async (
      container: HTMLElement,
      options: GhosttySurface.GhosttyTerminalSurfaceOptions,
    ) => {
      const input = container.appendChild(document.createElement("textarea"));
      input.className = TERMINAL_INPUT_CLASS_NAME;
      input.addEventListener("keydown", (event) => options.beforeKey(event));
      return {
        focus: () => input.focus(),
        encodeKeyPressAndRelease: () => "\u001c",
        dispose: () => input.remove(),
        isAtBottom: () => true,
        fit: () => {},
        scrollToBottom: () => {},
        setTheme: () => {},
        setVisible: () => {},
      };
    },
  },
}));
vi.mock("../preview/usePreviewSession", () => ({ usePreviewSession: () => {} }));
vi.mock("./agents/NativeAgentOverlay", () => ({ NativeAgentOverlay: () => null }));
vi.mock("../RightPanelTabs", () => ({
  RightPanelTabs: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/state/neopiNativeSessions", () => ({
  useNativeSessionSelection: (select: (state: { tabs: [] }) => unknown) => select({ tabs: [] }),
  selectNativeSession: vi.fn(),
}));
vi.mock("./useNativeSessionTabPresentation", () => ({ useNativeSessionTabPresentation: vi.fn() }));

const target = {
  environmentId: EnvironmentId.make("split-focus-environment"),
  ref: {
    providerInstanceId: ProviderInstanceId.make("neopi"),
    sessionFile: "/sessions/split-focus.jsonl",
  },
};

const noop = () => {};
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  media.narrow = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", window.localStorage);
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(terminalOpen: boolean) {
  useTerminalUiStateStore.getState().setTerminalOpen(target, terminalOpen);
  await act(async () => {
    root.render(
      <NativeSessionWorkspacePanels
        target={target}
        cwd="/workspace"
        agents={[]}
        keybindings={[]}
        composerRef={createRef()}
        composerOverlayElement={null}
        workspaceMutationId={null}
        onAddTerminalContext={noop}
        onSendAnnotation={noop}
        onOpenTree={noop}
        request={async () => null}
        execute={async () => null}
        onTreeNavigated={noop}
        onOpenModels={noop}
        onInterrupt={noop}
        busy={false}
        onToggleDictation={undefined}
        dictationActive={false}
      >
        <textarea aria-label="Composer" />
      </NativeSessionWorkspacePanels>,
    );
  });
}

async function submit(command: string, key = "Enter") {
  // Use the registered command directly: the default keybinding deliberately
  // leaves Ctrl+; to the shell while terminal focus is active.
  await act(() => runCommand("exLine.open"));
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Command"]')!;
  expect(document.activeElement).toBe(input);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, command);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  });
}

it.each([
  ["split", "composer"],
  ["split", "terminal"],
  ["vsplit", "composer"],
  ["vsplit", "terminal"],
] as const)(":%s opens a new pane without moving focus from the %s", async (command, origin) => {
  await mount(origin === "terminal");
  const original = host.querySelector<HTMLElement>(
    origin === "terminal" ? "[data-terminal-id] textarea" : '[aria-label="Composer"]',
  );
  expect(original).not.toBeNull();
  original!.focus();
  await submit(command);
  expect(host.querySelectorAll("[data-terminal-id]")).toHaveLength(2);
  expect(document.activeElement).toBe(original);
});

it.each([
  ["split", "sheet"],
  ["split", "inline"],
  ["vsplit", "inline"],
] as const)(
  ":%s splits the last-focused terminal without reopening its closed %s panel",
  async (command, layout) => {
    media.narrow = layout === "sheet";
    useRightPanelStore.getState().openTerminal(target, "panel-shell");
    await mount(false);
    const panelInput = document.querySelector<HTMLTextAreaElement>(
      '[data-terminal-id="panel-shell"] textarea',
    );
    expect(panelInput).not.toBeNull();
    act(() => panelInput!.focus());
    expect(document.activeElement).toBe(panelInput);
    await act(() => runCommand("rightPanel.toggle"));
    const composer = host.querySelector<HTMLTextAreaElement>('[aria-label="Composer"]')!;
    composer.focus();
    await submit(command);
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, target);
    expect(panel.isOpen).toBe(false);
    expect(panel.surfaces).toEqual([
      expect.objectContaining({
        terminalIds: ["panel-shell", expect.any(String)],
        activeTerminalId: "panel-shell",
      }),
    ]);
    expect(document.activeElement).toBe(composer);
  },
);

it.each([
  ["split", "Enter", false, true],
  ["vsplit", "Enter", false, true],
  ["split", "Escape", false, false],
  ["split", "Enter", true, false],
] as const)(
  "after the terminal escape, :%s on %s (intervening focus: %s, returns to terminal: %s)",
  async (command, key, interveningFocus, returnsToTerminal) => {
    await mount(true);
    const terminal = host.querySelector<HTMLTextAreaElement>("[data-terminal-id] textarea")!;
    terminal.focus();
    act(() => {
      for (let i = 0; i < 2; i++) {
        terminal.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "\\",
            code: "Backslash",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    });
    expect(document.activeElement).toBe(document.body);
    if (interveningFocus) {
      const composer = host.querySelector<HTMLTextAreaElement>('[aria-label="Composer"]')!;
      composer.focus();
      composer.blur();
    }
    await submit(command, key);
    expect(host.querySelectorAll("[data-terminal-id]")).toHaveLength(key === "Escape" ? 1 : 2);
    expect(document.activeElement).toBe(returnsToTerminal ? terminal : document.body);
  },
);
