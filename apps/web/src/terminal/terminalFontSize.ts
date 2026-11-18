import {
  type ClientSettingsPatch,
  DEFAULT_CLIENT_SETTINGS,
  MAX_CODE_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "@t3tools/contracts";

import type { TerminalKeybindingCommand } from "../keybindings";

type TerminalFontSizeCommand = Exclude<TerminalKeybindingCommand, "terminal.leaveFocus">;

/**
 * The settings change for a terminal font size key. It changes the setting
 * the terminal reads its size from (`resolveTerminalFontSizePreference`):
 * the terminal font size in Advanced typography, otherwise the monospace
 * size the terminal follows. Null when the size is already at its bound.
 */
export function terminalFontSizePatch(
  command: TerminalFontSizeCommand,
  settings: { readonly advanced: boolean; readonly code: number; readonly terminal: number },
): ClientSettingsPatch | null {
  const [current, min, max, defaultSize] = settings.advanced
    ? [
        settings.terminal,
        MIN_TERMINAL_FONT_SIZE,
        MAX_TERMINAL_FONT_SIZE,
        DEFAULT_CLIENT_SETTINGS.fontSizeTerminal,
      ]
    : [settings.code, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, DEFAULT_CLIENT_SETTINGS.fontSizeCode];
  const next =
    command === "terminal.fontSize.reset"
      ? defaultSize
      : Math.min(max, Math.max(min, current + (command === "terminal.fontSize.increase" ? 1 : -1)));
  if (next === current) return null;
  return settings.advanced ? { fontSizeTerminal: next } : { fontSizeCode: next };
}
