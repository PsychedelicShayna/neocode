import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const GENERIC_WIDTHS: Record<string, number> = { monospace: 10, serif: 11, "sans-serif": 12 };

/**
 * A canvas whose measurements follow the CSS fallback rule: text is laid out
 * in the first listed family that is installed, else in the generic.
 */
function stubFontEngine(installed: readonly string[] | null) {
  const context = {
    font: "",
    measureText() {
      const list = context.font.replace(/^.*?\d+px\s+/, "").split(",");
      for (const raw of list) {
        const family = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
        const index = installed?.indexOf(family) ?? -1;
        if (index >= 0) return { width: 20 + index };
        const generic = GENERIC_WIDTHS[family];
        if (generic !== undefined) return { width: generic };
      }
      return { width: GENERIC_WIDTHS.monospace };
    },
  };
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => (installed === null ? null : context) }),
  });
}

// Imported per case: appearanceFonts caches its canvas probe context at module
// level, so each simulated machine needs freshly loaded modules.
async function loadFonts() {
  const appearance = await import("../../appearanceFonts");
  const surface = await import("./surface");
  return { ...appearance, ...surface };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("default terminal font", () => {
  it("keeps an explicit terminal or monospace choice over an installed Nerd Font", async () => {
    stubFontEngine(["MesloLGS Nerd Font", "Iosevka"]);
    const { resolveTerminalFontPreference, terminalFontFamily } = await loadFonts();

    const advanced = terminalFontFamily(
      resolveTerminalFontPreference({ advanced: true, code: "", terminal: "Iosevka" }),
    );
    const simple = terminalFontFamily(
      resolveTerminalFontPreference({ advanced: false, code: "Iosevka", terminal: "" }),
    );
    expect(advanced.startsWith("Iosevka, ")).toBe(true);
    expect(simple.startsWith("Iosevka, ")).toBe(true);
  });

  it("prefers Meslo, then JetBrains Mono, then other Nerd Fonts over platform faces", async () => {
    stubFontEngine(["Liberation Mono", "Hack Nerd Font", "JetBrainsMono Nerd Font", "MesloLGS NF"]);
    expect((await loadFonts()).resolveDefaultTerminalFontLabel()).toBe("MesloLGS NF");

    vi.resetModules();
    stubFontEngine(["Liberation Mono", "Hack Nerd Font", "JetBrainsMono Nerd Font"]);
    expect((await loadFonts()).resolveDefaultTerminalFontLabel()).toBe("JetBrainsMono Nerd Font");

    vi.resetModules();
    stubFontEngine(["Liberation Mono", "Hack Nerd Font"]);
    expect((await loadFonts()).resolveDefaultTerminalFontLabel()).toBe("Hack Nerd Font");
  });

  it("falls back to the platform monospace faces without an installed Nerd Font", async () => {
    stubFontEngine(["Liberation Mono", "Symbols Nerd Font Mono"]);
    const { resolveDefaultTerminalFontLabel, resolveTerminalFontPreference, terminalFontFamily } =
      await loadFonts();
    expect(resolveDefaultTerminalFontLabel()).toBe("Liberation Mono");
    // The bundled symbols-only face never stands in for the text face.
    expect(
      terminalFontFamily(resolveTerminalFontPreference({ advanced: true, code: "", terminal: "" })),
    ).toMatch(/"Liberation Mono".*"Symbols Nerd Font Mono"/);
  });

  it("leaves the default unnamed when installed fonts cannot be measured", async () => {
    stubFontEngine(null);
    const { DEFAULT_TERMINAL_FONT_FAMILY, resolveDefaultTerminalFontLabel, terminalFontFamily } =
      await loadFonts();
    expect(resolveDefaultTerminalFontLabel()).toBeNull();
    expect(terminalFontFamily()).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });
});
