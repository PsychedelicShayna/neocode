import { readThemeRevision } from "./hooks/useTheme";
import {
  readShowNeoPiThemes,
  subscribeToNeoPiThemeCatalogPreference,
} from "./neopiThemeCatalogPreference";
import {
  getCustomThemes,
  installCustomTheme,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
} from "./themePalette";

export const NEOPI_CLIENT_THEME_IDS = {
  dark: "neopi-client-dark",
  light: "neopi-client-light",
} as const;
const COLLECTION = { id: "neopi-client-palettes", label: "NeoPi client palettes" };
let latestSelection = 0;

/** A late read owns nothing after another choice, hiding, or its picker closes. */
export function beginNeoPiThemeSelection() {
  const selection = ++latestSelection;
  const themeRevision = readThemeRevision();
  let active = readShowNeoPiThemes();
  const unsubscribe = subscribeToNeoPiThemeCatalogPreference(() => {
    active = false;
  });
  return {
    isCurrent: () =>
      active && selection === latestSelection && themeRevision === readThemeRevision(),
    cancel: () => {
      active = false;
      unsubscribe();
    },
  };
}

/** Keep one independent, offline-capable local selection per appearance. */
export function saveNeoPiClientTheme(
  appearance: ThemeAppearance,
  name: string | null,
  colors: ThemeColors,
) {
  const id = NEOPI_CLIENT_THEME_IDS[appearance];
  const previous = getCustomThemes().find((theme) => theme.id === id);
  if (previous && previous.collection?.id !== COLLECTION.id) {
    throw new Error(`The local theme id "${id}" is already used by another palette.`);
  }
  const theme = {
    id,
    label: (name ?? "Neo default").trim().slice(0, 48) || "NeoPi palette",
    appearance,
    colors,
    collection: COLLECTION,
    neoPiSourceName: name,
  };
  return previous ? updateCustomTheme(theme) : installCustomTheme(theme);
}

/** A display label cannot identify its source: older copies may have truncated it. */
export function neoPiClientThemeSourceName(theme: ThemeDefinition | undefined) {
  if (
    !theme ||
    theme.id !== NEOPI_CLIENT_THEME_IDS[theme.appearance] ||
    theme.collection?.id !== COLLECTION.id
  ) {
    return undefined;
  }
  return theme.neoPiSourceName;
}
