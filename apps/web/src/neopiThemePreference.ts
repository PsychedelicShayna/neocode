import { useSyncExternalStore } from "react";

const KEY = "neocode:native-themes:follow:v1";
const EVENT = "neocode:native-themes-preference";

/** A named graphical palette is an explicit choice, including an unresolved one. */
export function shouldFollowNativeTheme(stored: string | null, theme: string | null, halves: string | null): boolean {
  if (stored === "true") return true;
  if (stored === "false") return false;
  return (theme === null || theme === "system" || theme === "light" || theme === "dark") && halves === null;
}
function snapshot() {
  try {
    return shouldFollowNativeTheme(window.localStorage.getItem(KEY), window.localStorage.getItem("t3code:theme"), window.localStorage.getItem("t3code:theme-halves:v1"));
  } catch {
    return false;
  }
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY || event.key === "t3code:theme" || event.key === "t3code:theme-halves:v1") listener();
  };
  window.addEventListener("storage", storage);
  window.addEventListener(EVENT, listener);
  return () => { window.removeEventListener("storage", storage); window.removeEventListener(EVENT, listener); };
}
export function setFollowNeoPiTheme(follow: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, String(follow));
  window.dispatchEvent(new Event(EVENT));
}
export function useFollowNeoPiTheme() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
