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
    ...overrides,
  };
}

const ctrlBackslash = (overrides: Partial<TerminalFocusEscapeKey> = {}) =>
  key({ key: "\\", code: "Backslash", ctrlKey: true, keyCode: 220, ...overrides });

// Plays keydowns through the escape the way the terminal does, recording what
// reaches the program and whether focus left.
function play(keys: ReadonlyArray<TerminalFocusEscapeKey>, blurBefore?: number) {
  const escape = createTerminalFocusEscape();
  const program: string[] = [];
  let escaped = false;
  keys.forEach((event, index) => {
    if (index === blurBefore) escape.reset();
    switch (escape.handleKey(event)) {
      case "escape":
        escaped = true;
        return;
      case "hold":
        return;
      case "flush":
        program.push(TERMINAL_FOCUS_ESCAPE_BYTE);
        program.push(event.key);
        return;
      case "pass":
        program.push(event.key);
        return;
    }
  });
  return { program, escaped };
}

describe("terminal focus escape", () => {
  it("leaves the terminal on Ctrl+Backslash pressed twice without sending anything", () => {
    expect(play([ctrlBackslash(), ctrlBackslash()])).toEqual({ program: [], escaped: true });
  });

  it("forwards a single Ctrl+Backslash ahead of the next key", () => {
    expect(play([ctrlBackslash(), key(), key({ key: "y", code: "KeyY" })])).toEqual({
      program: [TERMINAL_FOCUS_ESCAPE_BYTE, "x", "y"],
      escaped: false,
    });
  });

  it("does not leave on auto-repeat of the held chord", () => {
    expect(play([ctrlBackslash(), ctrlBackslash({ repeat: true })]).escaped).toBe(false);
    expect(play([ctrlBackslash(), ctrlBackslash({ repeat: true }), ctrlBackslash()]).escaped).toBe(
      true,
    );
  });

  it("drops the held press on blur", () => {
    expect(play([ctrlBackslash(), key()], 1)).toEqual({ program: ["x"], escaped: false });
  });

  it("keeps holding across modifier presses and IME keydowns", () => {
    const control = key({ key: "Control", code: "ControlLeft", ctrlKey: true, keyCode: 17 });
    const composing = key({ key: "Process", isComposing: true, keyCode: 229 });
    expect(play([ctrlBackslash(), control, composing, ctrlBackslash()]).escaped).toBe(true);
  });

  it("treats Ctrl+Shift+Backslash as an ordinary key", () => {
    expect(play([ctrlBackslash({ key: "|", shiftKey: true }), ctrlBackslash()])).toEqual({
      program: ["|"],
      escaped: false,
    });
  });
});
