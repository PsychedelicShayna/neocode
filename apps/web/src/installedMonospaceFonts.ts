import * as Schema from "effect/Schema";

import { isMonospaceFamily } from "./appearanceFonts";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const STORAGE_KEY = "t3code:monospace-font-families:v1";
const StoredClassifications = Schema.Record(Schema.String, Schema.Boolean);

// Names that usually mean a fixed-width face. They are measured first so most
// of the list arrives in the first slices; the name never decides the answer.
const LIKELY_MONOSPACE_NAME = /mono|nerd font|\bnf[mp]?\b|code|term|console|courier|fixed/i;

// Classifications by family name, loaded once from client-local storage and
// shared by the code and terminal pickers.
let classifications: Map<string, boolean> | null = null;

function knownClassifications(): Map<string, boolean> {
  if (classifications !== null) return classifications;
  let stored: { readonly [family: string]: boolean } | null = null;
  try {
    stored = getLocalStorageItem(STORAGE_KEY, StoredClassifications);
  } catch {
    // Unreadable or corrupt storage only costs a fresh scan.
  }
  classifications = new Map(Object.entries(stored ?? {}));
  return classifications;
}

/** Keep only installed families, in memory and in storage. */
function rememberInstalled(families: readonly string[], measured: boolean): void {
  const known = knownClassifications();
  const installed: Record<string, boolean> = {};
  let count = 0;
  for (const family of families) {
    const monospace = known.get(family);
    if (monospace === undefined) continue;
    installed[family] = monospace;
    count++;
  }
  if (!measured && count === known.size) return;
  classifications = new Map(Object.entries(installed));
  try {
    setLocalStorageItem(STORAGE_KEY, installed, StoredClassifications);
  } catch {
    // The in-memory result still serves this launch.
  }
}

/**
 * Classify installed families for an opened picker without monopolizing the
 * UI thread. The list starts with every family already known to be monospace
 * (plus the saved family, which stays selectable), in the input order, and
 * then only grows at its end: newly measured families are appended, likely
 * fixed-width names first, so rows never move under the pointer or keyboard
 * highlight. `onProgress` receives that list once before the first slice and
 * after every slice that found a family; the promise resolves with the final
 * list. Aborting stops measuring and keeps what was classified so far.
 */
export function scanInstalledMonospaceFonts(
  families: readonly string[],
  signal: AbortSignal,
  options: {
    readonly saved: string;
    readonly onProgress: (families: readonly string[]) => void;
  },
): Promise<readonly string[]> {
  return new Promise((resolve) => {
    const known = knownClassifications();
    const matches = families.filter(
      (family) => family === options.saved || known.get(family) === true,
    );
    const listed = new Set(matches);
    const unmeasured = families.filter((family) => !known.has(family));
    const queue = [
      ...unmeasured.filter((family) => LIKELY_MONOSPACE_NAME.test(family)),
      ...unmeasured.filter((family) => !LIKELY_MONOSPACE_NAME.test(family)),
    ];
    let index = 0;
    const finish = () => {
      rememberInstalled(families, index > 0);
      resolve(matches);
    };
    if (signal.aborted) {
      resolve(matches);
      return;
    }
    options.onProgress(matches.slice());
    if (queue.length === 0) {
      finish();
      return;
    }
    const scan = () => {
      if (signal.aborted) {
        finish();
        return;
      }
      const deadline = performance.now() + 8;
      const before = matches.length;
      while (index < queue.length) {
        const family = queue[index++]!;
        const monospace = isMonospaceFamily(family);
        known.set(family, monospace);
        if (monospace && !listed.has(family)) {
          listed.add(family);
          matches.push(family);
        }
        if (performance.now() >= deadline) break;
      }
      if (matches.length !== before) options.onProgress(matches.slice());
      if (index === queue.length) {
        finish();
      } else {
        setTimeout(scan, 0);
      }
    };
    // Yield before the first measurement too, so opening paints immediately.
    setTimeout(scan, 0);
  });
}
