import { subscribeAtomChanges } from "../rpc/atomRegistry";
import { environmentThemeDefinitionsAtom } from "../themePalette";
import { refreshTheme } from "./useTheme";

/**
 * The palette is painted from a snapshot taken when the theme last changed, so new colors
 * only land if the active theme is re-applied.
 */
export function startEnvironmentThemeRepaint(): () => void {
  return subscribeAtomChanges(environmentThemeDefinitionsAtom, () => {
    refreshTheme({ preservePreview: true });
  });
}
