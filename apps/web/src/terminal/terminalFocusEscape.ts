import { shortcutKeyFromEvent } from "../keybindings";
import { isTerminalCompositionKey } from "./ghostty/surface";

/** The byte Ctrl+Backslash sends to a program in the legacy keyboard encoding. */
export const TERMINAL_FOCUS_ESCAPE_BYTE = "\u001c";

export type TerminalFocusEscapeKey = Pick<
  KeyboardEvent,
  | "key"
  | "code"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey"
  | "repeat"
  | "isComposing"
  | "keyCode"
>;

/**
 * What the terminal does with one keydown:
 * - `pass`: encode it for the program as usual.
 * - `hold`: swallow it; the first Ctrl+Backslash waits for the next key.
 * - `escape`: swallow it and move focus out of the terminal.
 * - `flush`: send the held Ctrl+Backslash first, then encode this key as usual.
 */
export type TerminalFocusEscapeAction = "pass" | "hold" | "escape" | "flush";

const MODIFIER_KEYS: Readonly<Record<string, true>> = {
  Control: true,
  Shift: true,
  Alt: true,
  Meta: true,
  AltGraph: true,
};

function isEscapeChord(event: TerminalFocusEscapeKey): boolean {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    shortcutKeyFromEvent(event) === "\\"
  );
}

/**
 * Ctrl+Backslash pressed twice leaves a focused terminal, as Neovim's terminal
 * mode leaves on Ctrl+Backslash followed by a second key. There is no timeout:
 * the held press waits for the next key, and any other key sends it to the
 * program ahead of that key. Call `reset` when the terminal loses focus.
 */
export function createTerminalFocusEscape() {
  let holding = false;
  return {
    handleKey(event: TerminalFocusEscapeKey): TerminalFocusEscapeAction {
      if (!holding) {
        if (!isEscapeChord(event)) return "pass";
        holding = true;
        return "hold";
      }
      if (MODIFIER_KEYS[event.key] || isTerminalCompositionKey(event, false)) return "pass";
      if (isEscapeChord(event)) {
        // Holding the chord down must not leave the terminal by auto-repeat.
        if (event.repeat) return "hold";
        holding = false;
        return "escape";
      }
      holding = false;
      return "flush";
    },
    reset(): void {
      holding = false;
    },
  };
}
