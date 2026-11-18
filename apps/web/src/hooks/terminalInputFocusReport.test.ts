// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { TERMINAL_INPUT_CLASS_NAME } from "../lib/terminalFocus";
import { startTerminalInputFocusReport } from "./useTerminalFocus";

function mountTerminal() {
  const owner = document.createElement("div");
  owner.dataset.terminalOwner = "drawer";
  const input = document.createElement("textarea");
  input.className = TERMINAL_INPUT_CLASS_NAME;
  const toolbarButton = document.createElement("button");
  owner.append(input, toolbarButton);
  const composer = document.createElement("textarea");
  document.body.append(owner, composer);
  return { owner, input, toolbarButton, composer };
}

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.replaceChildren();
});

function start() {
  const sent: boolean[] = [];
  stop = startTerminalInputFocusReport((focused) => sent.push(focused));
  return sent;
}

describe("startTerminalInputFocusReport", () => {
  it("reports only the terminal's own input, and only changes", () => {
    const { input, toolbarButton, composer } = mountTerminal();
    const sent = start();
    expect(sent).toEqual([]);

    input.focus();
    expect(sent).toEqual([true]);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(sent).toEqual([true]);

    // The terminal's toolbar is GUI, not the program's input.
    toolbarButton.focus();
    expect(sent).toEqual([true, false]);
    input.focus();
    composer.focus();
    expect(sent).toEqual([true, false, true, false]);
  });

  it("reports false while the window is in the background and re-checks on return", () => {
    const { input } = mountTerminal();
    const sent = start();
    input.focus();

    window.dispatchEvent(new FocusEvent("blur"));
    expect(sent).toEqual([true, false]);
    window.dispatchEvent(new FocusEvent("focus"));
    expect(sent).toEqual([true, false, true]);
  });

  it("does not report a terminal removed while the window was in the background", () => {
    const { owner, input } = mountTerminal();
    const sent = start();
    input.focus();
    window.dispatchEvent(new FocusEvent("blur"));

    owner.remove();
    window.dispatchEvent(new FocusEvent("focus"));
    expect(sent).toEqual([true, false]);
  });

  it("clears a terminal removed while focused on the next key", () => {
    const { owner, input } = mountTerminal();
    const sent = start();
    input.focus();

    owner.remove();
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(sent).toEqual([true, false]);
  });

  it("reports false when stopped with a terminal focused", () => {
    const { input } = mountTerminal();
    const sent = start();
    input.focus();
    stop?.();
    stop = undefined;
    expect(sent).toEqual([true, false]);
  });
});
