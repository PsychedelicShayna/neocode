// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { registerCommand, type CommandInvocation } from "~/commandTable";
import { ExLine } from "./ExLine";

vi.mock("../../state/neopiNativeSessions", () => ({
  useNativeSessionSelection: (select: (state: { tabs: [] }) => unknown) => select({ tabs: [] }),
  selectNativeSession: vi.fn(),
}));
vi.mock("./useNativeSessionTabPresentation", () => ({
  useNativeSessionTabPresentation: () => ({ title: "", identity: { label: "" } }),
}));

function Host({ onClosed }: { onClosed: () => void }) {
  const [open, setOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  return open ? (
    <ExLine
      inputRef={inputRef}
      activePanelSurfaceIsTerminal={false}
      onClose={() => {
        setOpen(false);
        onClosed();
      }}
    />
  ) : null;
}

function key(target: EventTarget, type: "keydown" | "keyup", name: string, repeat = false) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent(type, { key: name, repeat, bubbles: true, cancelable: true }),
    );
  });
}

function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ExLine", () => {
  let root: Root;
  let composer: HTMLTextAreaElement;
  const cleanups: Array<() => void> = [];
  const onClosed = vi.fn();

  function open() {
    composer.focus();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Host onClosed={onClosed} />));
    const input = document.querySelector<HTMLInputElement>("input[aria-label='Command']");
    if (!input) throw new Error("the command line did not open");
    return input;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    composer = document.createElement("textarea");
    document.body.append(composer);
  });

  afterEach(() => {
    act(() => root.unmount());
    for (const cleanup of cleanups.splice(0)) cleanup();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("runs :split once on Enter's release, keeping held repeats out of the composer", () => {
    const run = vi.fn();
    cleanups.push(
      registerCommand("terminal.split", "workspace", {
        label: "Split terminal",
        available: () => true,
        run,
      }),
    );
    const input = open();
    expect(document.activeElement).toBe(input);
    type(input, "split");

    key(input, "keydown", "Enter");
    key(input, "keydown", "Enter", true);
    key(input, "keydown", "Enter", true);
    expect(run).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);

    key(input, "keyup", "Enter");
    expect(run).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(composer);
  });

  it("returns focus on Escape and on an empty Enter without running anything", () => {
    let input = open();
    key(input, "keydown", "Escape");
    key(input, "keyup", "Escape");
    expect(document.activeElement).toBe(composer);

    act(() => root.unmount());
    input = open();
    key(input, "keydown", "Enter");
    key(input, "keyup", "Enter");
    expect(onClosed).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(composer);
  });

  it("names the terminal focused last to :q, and stays open when none can close", () => {
    const viewport = document.createElement("div");
    viewport.dataset.terminalId = "terminal-2";
    viewport.dataset.terminalThreadId = "thread-a";
    viewport.dataset.terminalEnvironmentId = "env-a";
    const terminalInput = document.createElement("textarea");
    viewport.append(terminalInput);
    document.body.append(viewport);
    act(() => terminalInput.focus());

    let invoked: CommandInvocation | undefined;
    cleanups.push(
      registerCommand("terminal.close", "workspace", {
        label: "Close terminal",
        available: (invocation) => invocation?.terminal?.terminalId === "terminal-2",
        run: (invocation) => {
          invoked = invocation;
        },
      }),
    );
    const input = open();
    type(input, "q");
    key(input, "keydown", "Enter");
    key(input, "keyup", "Enter");
    expect(invoked?.terminal).toEqual({
      environmentId: "env-a",
      threadId: "thread-a",
      terminalId: "terminal-2",
    });

    viewport.remove();
    act(() => root.unmount());
    cleanups.splice(0).forEach((cleanup) => cleanup());
    const again = open();
    type(again, "q");
    key(again, "keydown", "Enter");
    key(again, "keyup", "Enter");
    expect(document.querySelector("[role='alert']")?.textContent).toBe("Nothing to close");
    expect(document.activeElement).toBe(again);
  });
});
