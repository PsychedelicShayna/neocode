// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TERMINAL_INPUT_CLASS_NAME } from "~/lib/terminalFocus";
import { ComposerStashMenu } from "./ComposerStashMenu";

describe("ComposerStashMenu with a focused terminal", () => {
  let container: HTMLDivElement;
  let root: Root;
  let terminalInput: HTMLTextAreaElement;
  const onClose = vi.fn();
  const onRestore = vi.fn();
  const onDelete = vi.fn();

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    terminalInput = document.createElement("textarea");
    terminalInput.className = TERMINAL_INPUT_CLASS_NAME;
    terminal.append(terminalInput);
    container = document.createElement("div");
    document.body.append(terminal, container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <ComposerStashMenu
          entries={[
            {
              id: "stash-1",
              createdAt: new Date(0).toISOString(),
              prompt: "Saved prompt",
              attachments: [],
              droppedImageNames: [],
              unreadableImageNames: [],
              pendingImageCount: 0,
            },
          ]}
          stashShortcutLabel="Ctrl+S"
          onRestore={onRestore}
          onDelete={onDelete}
          onClose={onClose}
        />,
      ),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function press(target: EventTarget, init: KeyboardEventInit) {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it("leaves every key to the terminal", () => {
    terminalInput.focus();
    for (const init of [
      { key: "ArrowDown" },
      { key: "ArrowUp" },
      { key: "Enter" },
      { key: "Backspace", ctrlKey: true },
      { key: "Escape" },
    ]) {
      expect(press(terminalInput, init).defaultPrevented, init.key).toBe(false);
    }
    expect(onClose).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("still closes on Escape once focus leaves the terminal", () => {
    terminalInput.focus();
    terminalInput.blur();
    expect(press(document.body, { key: "Escape" }).defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
