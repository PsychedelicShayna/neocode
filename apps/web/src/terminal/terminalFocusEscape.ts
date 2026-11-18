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
  | "preventDefault"
  | "stopPropagation"
>;

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
 * the first press is held until the next key.
 *
 * Every byte of user input bound for the program must go through `send`, so
 * a held press goes out ahead of anything else the user enters (keys, IME
 * commits, AltGr text, pastes) and the next Ctrl+Backslash starts over. The
 * terminal's own replies to program queries must bypass it: they are not the
 * user's next key and must not release the hold. `beforeKey`
 * runs first on each keydown and returns false for a key it consumed. Call
 * `reset` when the terminal loses focus: a held press is then dropped unsent.
 */
export function createTerminalFocusEscape({
  write,
  leave,
}: {
  readonly write: (data: string) => void;
  readonly leave: () => void;
}) {
  let holding = false;
  const send = (data: string) => {
    const output = holding ? TERMINAL_FOCUS_ESCAPE_BYTE + data : data;
    holding = false;
    if (output.length > 0) write(output);
  };
  const consume = (event: TerminalFocusEscapeKey) => {
    event.preventDefault();
    event.stopPropagation();
    return false;
  };
  return {
    send,
    beforeKey(event: TerminalFocusEscapeKey): boolean {
      if (!holding) {
        // A repeat is an ordinary key: only a fresh press can start the escape.
        if (event.repeat || !isEscapeChord(event)) return true;
        holding = true;
        return consume(event);
      }
      if (MODIFIER_KEYS[event.key] || isTerminalCompositionKey(event, false)) return true;
      if (isEscapeChord(event)) {
        // Holding the chord down must not leave the terminal by auto-repeat.
        if (event.repeat) return consume(event);
        holding = false;
        leave();
        return consume(event);
      }
      // Any other key releases the held press ahead of itself, even a key the
      // terminal then encodes as nothing.
      send("");
      return true;
    },
    reset(): void {
      holding = false;
    },
  };
}
