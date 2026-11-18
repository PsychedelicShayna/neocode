import {
  DEFAULT_CLIENT_SETTINGS,
  MAX_CODE_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { terminalFontSizePatch } from "./terminalFontSize";

describe("terminal font size keys", () => {
  it("change the size the terminal is drawn at in each typography mode", () => {
    // Simple typography: the terminal follows the monospace size.
    expect(
      terminalFontSizePatch("terminal.fontSize.increase", {
        advanced: false,
        code: 13,
        terminal: 16,
      }),
    ).toEqual({ fontSizeCode: 14 });
    expect(
      terminalFontSizePatch("terminal.fontSize.decrease", {
        advanced: true,
        code: 13,
        terminal: 16,
      }),
    ).toEqual({ fontSizeTerminal: 15 });
  });

  it("stop at the setting's bounds", () => {
    expect(
      terminalFontSizePatch("terminal.fontSize.increase", {
        advanced: false,
        code: MAX_CODE_FONT_SIZE,
        terminal: 12,
      }),
    ).toBeNull();
    expect(
      terminalFontSizePatch("terminal.fontSize.decrease", {
        advanced: true,
        code: 13,
        terminal: MIN_TERMINAL_FONT_SIZE,
      }),
    ).toBeNull();
  });

  it("reset to the default size", () => {
    expect(
      terminalFontSizePatch("terminal.fontSize.reset", { advanced: true, code: 13, terminal: 18 }),
    ).toEqual({ fontSizeTerminal: DEFAULT_CLIENT_SETTINGS.fontSizeTerminal });
    expect(
      terminalFontSizePatch("terminal.fontSize.reset", {
        advanced: false,
        code: DEFAULT_CLIENT_SETTINGS.fontSizeCode,
        terminal: 18,
      }),
    ).toBeNull();
  });
});
