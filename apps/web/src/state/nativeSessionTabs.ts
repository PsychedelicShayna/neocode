import {
  nativeSessionKey,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";

export type NativeSessionTabs = readonly NativeSessionTarget[];

const indexOfTab = (tabs: NativeSessionTabs, target: NativeSessionTarget) => {
  const key = nativeSessionKey(target);
  return tabs.findIndex((tab) => nativeSessionKey(tab) === key);
};

/** Opening a session that already has a tab keeps its place. */
export function openNativeSessionTab(
  tabs: NativeSessionTabs,
  target: NativeSessionTarget,
): NativeSessionTabs {
  return indexOfTab(tabs, target) === -1 ? [...tabs, target] : tabs;
}

/** NeoPi moved the session to another file (fork, branch): the tab follows in place. */
export function replaceNativeSessionTab(
  tabs: NativeSessionTabs,
  from: NativeSessionTarget,
  to: NativeSessionTarget,
): NativeSessionTabs {
  const fromIndex = indexOfTab(tabs, from);
  if (fromIndex === -1) return openNativeSessionTab(tabs, to);
  if (indexOfTab(tabs, to) !== -1) return tabs.filter((_, index) => index !== fromIndex);
  return tabs.map((tab, index) => (index === fromIndex ? to : tab));
}

/** Closing the active tab activates its right neighbour, else its left one, like a browser. */
export function closeNativeSessionTab(
  tabs: NativeSessionTabs,
  active: NativeSessionTarget | null,
  closing: NativeSessionTarget,
): { readonly tabs: NativeSessionTabs; readonly active: NativeSessionTarget | null } {
  const index = indexOfTab(tabs, closing);
  if (index === -1) return { tabs, active };
  const remaining = tabs.filter((_, position) => position !== index);
  if (!active || nativeSessionKey(active) !== nativeSessionKey(closing))
    return { tabs: remaining, active };
  return { tabs: remaining, active: remaining[index] ?? remaining[index - 1] ?? null };
}

/** Drags a tab to `toIndex`, the position it holds afterwards. */
export function moveNativeSessionTab(
  tabs: NativeSessionTabs,
  moving: NativeSessionTarget,
  toIndex: number,
): NativeSessionTabs {
  const from = indexOfTab(tabs, moving);
  const to = Math.max(0, Math.min(toIndex, tabs.length - 1));
  if (from === -1 || from === to) return tabs;
  const next = tabs.filter((_, index) => index !== from);
  next.splice(to, 0, tabs[from]!);
  return next;
}

/** The most-recently-used stack of session keys: the activated one goes to the front. */
export function recordRecentSession(recent: readonly string[], key: string): readonly string[] {
  return recent[0] === key ? recent : [key, ...recent.filter((entry) => entry !== key)];
}

/**
 * The open tabs from most to least recently used, starting with the active one.
 * Tabs never activated in this run (restored from a previous one) follow in tab order.
 */
export function recentSessionOrder(
  tabs: NativeSessionTabs,
  recent: readonly string[],
  active: NativeSessionTarget | null,
): NativeSessionTabs {
  const keyed = new Map(tabs.map((tab) => [nativeSessionKey(tab), tab]));
  const keys = new Set<string>();
  for (const key of [...(active ? [nativeSessionKey(active)] : []), ...recent])
    if (keyed.has(key)) keys.add(key);
  for (const key of keyed.keys()) keys.add(key);
  return [...keys].map((key) => keyed.get(key)!);
}

/**
 * One Tab press while Ctrl is held. Next walks back through the recency order
 * (Ctrl+Tab), previous walks forward (Ctrl+Shift+Tab); both wrap.
 */
export function stepRecentIndex(
  count: number,
  index: number,
  direction: "previous" | "next",
): number {
  if (count === 0) return 0;
  return (index + (direction === "next" ? 1 : -1) + count) % count;
}
