import { keybindingRuleSteps } from "@t3tools/contracts";

import {
  isModifierKeyEvent,
  matchesShortcut,
  type TerminalKeybindingCommand,
  type TerminalKeybindingRule,
} from "../keybindings";
import { isTerminalCompositionKey } from "./ghostty/surface";

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

/**
 * The keys a focused terminal acts on itself: `terminal.leaveFocus`
 * (Ctrl+Backslash twice by default, as Neovim's terminal mode leaves on
 * Ctrl+Backslash followed by a second key) and the font size commands. Every
 * other key belongs to the program. `rules` is read on each keydown, so a
 * rebinding applies at once; see `terminalKeybindingRules`.
 *
 * A key that begins a two-chord rule is held until the next key, with no
 * timeout. If that key completes no rule, the held key goes to the program
 * first, as `encode` wrote it when it was pressed. `encode` must include the
 * key's release for programs that asked for releases: the surface swallows
 * the real release of a key this consumed.
 *
 * Keydowns that belong to an input method composition are never bound here,
 * so a rebinding onto a key an IME uses (Enter, Space) cannot take them.
 *
 * Every byte of user input bound for the program must go through `send`, so
 * a held key goes out ahead of anything else the user enters (keys, IME
 * commits, AltGr text, pastes) and the next press starts over. The
 * terminal's own replies to program queries must bypass it: they are not the
 * user's next key and must not release the hold. `beforeKey` runs first on
 * each keydown and returns false for a key it consumed. Call `reset` when the
 * terminal loses focus: a held key is then dropped unsent.
 */
export function createTerminalFocusEscape<Key extends TerminalFocusEscapeKey>({
  write,
  encode,
  rules,
  run,
}: {
  readonly write: (data: string) => void;
  readonly encode: (event: Key) => string;
  readonly rules: () => ReadonlyArray<TerminalKeybindingRule>;
  readonly run: (command: TerminalKeybindingCommand) => void;
}) {
  let held: { readonly data: string; readonly rules: TerminalKeybindingRule[] } | null = null;
  const send = (data: string) => {
    const output = held ? held.data + data : data;
    held = null;
    if (output.length > 0) write(output);
  };
  const consume = (event: Key) => {
    event.preventDefault();
    event.stopPropagation();
    return false;
  };
  const begin = (event: Key): boolean => {
    if (isTerminalCompositionKey(event, false)) return true;
    const sequences: TerminalKeybindingRule[] = [];
    for (const rule of rules()) {
      const steps = keybindingRuleSteps(rule);
      if (!matchesShortcut(event, steps[0])) continue;
      if (steps.length === 2) {
        sequences.push(rule);
        continue;
      }
      // A more recent sequence starting on this key shadows a chord rule.
      if (sequences.length > 0) break;
      // Holding a font size key repeats it, as terminal emulators do; holding
      // the escape across a refocus must not leave again.
      if (event.repeat && rule.command === "terminal.leaveFocus") return true;
      run(rule.command);
      return consume(event);
    }
    // A repeat is an ordinary key: only a fresh press can start a sequence.
    if (sequences.length === 0 || event.repeat) return true;
    held = { data: encode(event), rules: sequences };
    return consume(event);
  };
  return {
    send,
    beforeKey(event: Key): boolean {
      if (!held) return begin(event);
      if (isModifierKeyEvent(event) || isTerminalCompositionKey(event, false)) return true;
      const completed = held.rules.find((rule) => {
        const steps = keybindingRuleSteps(rule);
        return steps.length === 2 && matchesShortcut(event, steps[1]);
      });
      if (completed) {
        // Holding the first chord down must not complete it by auto-repeat.
        if (event.repeat) return consume(event);
        held = null;
        run(completed.command);
        return consume(event);
      }
      // Any other key releases the held key ahead of itself, even a key the
      // terminal then encodes as nothing, and may itself begin a rule.
      send("");
      return begin(event);
    },
    reset(): void {
      held = null;
    },
  };
}
