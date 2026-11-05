import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function setupClient() {
  const storage = new Map<string, string>([
    ["t3code:theme", "system"],
    ["t3code:theme-appearance-mode", "dark"],
    ["neocode:native-themes:follow:v1", "true"],
  ]);
  const variables = new Map<string, string>();
  const classes = new Set<string>();
  const root = {
    dataset: {} as Record<string, string>,
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, enabled: boolean) =>
        enabled ? classes.add(name) : classes.delete(name),
    },
    style: {
      setProperty: (name: string, value: string) => variables.set(name, value),
      removeProperty: (name: string) => variables.delete(name),
    },
  };
  const events = new EventTarget();
  vi.stubGlobal("window", {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    matchMedia: () => ({ matches: true }),
  });
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("getComputedStyle", undefined);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.doMock("react", () => ({
    useCallback: <A>(callback: A) => callback,
    useEffect: () => undefined,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  }));
  return { storage, variables, root };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("local NeoPi palette selection", () => {
  it("paints explicit local selections, keeps both halves, and restores them offline at startup", async () => {
    const { storage, variables, root } = setupClient();
    const palette = await import("./themePalette");
    const { saveNeoPiClientTheme } = await import("./neopiLocalTheme");
    const { useTheme } = await import("./hooks/useTheme");
    const canvas = palette.getThemeColorVariable("canvas");
    const colors = palette.neoPiThemeColors("dark", { pageBg: "#131b25", accent: "#68c8ed" });
    const dark = saveNeoPiClientTheme("dark", "dark-arctic", colors);
    expect(useTheme().setThemeHalf("dark", dark.id)).toBe(true);
    expect(root.dataset.themeId).toBe(dark.id);
    expect(variables.get(canvas)).toBe(dark.colors.canvas);

    const light = saveNeoPiClientTheme("light", null, palette.getStandardThemeColors("light"));
    expect(useTheme().setThemeHalf("light", light.id)).toBe(true);
    expect(JSON.parse(storage.get(palette.THEME_HALVES_STORAGE_KEY)!)).toEqual({
      dark: dark.id,
      light: light.id,
    });
    expect(storage.get("t3code:theme")).toBe("system");

    const updated = saveNeoPiClientTheme("dark", "another-native-palette", {
      ...dark.colors,
      canvas: "#102030",
    });
    expect(updated.id).toBe(dark.id);
    useTheme().refreshTheme();
    expect(variables.get(canvas)).toBe(updated.colors.canvas);
    expect(palette.getCustomThemes().find((theme) => theme.id === light.id)).toEqual(light);
    expect(palette.getCustomThemes()).toHaveLength(2);

    vi.resetModules();
    const restarted = await import("./hooks/useTheme");
    expect(root.dataset.themeId).toBe(updated.id);
    expect(variables.get(canvas)).toBe(updated.colors.canvas);
    expect(restarted.useTheme().setAppearanceMode("light")).toBe(true);
    expect(root.dataset.themeId).toBe(light.id);
    expect(variables.get(canvas)).toBe(light.colors.canvas);

    expect(restarted.useTheme().setTheme("system")).toBe(true);
    expect(storage.has(palette.THEME_HALVES_STORAGE_KEY)).toBe(false);
    expect(root.dataset.themeId).toBeUndefined();
    expect(variables.has(canvas)).toBe(false);
  });

  it("keeps exact catalog identity across truncated labels, restart, and theme export", async () => {
    setupClient();
    const palette = await import("./themePalette");
    const local = await import("./neopiLocalTheme");
    const shortName = "a".repeat(48);
    const longName = `${shortName}-🌈-long`;
    const colors = palette.getStandardThemeColors("dark");
    const saved = local.saveNeoPiClientTheme("dark", longName, colors);
    expect(saved.label).toBe(shortName);
    expect(local.neoPiClientThemeSourceName(saved)).toBe(longName);
    expect(
      palette.parseThemeFile(JSON.parse(palette.serializeThemeFile(saved))).neoPiSourceName,
    ).toBe(longName);

    vi.resetModules();
    const restartedPalette = await import("./themePalette");
    const restartedLocal = await import("./neopiLocalTheme");
    const restored = restartedPalette.getCustomThemes().find((theme) => theme.id === saved.id);
    expect(restartedLocal.neoPiClientThemeSourceName(restored)).toBe(longName);
    const shorter = restartedLocal.saveNeoPiClientTheme("dark", shortName, colors);
    expect(shorter.id).toBe(saved.id);
    expect(shorter.label).toBe(saved.label);
    expect(restartedLocal.neoPiClientThemeSourceName(shorter)).toBe(shortName);
  });

  it("distinguishes a catalog theme named Neo default from the graphical default", async () => {
    setupClient();
    const palette = await import("./themePalette");
    const local = await import("./neopiLocalTheme");
    const colors = palette.getStandardThemeColors("dark");
    const catalog = local.saveNeoPiClientTheme("dark", "Neo default", colors);
    expect(local.neoPiClientThemeSourceName(catalog)).toBe("Neo default");
    const graphicalDefault = local.saveNeoPiClientTheme("dark", null, colors);
    expect(graphicalDefault.label).toBe(catalog.label);
    expect(local.neoPiClientThemeSourceName(graphicalDefault)).toBeNull();

    vi.resetModules();
    const restartedPalette = await import("./themePalette");
    const restartedLocal = await import("./neopiLocalTheme");
    const restored = restartedPalette.getCustomThemes().find((theme) => theme.id === catalog.id);
    expect(restartedLocal.neoPiClientThemeSourceName(restored)).toBeNull();
  });

  it("does not infer catalog identity from legacy or unrelated theme labels", async () => {
    setupClient();
    const palette = await import("./themePalette");
    const local = await import("./neopiLocalTheme");
    const legacy = palette.installCustomTheme({
      id: local.NEOPI_CLIENT_THEME_IDS.dark,
      label: "a".repeat(48),
      appearance: "dark",
      colors: palette.getStandardThemeColors("dark"),
      collection: { id: "neopi-client-palettes", label: "NeoPi client palettes" },
    });
    expect(local.neoPiClientThemeSourceName(legacy)).toBeUndefined();
    expect(
      local.neoPiClientThemeSourceName({
        ...legacy,
        id: "unrelated-theme",
        neoPiSourceName: "a".repeat(48),
      }),
    ).toBeUndefined();
  });

  it("does not overwrite an unrelated saved theme occupying the local selection id", async () => {
    setupClient();
    const palette = await import("./themePalette");
    const { NEOPI_CLIENT_THEME_IDS, saveNeoPiClientTheme } = await import("./neopiLocalTheme");
    const saved = palette.installCustomTheme({
      id: NEOPI_CLIENT_THEME_IDS.dark,
      label: "My own palette",
      appearance: "dark",
      colors: palette.getStandardThemeColors("dark"),
    });
    expect(() =>
      saveNeoPiClientTheme("dark", "dark-arctic", palette.getDefaultThemeColors("dark")),
    ).toThrow("already used");
    expect(palette.getCustomThemes()).toEqual([saved]);
  });

  it("abandons a pending read after even an equal-value graphical choice", async () => {
    const { storage } = setupClient();
    const { setShowNeoPiThemes } = await import("./neopiThemeCatalogPreference");
    const { beginNeoPiThemeSelection } = await import("./neopiLocalTheme");
    const { useTheme } = await import("./hooks/useTheme");
    setShowNeoPiThemes(true);
    const choices = [
      () => useTheme().setTheme("system"),
      () => useTheme().setAppearanceMode("dark"),
      () => useTheme().setThemeHalf("dark", null),
      () => useTheme().clearThemeHalves(),
    ];
    for (const choose of choices) {
      const pending = beginNeoPiThemeSelection();
      expect(pending.isCurrent()).toBe(true);
      expect(choose()).toBe(true);
      expect(pending.isCurrent()).toBe(false);
      pending.cancel();
    }
    expect(storage.has("t3code:themes:v1")).toBe(false);
  });

  it("cancels hidden or closed pickers and lets only the latest target own a result", async () => {
    setupClient();
    const { setShowNeoPiThemes } = await import("./neopiThemeCatalogPreference");
    const { beginNeoPiThemeSelection } = await import("./neopiLocalTheme");
    setShowNeoPiThemes(true);
    const firstTarget = beginNeoPiThemeSelection();
    const secondTarget = beginNeoPiThemeSelection();
    expect(firstTarget.isCurrent()).toBe(false);
    firstTarget.cancel();
    expect(secondTarget.isCurrent()).toBe(true);
    secondTarget.cancel();
    expect(secondTarget.isCurrent()).toBe(false);

    const hidden = beginNeoPiThemeSelection();
    setShowNeoPiThemes(false);
    setShowNeoPiThemes(true);
    expect(hidden.isCurrent()).toBe(false);
    hidden.cancel();
  });
});
