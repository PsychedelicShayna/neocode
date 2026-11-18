// @vitest-environment jsdom

import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useCommandHandlers } from "~/commandTable";
import { EX_LINE_INPUT_ATTRIBUTE, guardHeldKey } from "~/lib/exLineFocus";
import { useNativeWorkspaceKeys } from "./useNativeWorkspaceKeys";

const keybindings = compileResolvedKeybindingsConfig([
  { key: "ctrl+j", command: "terminal.toggle" },
  { key: "arrowdown", command: "sessionTab.next" },
  { key: "tab b", command: "thread.stop" },
  { key: "enter", command: "rightPanel.toggle" },
]);

const toggle = vi.fn();
const next = vi.fn();
const stop = vi.fn();
const panel = vi.fn();

function Workspace() {
  useCommandHandlers("workspace", {
    "terminal.toggle": { label: "Toggle terminal", available: () => true, run: toggle },
    "sessionTab.next": { label: "Next session", available: () => true, run: next },
    "thread.stop": { label: "Stop", available: () => true, run: stop },
    // Runs on auto-repeat, so a repeat that got through would show.
    "rightPanel.toggle": {
      label: "Toggle panel",
      available: () => true,
      run: panel,
      repeat: true,
    },
  });
  useNativeWorkspaceKeys(keybindings, () => ({
    terminalOpen: false,
    previewOpen: false,
    modelPickerOpen: false,
  }));
  return null;
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("native workspace keybindings", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("navigator", { ...navigator, platform: "Linux x86_64" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Workspace />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("runs the workspace's handler for a bound key and takes the key", () => {
    const event = press(document.body, "j", { ctrlKey: true });
    expect(toggle).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  function focusExLine() {
    const input = document.createElement("input");
    input.setAttribute(EX_LINE_INPUT_ATTRIBUTE, "");
    document.body.append(input);
    input.focus();
    return input;
  }

  it("resolves no unmodified key typed in the Ex line, but still a modified chord", () => {
    const input = focusExLine();
    const down = press(input, "ArrowDown");
    expect(down.defaultPrevented).toBe(false);
    expect(next).not.toHaveBeenCalled();

    press(input, "j", { ctrlKey: true });
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("neither begins nor completes a two-key sequence from the Ex line", () => {
    const input = focusExLine();
    const tab = press(input, "Tab");
    press(input, "b");
    expect(tab.defaultPrevented).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it("ignores the held repeats of the key that closed the Ex line until it is released", () => {
    guardHeldKey("Enter");
    press(document.body, "Enter", { repeat: true });
    press(document.body, "Enter", { repeat: true });
    expect(panel).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
    press(document.body, "Enter");
    expect(panel).toHaveBeenCalledOnce();
  });
});
