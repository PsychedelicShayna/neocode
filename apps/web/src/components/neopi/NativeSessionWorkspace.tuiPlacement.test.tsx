// @vitest-environment jsdom

import { emptyNativeSessionFeed } from "@t3tools/client-runtime/neopi-native-sessions";
import { EMPTY_TERMINAL_BUFFER_STATE } from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, MANAGED_TMUX_TERMINAL_ID, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { runCommand } from "~/commandTable";
import { useRightPanelStore } from "~/rightPanelStore";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";
import { TooltipProvider } from "../ui/tooltip";
import { NativeSessionView } from "./NativeSessionWorkspace";

const terminal = vi.hoisted(() => ({ error: null as string | null }));
const session = {
  cwd: "/workspace",
  capabilities: [],
  state: {},
};
const feed = emptyNativeSessionFeed();
const request = async () => null;
vi.mock("~/state/neopiNativeSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/neopiNativeSessions")>()),
  useNativeSession: () => ({
    feed,
    session,
    conversation: feed.conversation,
    request,
    error: null,
  }),
  useNativeSessionSlice: <A,>(_target: unknown, select: (source: typeof feed) => A) => select(feed),
}));
vi.mock("~/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("~/state/terminalSessions", () => ({
  useKnownTerminalSessions: () => [],
  useAttachedTerminalSession: (input: { terminal?: { managedTmux?: unknown } }) => {
    const error = input.terminal?.managedTmux ? terminal.error : null;
    return { ...EMPTY_TERMINAL_BUFFER_STATE, status: error ? "error" : "running", error };
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("~/terminal/ghostty/surface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/terminal/ghostty/surface")>()),
  GhosttyTerminalSurface: {
    create: async (container: HTMLElement) => {
      const input = container.appendChild(document.createElement("textarea"));
      return {
        focus: () => input.focus(),
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
vi.mock("../chat/ChatComposer", () => ({ ChatComposer: () => null }));
vi.mock("../preview/usePreviewSession", () => ({ usePreviewSession: () => {} }));
vi.mock("./agents/NativeAgentOverlay", () => ({ NativeAgentOverlay: () => null }));
vi.mock("./NativeBranchToolbar", () => ({ NativeBranchToolbar: () => null }));
vi.mock("./NativeTimelineView", () => ({
  NativeTimelineView: () => null,
  nativeTimelineKey: () => "timeline",
}));

const target = {
  environmentId: EnvironmentId.make("tui-placement-environment"),
  ref: {
    providerInstanceId: ProviderInstanceId.make("neopi"),
    sessionFile: "/sessions/tui-placement.jsonl",
  },
};
const panelContent = "[data-right-panel-surface-content]";
const managedView = '[aria-label="Managed NeoPi TUI"]';
let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  terminal.error = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => {
    root.render(
      <TooltipProvider>
        <NativeSessionView target={target} />
      </TooltipProvider>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function clickButton(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}

it("opens the managed TUI in a right-panel terminal tab, and closes it without opening the drawer", async () => {
  await clickButton("Show NeoPi TUI");
  const view = host.querySelector(managedView);
  expect(view).not.toBeNull();
  expect(view!.closest(panelContent)).not.toBeNull();
  expect(
    view!.querySelector(`[data-terminal-id="${MANAGED_TMUX_TERMINAL_ID}"] textarea`),
  ).not.toBeNull();
  await clickButton("Close NeoPi TUI");
  expect(host.querySelector(managedView)).toBeNull();
  expect(host.querySelector('[data-terminal-owner="drawer"]')).toBeNull();
});

it("shows the tmux configuration error in the same right-panel terminal tab", async () => {
  terminal.error = "no configured tmux agent ID";
  await clickButton("Show NeoPi TUI");
  const alert = host.querySelector(`${managedView} [role="alert"]`);
  expect(alert?.textContent).toBe(terminal.error);
  expect(alert!.closest(panelContent)).not.toBeNull();
});

it("opens an ordinary terminal in the drawer", async () => {
  await act(async () => runCommand("terminal.new"));
  const input = host.querySelector('[data-terminal-owner="drawer"] [data-terminal-id] textarea');
  expect(input).not.toBeNull();
  expect(input!.closest(panelContent)).toBeNull();
  expect(host.querySelector(managedView)).toBeNull();
});
