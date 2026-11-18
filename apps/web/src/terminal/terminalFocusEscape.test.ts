import { describe, expect, it } from "vite-plus/test";

import {
  createTerminalFocusEscape,
  TERMINAL_FOCUS_ESCAPE_BYTE,
  type TerminalFocusEscapeKey,
} from "./terminalFocusEscape";

function key(overrides: Partial<TerminalFocusEscapeKey> = {}): TerminalFocusEscapeKey {
  return {
    key: "x",
    code: "KeyX",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 88,
    preventDefault() {},
    stopPropagation() {},
    ...overrides,
  };
}

const ctrlBackslash = (overrides: Partial<TerminalFocusEscapeKey> = {}) =>
  key({ key: "\\", code: "Backslash", ctrlKey: true, keyCode: 220, ...overrides });

// Plays keydowns the way the surface does: a text key the escape passes on is
// encoded and sent through `send`, here as its `key`; modifier-only and IME
// keydowns encode to nothing.
function play(keys: ReadonlyArray<TerminalFocusEscapeKey>, blurBefore?: number) {
  const program: string[] = [];
  let left = 0;
  const escape = createTerminalFocusEscape({
    write: (data) => program.push(data),
    leave: () => {
      left += 1;
    },
  });
  keys.forEach((event, index) => {
    if (index === blurBefore) escape.reset();
    if (escape.beforeKey(event) && event.key.length === 1) escape.send(event.key);
  });
  return { program, left };
}

describe("terminal focus escape", () => {
  it("leaves the terminal on Ctrl+Backslash pressed twice without sending anything", () => {
    expect(play([ctrlBackslash(), ctrlBackslash()])).toEqual({ program: [], left: 1 });
  });

  it("forwards a single Ctrl+Backslash ahead of the next key", () => {
    expect(play([ctrlBackslash(), key(), key({ key: "y", code: "KeyY" })])).toEqual({
      program: [TERMINAL_FOCUS_ESCAPE_BYTE, "x", "y"],
      left: 0,
    });
  });

  it("does not leave on auto-repeat of the held chord", () => {
    expect(play([ctrlBackslash(), ctrlBackslash({ repeat: true })]).left).toBe(0);
    expect(play([ctrlBackslash(), ctrlBackslash({ repeat: true }), ctrlBackslash()]).left).toBe(1);
  });

  it("does not start the escape on a repeat when nothing is held", () => {
    // Held across a refocus, the chord's repeats reach the program as keys;
    // one later fresh press is only a first press.
    expect(play([ctrlBackslash({ repeat: true }), ctrlBackslash()])).toEqual({
      program: ["\\"],
      left: 0,
    });
  });

  it("drops the held press on blur", () => {
    expect(play([ctrlBackslash(), key()], 1)).toEqual({ program: ["x"], left: 0 });
  });

  it("keeps holding across modifier presses and IME keydowns", () => {
    const control = key({ key: "Control", code: "ControlLeft", ctrlKey: true, keyCode: 17 });
    const composing = key({ key: "Process", isComposing: true, keyCode: 229 });
    expect(play([ctrlBackslash(), control, composing, ctrlBackslash()])).toEqual({
      program: [],
      left: 1,
    });
  });

  it("treats Ctrl+Shift+Backslash as an ordinary key", () => {
    expect(play([ctrlBackslash({ key: "|", shiftKey: true }), ctrlBackslash()])).toEqual({
      program: ["|"],
      left: 0,
    });
  });
});
