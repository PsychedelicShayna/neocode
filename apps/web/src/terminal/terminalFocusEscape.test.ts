import type { KeybindingRule } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { terminalKeybindingRules, type TerminalKeybindingCommand } from "../keybindings";
import { createTerminalFocusEscape, type TerminalFocusEscapeKey } from "./terminalFocusEscape";

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
const ctrl = (letter: string, overrides: Partial<TerminalFocusEscapeKey> = {}) =>
  key({ key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true, ...overrides });
const ctrlEqual = (overrides: Partial<TerminalFocusEscapeKey> = {}) =>
  key({ key: "=", code: "Equal", ctrlKey: true, keyCode: 187, ...overrides });

// What the terminal's encoder would write for a held key, legacy encoding.
function encode(event: TerminalFocusEscapeKey): string {
  if (!event.ctrlKey) return event.key;
  return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
}

// Plays keydowns the way the surface does: a text key the escape passes on is
// encoded and sent through `send`, here as its `key`; modifier-only and IME
// keydowns encode to nothing.
function play(
  keys: ReadonlyArray<TerminalFocusEscapeKey>,
  options: { readonly custom?: ReadonlyArray<KeybindingRule>; readonly blurBefore?: number } = {},
) {
  const keybindings = options.custom
    ? mergeWithDefaultKeybindings(compileResolvedKeybindingsConfig(options.custom))
    : DEFAULT_RESOLVED_KEYBINDINGS;
  const program: string[] = [];
  const ran: TerminalKeybindingCommand[] = [];
  const escape = createTerminalFocusEscape({
    write: (data) => program.push(data),
    encode,
    rules: () => terminalKeybindingRules(keybindings),
    run: (command) => ran.push(command),
  });
  keys.forEach((event, index) => {
    if (index === options.blurBefore) escape.reset();
    if (escape.beforeKey(event) && event.key.length === 1) escape.send(event.key);
  });
  return { program, ran };
}

describe("terminal focus escape", () => {
  it("leaves the terminal on Ctrl+Backslash pressed twice without sending anything", () => {
    expect(play([ctrlBackslash(), ctrlBackslash()])).toEqual({
      program: [],
      ran: ["terminal.leaveFocus"],
    });
  });

  it("forwards a single Ctrl+Backslash ahead of the next key", () => {
    expect(play([ctrlBackslash(), key(), key({ key: "y", code: "KeyY" })])).toEqual({
      program: ["\u001c", "x", "y"],
      ran: [],
    });
  });

  it("does not leave on auto-repeat of the held chord", () => {
    expect(play([ctrlBackslash(), ctrlBackslash({ repeat: true })]).ran).toEqual([]);
    expect(play([ctrlBackslash(), ctrlBackslash({ repeat: true }), ctrlBackslash()]).ran).toEqual([
      "terminal.leaveFocus",
    ]);
  });

  it("does not start the escape on a repeat when nothing is held", () => {
    // Held across a refocus, the chord's repeats reach the program as keys;
    // one later fresh press is only a first press.
    expect(play([ctrlBackslash({ repeat: true }), ctrlBackslash()])).toEqual({
      program: ["\\"],
      ran: [],
    });
  });

  it("drops the held press on blur", () => {
    expect(play([ctrlBackslash(), key()], { blurBefore: 1 })).toEqual({
      program: ["x"],
      ran: [],
    });
  });

  it("keeps holding across modifier presses and IME keydowns", () => {
    const control = key({ key: "Control", code: "ControlLeft", ctrlKey: true, keyCode: 17 });
    const composing = key({ key: "Process", isComposing: true, keyCode: 229 });
    expect(play([ctrlBackslash(), control, composing, ctrlBackslash()]).ran).toEqual([
      "terminal.leaveFocus",
    ]);
  });

  it("treats Ctrl+Shift+Backslash as an ordinary key", () => {
    expect(play([ctrlBackslash({ key: "|", shiftKey: true }), ctrlBackslash()])).toEqual({
      program: ["|"],
      ran: [],
    });
  });

  it("leaves on a rebound single chord and gives Ctrl+Backslash back to the program", () => {
    const custom = [
      { key: "ctrl+g", command: "terminal.leaveFocus", when: "terminalFocus" },
    ] satisfies ReadonlyArray<KeybindingRule>;
    expect(play([ctrlBackslash(), ctrlBackslash(), ctrl("g")], { custom })).toEqual({
      program: ["\\", "\\"],
      ran: ["terminal.leaveFocus"],
    });
    // Holding the chord down across a refocus must not leave again.
    expect(play([ctrl("g", { repeat: true })], { custom }).ran).toEqual([]);
  });

  it("holds the first chord of a rebound sequence and releases it encoded on a mismatch", () => {
    const custom = [
      { key: "ctrl+a d", command: "terminal.leaveFocus", when: "terminalFocus" },
    ] satisfies ReadonlyArray<KeybindingRule>;
    expect(play([ctrl("a"), key({ key: "d", code: "KeyD" })], { custom }).ran).toEqual([
      "terminal.leaveFocus",
    ]);
    expect(play([ctrl("a"), key()], { custom })).toEqual({ program: ["\u0001", "x"], ran: [] });
  });

  it("leaves an input method's keys alone when the escape is rebound onto one", () => {
    const custom = [
      { key: "enter", command: "terminal.leaveFocus", when: "terminalFocus" },
    ] satisfies ReadonlyArray<KeybindingRule>;
    const enter = (overrides: Partial<TerminalFocusEscapeKey> = {}) =>
      key({ key: "Enter", code: "Enter", keyCode: 13, ...overrides });
    expect(play([enter({ isComposing: true }), enter({ keyCode: 229 })], { custom }).ran).toEqual(
      [],
    );
    expect(play([enter()], { custom }).ran).toEqual(["terminal.leaveFocus"]);
  });

  it("changes the font size on the size keys, repeating while held", () => {
    expect(
      play([
        ctrlEqual(),
        ctrlEqual({ repeat: true }),
        key({ key: "-", code: "Minus", ctrlKey: true }),
      ]),
    ).toEqual({
      program: [],
      ran: [
        "terminal.fontSize.increase",
        "terminal.fontSize.increase",
        "terminal.fontSize.decrease",
      ],
    });
    expect(play([key({ key: "0", code: "Digit0", ctrlKey: true })]).ran).toEqual([
      "terminal.fontSize.reset",
    ]);
  });

  it("releases a held Ctrl+Backslash before a font size key acts", () => {
    expect(play([ctrlBackslash(), ctrlEqual()])).toEqual({
      program: ["\u001c"],
      ran: ["terminal.fontSize.increase"],
    });
  });
});
