import { describe, expect, it, vi } from "vite-plus/test";
import { converter } from "culori/fn";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";

import { CONTEXT_CHIP_ACCENTS, contextChipColorVariable } from "./lib/contextChipAccents";

import {
  getThemeColorsForMode,
  getDestructiveSolidForeground,
  applyThemeColorPreview,
  applyThemePalette,
  contextChipVariables,
  getThemeModes,
  EMBER_THEME,
  getCustomThemes,
  getStandardThemeColors,
  getStoredCustomThemeCollection,
  invalidateCustomThemes,
  installCustomTheme,
  parseThemeFile,
  removeCustomTheme,
  replaceCustomThemeCollection,
  resolveDesktopTheme,
  resolveThemeAppearance,
  serializeThemeFile,
  subscribeToCustomThemes,
  T3_CHAT_THEME,
  GROVE_THEME,
  updateCustomTheme,
  updateThemeColorFamily,
  CUSTOM_THEMES_STORAGE_KEY,
  createVividThemeColors,
  getDefaultThemeColors,
  themeColorToHex,
  neoPiThemeColors,
  toCanonicalThemeColor,
  THEME_FILE_VERSION,
} from "./themePalette";

function asHex(value: string): string {
  const hex = themeColorToHex(value);
  if (!hex) throw new Error(`Expected a theme color, received ${value}`);
  return hex.slice(0, 7);
}

function canonical(value: string): string {
  const color = toCanonicalThemeColor(value);
  if (!color) throw new Error(`Expected a theme color, received ${value}`);
  return color;
}

function contrastRatio(first: string, second: string): number {
  const toRgb = (value: string) => {
    const hex = asHex(value).slice(1);
    return [0, 1, 2].map(
      (channel) => Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16) / 255,
    );
  };
  const luminance = (value: string) =>
    toRgb(value)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("filled destructive foreground", () => {
  it("keeps solid labels readable for light and dark custom error fills", () => {
    for (const appearance of ["light", "dark"] as const) {
      for (const error of ["#ffffff", "#ffffbb", "#000000", "#4c0000", "#dc3a40", "#ff6166"]) {
        const foreground = getDestructiveSolidForeground({
          ...getDefaultThemeColors(appearance),
          error,
        });
        expect(foreground).not.toBeNull();
        expect(contrastRatio(foreground!, error)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("composites transparent fills against the palette canvas", () => {
    for (const canvas of ["#ffffff", "#101010"]) {
      const foreground = getDestructiveSolidForeground({ canvas, error: "#ffffff00" });
      expect(foreground).not.toBeNull();
      expect(contrastRatio(foreground!, canvas)).toBeGreaterThanOrEqual(4.5);
    }
    expect(getDestructiveSolidForeground({ canvas: "#ffffff", error: "#" })).toBeNull();
  });

  it("updates previews and installed palettes, retains valid drafts, and clears overrides", () => {
    const variables = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string>,
      classList: { toggle: vi.fn() },
      style: {
        setProperty: (name: string, value: string) => variables.set(name, value),
        removeProperty: (name: string) => variables.delete(name),
      },
    };
    vi.stubGlobal("document", { documentElement: root });
    try {
      const variable = "--app-theme-error-solid-foreground";
      const draft = { ...getDefaultThemeColors("light"), error: "#ffffff" };
      applyThemeColorPreview(draft, "light");
      const foreground = variables.get(variable)!;
      expect(contrastRatio(foreground, draft.error)).toBeGreaterThanOrEqual(4.5);
      applyThemeColorPreview({ ...draft, error: "#" }, "light");
      expect(variables.get(variable)).toBe(foreground);

      applyThemePalette(EMBER_THEME.id, "dark");
      const colors = getThemeColorsForMode(EMBER_THEME, "dark")!;
      expect(variables.get(variable)).toBe(getDestructiveSolidForeground(colors));
      applyThemePalette("system");
      expect(variables.has(variable)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("native theme projection", () => {
  it("maps native semantic surfaces without losing text or focus contrast", () => {
    for (const appearance of ["light", "dark"] as const) {
      const dark = appearance === "dark";
      const native = {
        pageBg: dark ? "#15151c" : "#faf9f5",
        cardBg: dark ? "#232330" : "#ecebe8",
        infoBg: dark ? "#30303d" : "#dedddb",
        statusLineBg: dark ? "#101018" : "#ffffff",
        userMessageBg: dark ? "#261c30" : "#251e30",
        text: dark ? "#181820" : "#eeeeee",
        muted: dark ? "#24242a" : "#dddddd",
        accent: "#8156bd",
        borderAccent: dark ? "#191920" : "#eeeeee",
      };
      const colors = neoPiThemeColors(appearance, native);
      expect(asHex(colors.canvas)).toBe(native.pageBg);
      expect(asHex(colors.sidebar)).toBe(native.statusLineBg);
      for (const surface of [
        colors.canvas,
        colors.surface,
        colors.surfaceRaised,
        colors.surfaceOverlay,
      ]) {
        expect(contrastRatio(colors.text, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors.textMuted, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors.focus, surface)).toBeGreaterThanOrEqual(3);
      }
      expect(contrastRatio(colors.messageForeground, colors.messageSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(colors.sidebarForeground, colors.sidebar)).toBeGreaterThanOrEqual(4.5);
      const original = getDefaultThemeColors(appearance);
      expect(colors.messageAction).toBe(original.messageAction);
      expect(colors.messageActionForeground).toBe(original.messageActionForeground);
    }
  });
});

describe("theme files", () => {
  it("gives non-Latin theme names distinct stable ids", () => {
    const file = {
      version: THEME_FILE_VERSION,
      appearance: "dark",
      colors: { canvas: "#101820" },
    };
    const night = parseThemeFile({ ...file, name: "夜" });
    expect(parseThemeFile({ ...file, name: "朝" }).id).not.toBe(night.id);
    expect(parseThemeFile({ ...file, name: " 夜 " }).id).toBe(night.id);
  });

  it("keeps built-in and standard search pairs readable and distinct from inline code", () => {
    const toOklab = converter("oklab");
    const distance = (first: string, second: string) => {
      const a = toOklab(first)!;
      const b = toOklab(second)!;
      return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
    };
    const palettes = [
      getStandardThemeColors("light"),
      getStandardThemeColors("dark"),
      ...BUILT_IN_THEMES.flatMap((theme) => [theme.colors, ...Object.values(theme.variants ?? {})]),
    ];
    for (const colors of palettes) {
      expect(
        contrastRatio(colors.searchMatchForeground, colors.searchMatchBackground),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.searchMatchActiveForeground, colors.searchMatchActiveBackground),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        distance(colors.searchMatchBackground, colors.searchMatchActiveBackground),
      ).toBeGreaterThan(0.14);
      for (const background of [colors.muted, colors.messageSurface, colors.codeBackground]) {
        expect(distance(colors.searchMatchBackground, background)).toBeGreaterThan(0.08);
        expect(distance(colors.searchMatchActiveBackground, background)).toBeGreaterThan(0.08);
      }
    }
  });

  it("separates default page, card and raised surfaces in both appearances", () => {
    for (const appearance of ["light", "dark"] as const) {
      const colors = getStandardThemeColors(appearance);
      expect(asHex(colors.surface)).not.toBe(asHex(colors.canvas));
      expect(asHex(colors.surfaceRaised)).not.toBe(asHex(colors.surface));
      expect(asHex(colors.sidebarRowActive)).not.toBe(asHex(colors.sidebar));
    }
  });

  it("keeps default text and focus readable on their shared surfaces", () => {
    for (const appearance of ["light", "dark"] as const) {
      const colors = getStandardThemeColors(appearance);
      for (const surface of [colors.canvas, colors.surface, colors.surfaceRaised]) {
        expect(contrastRatio(colors.text, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors.textMuted, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors.focus, surface)).toBeGreaterThanOrEqual(3);
      }
      expect(
        contrastRatio(colors.messageActionForeground, colors.messageAction),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.errorForeground, colors.errorSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(colors.warningForeground, colors.warningSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
  it("round-trips custom search colours and fills them in for older theme files", () => {
    const legacy = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Legacy",
      appearance: "dark",
      colors: { canvas: "#101010" },
    });
    expect(legacy.colors.searchMatchBackground).toBe(
      getDefaultThemeColors("dark").searchMatchBackground,
    );
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Search",
      appearance: "dark",
      colors: {
        searchMatchBackground: "#224466",
        searchMatchForeground: "#ffffff",
        searchMatchActiveBackground: "#aaddff",
        searchMatchActiveForeground: "#112233",
      },
      variants: { light: { searchMatchBackground: "#ddeeff", searchMatchForeground: "#112233" } },
    });
    const restored = parseThemeFile(JSON.parse(serializeThemeFile(theme)));
    expect(restored.colors).toEqual(theme.colors);
    expect(restored.variants).toEqual(theme.variants);
  });

  it.each(["searchMatchBackground", "searchMatchActiveBackground"] as const)(
    "editing %s derives readable text without changing the other match or warning colours",
    (role) => {
      const original = getDefaultThemeColors("dark");
      const foreground =
        role === "searchMatchBackground" ? "searchMatchForeground" : "searchMatchActiveForeground";
      for (const value of ["#ffffff", "#000000", "#33669980"]) {
        const updated = updateThemeColorFamily("dark", original, role, value);
        expect(contrastRatio(updated[foreground], updated[role])).toBeGreaterThanOrEqual(4.5);
        for (const key of Object.keys(original) as Array<keyof typeof original>) {
          if (key !== role && key !== foreground) expect(updated[key]).toBe(original[key]);
        }
      }
    },
  );

  it("derives readable, distinctive vivid palettes from exact seeds", () => {
    const seeds: ReadonlyArray<["light" | "dark", string, string]> = [
      ["light", "#f4f9f2", "#1d8a4e"],
      ["dark", "#101a2c", "#4f8fe8"],
      ["dark", "#211a23", "#df5398"],
      ["light", "#fdf6ec", "#c2571b"],
      ["light", "#111827", "#8ab4f8"],
      ["dark", "#f5ecf5", "#a84370"],
    ];
    const channels = (value: string) =>
      [1, 3, 5].map((index) => Number.parseInt(asHex(value).slice(index, index + 2), 16)) as [
        number,
        number,
        number,
      ];
    for (const [appearance, canvas, accent] of seeds) {
      const colors = createVividThemeColors(appearance, canvas, accent);
      expect(colors.canvas).toMatch(/^oklch\(/);
      expect(colors.accent).toMatch(/^oklch\(/);
      expect(asHex(colors.canvas)).toBe(canvas);
      expect(asHex(colors.accent)).toBe(accent);
      expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(colors.textMuted, colors.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.textMuted, colors.canvas)).toBeLessThan(5.5);
      expect(contrastRatio(colors.mutedForeground, colors.muted)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.mutedForeground, colors.muted)).toBeLessThan(
        contrastRatio(colors.text, colors.muted),
      );
      expect(contrastRatio(colors.placeholder, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.placeholder, colors.surfaceRaised)).toBeLessThan(
        contrastRatio(colors.text, colors.surfaceRaised),
      );
      expect(colors.secondaryLabel).toBe(colors.textMuted);
      expect(contrastRatio(colors.accentForeground, colors.accent)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.searchMatchForeground, colors.searchMatchBackground),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.searchMatchActiveForeground, colors.searchMatchActiveBackground),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.messageActionForeground, colors.messageAction),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.messageForeground, colors.messageSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(colors.secondaryForeground, colors.secondary)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(colors.sidebarForeground, colors.sidebar)).toBeGreaterThanOrEqual(4.5);
      expect(colors.messageAction).not.toBe(colors.accent);
      expect(asHex(colors.update)).toBe(accent);
      const [errorRed, errorGreen, errorBlue] = channels(colors.error);
      expect(errorRed).toBeGreaterThan(errorGreen * 2);
      expect(errorRed).toBeGreaterThan(errorBlue * 2);
      expect(contrastRatio(colors.error, "#ffffff")).toBeGreaterThanOrEqual(2.5);
      expect(contrastRatio(colors.errorForeground, colors.errorSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
      const [warnRed, warnGreen, warnBlue] = channels(colors.warning);
      expect(warnRed).toBeGreaterThan(warnBlue);
      expect(warnGreen).toBeGreaterThan(warnBlue);
    }
  });

  it("decodes literal CSS color formats into OKLCH without dropping alpha", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Translucent",
      appearance: "light",
      colors: {
        canvas: "oklch(62% 0.2 280deg / 50%)",
        accent: "#abcd",
        focus: "rgb(10 20 30 / 50%)",
        error: "hsl(350 80% 50%)",
        warning: "hwb(45 10% 20%)",
        update: "lab(60% 40 30)",
        messageAction: "lch(60% 50 120)",
        sidebar: "oklab(0.6 0.1 -0.1)",
        terminalCursor: "color(display-p3 0.8 0.2 0.3)",
        terminalSelection: "rebeccapurple",
        terminalScrollbar: "transparent",
        terminalScrollbarHover: "rgb(10 20 30 / none)",
      },
    });

    expect(theme.colors.canvas).toBe("oklch(0.62 0.2 280 / 0.5)");
    expect(theme.colors.accent).toBe(canonical("#abcd"));
    expect(themeColorToHex(theme.colors.accent)).toBe("#aabbccdd");
    expect(themeColorToHex(theme.colors.focus)).toBe("#0a141e80");
    expect(themeColorToHex(theme.colors.terminalSelection)).toBe("#663399");
    expect(theme.colors.terminalScrollbar).toBe("oklch(0 0 0 / 0)");
    expect(themeColorToHex(theme.colors.terminalScrollbarHover)).toBe("#0a141e00");
    for (const role of [
      "error",
      "warning",
      "update",
      "messageAction",
      "sidebar",
      "terminalCursor",
    ] as const) {
      expect(theme.colors[role]).toMatch(/^oklch\(/);
    }
  });

  it("gamut maps extreme finite OKLCH chroma from theme files", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Extreme chroma",
      appearance: "light",
      colors: { accent: "oklch(0.5 1e303 0)" },
    });

    expect(theme.colors.accent).toBe("oklch(0.5 1e+303 0)");
    expect(themeColorToHex(theme.colors.accent)).toBe("#b5005e");
  });

  it("rejects unknown roles and invalid color values", () => {
    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Broken",
        appearance: "light",
        colors: { background: "#ffffff" },
      }),
    ).toThrow('"background" is not a supported theme color role.');

    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Broken",
        appearance: "light",
        colors: { accent: "var(--danger)" },
      }),
    ).toThrow('The color for "accent" must be a literal CSS color');
  });

  it("canonicalizes the explicitly exported theme", () => {
    const serialized = serializeThemeFile({
      ...T3_CHAT_THEME,
      colors: { ...T3_CHAT_THEME.colors, accent: "hsl(263 70% 58%)" },
    });
    expect(JSON.parse(serialized)).toMatchObject({
      version: THEME_FILE_VERSION,
      id: T3_CHAT_THEME.id,
      name: T3_CHAT_THEME.label,
      appearance: "light",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
  });

  it("serializes a theme back into the importable file shape", () => {
    const theme = {
      ...parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "community-demo",
        name: "Community Demo",
        appearance: "dark",
        colors: { canvas: "#111111" },
      }),
      collection: { id: "open-vsx:demo.theme", label: "Demo Theme" },
    };
    const serialized = serializeThemeFile(theme);
    expect(JSON.parse(serialized)).toMatchObject({
      version: THEME_FILE_VERSION,
      id: theme.id,
      name: theme.label,
      appearance: "dark",
      collection: theme.collection,
    });
    expect(parseThemeFile(JSON.parse(serialized)).collection).toEqual(theme.collection);
  });

  it("keeps optional light and dark palettes under one theme id", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "aurora",
      name: "Aurora",
      appearance: "light",
      colors: { canvas: "#f8fbff", text: "#10243d" },
      variants: {
        dark: { canvas: "#101827", text: "#eef5ff" },
      },
    });

    expect(getThemeModes(theme)).toEqual(["light", "dark"]);
    expect(getThemeColorsForMode(theme, "dark")).toMatchObject({
      canvas: canonical("#101827"),
      text: canonical("#eef5ff"),
    });
    expect(getThemeModes(T3_CHAT_THEME)).toEqual(["light", "dark"]);
    expect(resolveThemeAppearance(T3_CHAT_THEME.id, true, true)).toBe("dark");
    expect(resolveDesktopTheme(T3_CHAT_THEME.id, true)).toBe("system");
    expect(resolveThemeAppearance(T3_CHAT_THEME.id, false, false, "dark")).toBe("dark");
    expect(resolveDesktopTheme(T3_CHAT_THEME.id, false, "dark")).toBe("dark");
    expect(JSON.parse(serializeThemeFile(theme)).variants.dark).toMatchObject({
      canvas: canonical("#101827"),
      text: canonical("#eef5ff"),
    });
  });

  it("keeps built-in theme text and controls readable", () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const mode of getThemeModes(theme)) {
        const colors = getThemeColorsForMode(theme, mode);
        expect(colors).not.toBeNull();
        expect(contrastRatio(colors!.text, colors!.canvas)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors!.textMuted, colors!.canvas)).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors!.secondaryForeground, colors!.secondary),
        ).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors!.sidebarForeground, colors!.sidebar)).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(contrastRatio(colors!.accentForeground, colors!.accent)).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors!.toolbarControlForeground, colors!.toolbarControl),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors!.messageForeground, colors!.messageSurface),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors!.messageActionForeground, colors!.messageAction),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors!.messageActionForeground, colors!.messageActionHover),
        ).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors!.mutedForeground, colors!.muted)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors!.placeholder, colors!.surfaceRaised)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it("rejects a variant that repeats the base appearance", () => {
    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Duplicate light",
        appearance: "light",
        colors: { canvas: "#f8fbff" },
        variants: { light: { canvas: "#101827" } },
      }),
    ).toThrow('Theme variants must not repeat the base appearance "light".');
  });

  it("keeps a single-mode theme on its only palette", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "midnight-slate",
      name: "Midnight Slate",
      appearance: "dark",
      colors: { canvas: "#111827", messageAction: "#2563eb" },
    });

    expect(getThemeModes(theme)).toEqual(["dark"]);
    expect(getThemeColorsForMode(theme, "dark")).toMatchObject({
      canvas: canonical("#111827"),
    });
    expect(getThemeColorsForMode(theme, "light")).toBeNull();
  });

  it("invalidates cached themes when another tab clears localStorage", () => {
    let storedThemes: string | null = JSON.stringify([
      {
        id: "ocean-dusk",
        label: "Ocean dusk",
        appearance: "dark",
        colors: { canvas: "#07152f" },
      },
    ]);
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      removeEventListener: vi.fn(),
      localStorage: {
        getItem: (key: string) => (key === CUSTOM_THEMES_STORAGE_KEY ? storedThemes : null),
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toHaveLength(1);
    const listener = vi.fn();
    const unsubscribe = subscribeToCustomThemes(listener);

    storedThemes = null;
    storageHandler?.({ key: null } as StorageEvent);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getCustomThemes()).toEqual([]);
    unsubscribe();
    invalidateCustomThemes();
    vi.unstubAllGlobals();
  });

  it("preserves valid imported-theme collections and drops malformed metadata", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === CUSTOM_THEMES_STORAGE_KEY
            ? JSON.stringify([
                {
                  id: "github-dark",
                  label: "GitHub Dark",
                  appearance: "dark",
                  colors: { canvas: "#0d1117" },
                  collection: { id: "open-vsx:github.github-vscode-theme", label: "GitHub Theme" },
                },
                {
                  id: "github-light",
                  label: "GitHub Light",
                  appearance: "light",
                  colors: { canvas: "#ffffff" },
                  collection: { id: "bad collection id", label: "GitHub Theme" },
                },
              ])
            : null,
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toMatchObject([
      { collection: { id: "open-vsx:github.github-vscode-theme", label: "GitHub Theme" } },
      { id: "github-light" },
    ]);
    expect(getCustomThemes()[1]).not.toHaveProperty("collection");

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("atomically replaces an imported collection and removes stale variants", () => {
    const collection = { id: "open-vsx:demo.theme", label: "Demo Theme" };
    const personalTheme = {
      id: "personal",
      label: "Personal",
      appearance: "dark",
      colors: { canvas: "#111111", futureRole: "hsl(10 20% 30%)" },
      futureMetadata: { version: 2 },
    };
    const stored = new Map<string, string>([
      [
        CUSTOM_THEMES_STORAGE_KEY,
        JSON.stringify([
          personalTheme,
          {
            id: "old-light",
            label: "Old Light",
            appearance: "light",
            colors: { canvas: "#ffffff" },
            collection,
          },
          {
            id: "removed-dark",
            label: "Removed Dark",
            appearance: "dark",
            colors: { canvas: "#000000" },
            collection,
          },
        ]),
      ],
    ]);
    const setItem = vi.fn((key: string, value: string) => stored.set(key, value));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem,
      },
    });

    invalidateCustomThemes();
    const expectedCollection = getStoredCustomThemeCollection(collection.id);
    getCustomThemes();
    const concurrentlyAddedTheme = {
      id: "other-tab",
      label: "Other Tab",
      appearance: "dark",
      colors: { canvas: "#222222" },
    };
    stored.set(
      CUSTOM_THEMES_STORAGE_KEY,
      JSON.stringify([
        ...JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]"),
        concurrentlyAddedTheme,
      ]),
    );
    const replacement = [
      {
        ...parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "old-light",
          name: "New Light",
          appearance: "light",
          colors: { canvas: "#fafafa" },
        }),
        collection,
      },
      {
        ...parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "new-dark",
          name: "New Dark",
          appearance: "dark",
          colors: { canvas: "#101010" },
        }),
        collection,
      },
    ];

    expect(
      replaceCustomThemeCollection(collection.id, replacement, { expectedCollection }),
    ).toEqual(replacement);
    expect(getCustomThemes().map((theme) => theme.id)).toEqual([
      "personal",
      "old-light",
      "new-dark",
      "other-tab",
    ]);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]")[0]).toEqual(personalTheme);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("canonicalizes explicit writes without migrating untouched themes", () => {
    const stored = new Map<string, string>();
    const untouchedTheme = {
      id: "legacy",
      label: "Legacy",
      appearance: "dark",
      colors: { accent: "#5b6cff", futureRole: "hsl(10 20% 30%)" },
      futureMetadata: { version: 2 },
    };
    stored.set(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify([untouchedTheme]));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });

    invalidateCustomThemes();
    const createdTheme = installCustomTheme(
      parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "aurora",
        name: "Aurora",
        appearance: "light",
        colors: { canvas: "#f8fbff", accent: "#5b6cff" },
      }),
    );
    const updatedTheme = updateCustomTheme({
      ...createdTheme,
      label: "Aurora Night",
      colors: { ...createdTheme.colors, accent: "hsl(263 70% 58%)" },
    });

    expect(updatedTheme).toMatchObject({
      id: "aurora",
      label: "Aurora Night",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
    const storedThemes = JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]");
    expect(storedThemes[0]).toEqual(untouchedTheme);
    expect(storedThemes[1]).toMatchObject({
      id: "aurora",
      label: "Aurora Night",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
    invalidateCustomThemes();
    expect(getCustomThemes().find((theme) => theme.id === "aurora")).toMatchObject({
      id: "aurora",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
    removeCustomTheme("aurora");
    expect(JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]")).toEqual([untouchedTheme]);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("writes from the cached raw snapshot without risking a destructive reread", () => {
    const legacyTheme = {
      id: "legacy",
      label: "Legacy",
      appearance: "dark",
      colors: { accent: "#5b6cff" },
      futureMetadata: true,
    };
    let storedThemes = JSON.stringify([legacyTheme]);
    let readCount = 0;
    const setItem = vi.fn((_key: string, value: string) => {
      storedThemes = value;
    });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          readCount += 1;
          if (readCount > 1) throw new Error("transient read failure");
          return storedThemes;
        },
        setItem,
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toHaveLength(1);
    installCustomTheme(
      parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "aurora",
        name: "Aurora",
        appearance: "light",
        colors: { accent: "hsl(263 70% 58%)" },
      }),
    );

    expect(readCount).toBe(1);
    expect(setItem).toHaveBeenCalledOnce();
    expect(JSON.parse(storedThemes)[0]).toEqual(legacyTheme);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("refuses to overwrite a theme library that could not be read", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("storage unavailable");
        },
        setItem,
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toEqual([]);
    expect(() =>
      installCustomTheme(
        parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "aurora",
          name: "Aurora",
          appearance: "light",
          colors: { accent: "#5b6cff" },
        }),
      ),
    ).toThrow(`Failed to read the theme library from ${CUSTOM_THEMES_STORAGE_KEY}.`);
    expect(setItem).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });
});

describe("context chip colors", () => {
  it.each([
    ["#ffffff", 5],
    ["#777777", 4.5],
  ] as const)(
    "chooses readable chip lightness on %s when the text is medium gray",
    (surface, minimum) => {
      const colors = {
        ...getStandardThemeColors("light"),
        canvas: surface,
        surface,
        surfaceRaised: surface,
        messageSurface: surface,
        text: "#767676",
        messageForeground: "#767676",
      };
      for (const color of Object.values(contextChipVariables(colors))) {
        expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(minimum);
      }
    },
  );

  const toOklch = converter("oklch");
  const toRgb = converter("rgb");
  // Surfaces stay unrounded, as CSS paints them; the chip is the 8-bit hex the solver returns.
  const paintedContrastRatio = (chip: string, surface: string, canvas: string) => {
    const channels = (value: string) => {
      const rgb = toRgb(value)!;
      return [rgb.r, rgb.g, rgb.b].map((channel) => Math.min(1, Math.max(0, channel)));
    };
    const back = channels(canvas);
    const alpha = toRgb(surface)!.alpha ?? 1;
    const painted = channels(surface).map(
      (channel, index) => back[index]! * (1 - alpha) + channel * alpha,
    );
    const luminance = (rgb: number[]) =>
      rgb
        .map((channel) =>
          channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
    const first = luminance(channels(asHex(chip)));
    const second = luminance(painted);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };
  const palettes = [
    getStandardThemeColors("light"),
    getStandardThemeColors("dark"),
    ...BUILT_IN_THEMES.flatMap((theme) =>
      getThemeModes(theme).map((mode) => getThemeColorsForMode(theme, mode)!),
    ),
  ];

  it("reads at 5:1 on every chip surface of every built-in theme and keeps each hue", () => {
    for (const colors of palettes) {
      const variables = contextChipVariables(colors);
      expect(variables["--context-chip-message"]).toBeUndefined();
      for (const [kind, accent] of Object.entries(CONTEXT_CHIP_ACCENTS)) {
        const chip =
          variables[contextChipColorVariable(kind as keyof typeof CONTEXT_CHIP_ACCENTS)]!;
        for (const surface of [
          colors.canvas,
          colors.surface,
          colors.surfaceRaised,
          colors.messageSurface,
        ]) {
          expect(paintedContrastRatio(chip, surface, colors.canvas)).toBeGreaterThanOrEqual(5);
        }
        const solved = toOklch(chip)!;
        if ((solved.c ?? 0) > 0.04) {
          const drift = Math.abs((((solved.h ?? 0) - toOklch(accent)!.h! + 540) % 360) - 180);
          expect(drift).toBeLessThan(4);
        }
      }
    }
  });

  it("reads at 5:1 on the standard surfaces as index.css paints them", () => {
    const painted = {
      light: ["#fcfcfc", "#ffffff", "#ebebed"],
      dark: ["#000000", "#0a0a0a", "#111111", "#141414", "#1e1e1e"],
    } as const;
    const properties = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: () => null } });
    vi.stubGlobal("document", {
      documentElement: {
        dataset: {},
        style: {
          setProperty: (name: string, value: string) => properties.set(name, value),
          removeProperty: (name: string) => properties.delete(name),
        },
      },
    });
    invalidateCustomThemes();
    try {
      for (const appearance of ["light", "dark"] as const) {
        applyThemePalette("system", appearance);
        for (const kind of Object.keys(CONTEXT_CHIP_ACCENTS) as Array<
          keyof typeof CONTEXT_CHIP_ACCENTS
        >) {
          for (const surface of painted[appearance]) {
            expect(
              contrastRatio(properties.get(contextChipColorVariable(kind))!, surface),
            ).toBeGreaterThanOrEqual(5);
          }
        }
      }
    } finally {
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    }
  });

  it("solves the invalid state's error color to 5:1 on every chip surface", () => {
    for (const colors of palettes) {
      const invalid = contextChipVariables(colors)["--context-chip-invalid"];
      expect(invalid).toBeDefined();
      for (const surface of [
        colors.canvas,
        colors.surface,
        colors.surfaceRaised,
        colors.messageSurface,
      ]) {
        expect(paintedContrastRatio(invalid!, surface, colors.canvas)).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it("leaves a bubble with opposite-shade text out of the shared solve", () => {
    const colors = {
      ...getStandardThemeColors("light"),
      messageSurface: "#1b4ed8",
      messageForeground: "#ffffff",
    };
    const variables = contextChipVariables(colors);
    expect(variables["--context-chip-message"]).toBe("#ffffff");
    for (const kind of Object.keys(CONTEXT_CHIP_ACCENTS) as Array<
      keyof typeof CONTEXT_CHIP_ACCENTS
    >) {
      expect(
        contrastRatio(variables[contextChipColorVariable(kind)]!, colors.canvas),
      ).toBeGreaterThanOrEqual(5);
    }
    expect(toOklch(variables[contextChipColorVariable("file")])!.c).toBeGreaterThan(0.08);
  });
});

describe("stored theme preferences", () => {
  it("lets a configured half unlock an appearance the base theme lacks", () => {
    const lightOnly = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "paper",
      name: "Paper",
      appearance: "light",
      colors: { canvas: "#f8fbff" },
    });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === CUSTOM_THEMES_STORAGE_KEY ? JSON.stringify([lightOnly]) : null,
      },
    });
    invalidateCustomThemes();
    try {
      expect(resolveThemeAppearance("paper", true, true)).toBe("light");
      const halves = { dark: GROVE_THEME.id };
      expect(resolveThemeAppearance("paper", true, true, undefined, halves)).toBe("dark");
      expect(resolveThemeAppearance("paper", false, false, "dark", halves)).toBe("dark");
      expect(resolveDesktopTheme("paper", true, undefined, halves)).toBe("system");
    } finally {
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    }
  });

  it("decodes stored colors in memory without writing during reads", () => {
    const storedThemes = JSON.stringify([
      {
        id: "aurora",
        label: "Aurora",
        appearance: "light",
        colors: { canvas: "#f8fbff", futureRole: "#123456", accent: "not-a-color" },
        variants: { dark: { canvas: "rgb(16 24 39)" } },
      },
      { id: "light", label: "Reserved", appearance: "light", colors: {} },
      { id: "aurora", label: "Duplicate", appearance: "dark", colors: {} },
    ]);
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => (key === CUSTOM_THEMES_STORAGE_KEY ? storedThemes : null),
        setItem,
      },
    });
    invalidateCustomThemes();

    const themes = getCustomThemes();
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({
      id: "aurora",
      colors: { canvas: canonical("#f8fbff"), accent: getDefaultThemeColors("light").accent },
    });
    expect(getThemeModes(themes[0]!)).toEqual(["light", "dark"]);
    expect(getThemeColorsForMode(themes[0]!, "dark")?.canvas).toBe(canonical("rgb(16 24 39)"));
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.parse(storedThemes)[0].colors).toEqual({
      canvas: "#f8fbff",
      futureRole: "#123456",
      accent: "not-a-color",
    });

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });
});
