import {
  nativeSessionKey,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { create } from "zustand";
import {
  recentSessionOrder,
  recordRecentSession,
  stepRecentIndex,
  type NativeSessionTabs,
} from "./nativeSessionTabs";
import { selectNativeSession, useNativeSessionSelection } from "./neopiNativeSessions";

/**
 * Ctrl+Tab session switching in recently-used order, like Firefox. While the
 * modifier is held each Tab press moves the highlight one step through the
 * recency order without activating anything; releasing it commits that session,
 * which then leads the recency stack.
 */
interface NativeSessionSwitcher {
  /** Null while the switcher is closed. */
  readonly order: NativeSessionTabs | null;
  readonly index: number;
}
export const useNativeSessionSwitcher = create<NativeSessionSwitcher>(() => ({
  order: null,
  index: 0,
}));

// Session keys, most recently activated first. Not persisted: a restart falls back to tab order.
let recent: readonly string[] = [];
const noteActive = (target: NativeSessionTarget | null) => {
  if (target) recent = recordRecentSession(recent, nativeSessionKey(target));
};
noteActive(useNativeSessionSelection.getState().target);
useNativeSessionSelection.subscribe((state, previous) => {
  if (state.target !== previous.target) noteActive(state.target);
});

/** Returns whether the switcher moved; false leaves the key press to others (fewer than two tabs). */
export function stepNativeSessionSwitcher(direction: "previous" | "next"): boolean {
  const { order: open, index } = useNativeSessionSwitcher.getState();
  const selection = useNativeSessionSelection.getState();
  const order = open ?? recentSessionOrder(selection.tabs, recent, selection.target);
  if (order.length < 2) return false;
  useNativeSessionSwitcher.setState({
    order,
    index: stepRecentIndex(order.length, open ? index : 0, direction),
  });
  return true;
}

export function commitNativeSessionSwitcher() {
  const { order, index } = useNativeSessionSwitcher.getState();
  if (!order) return;
  useNativeSessionSwitcher.setState({ order: null, index: 0 });
  const chosen = order[index];
  const stillOpen = useNativeSessionSelection
    .getState()
    .tabs.some((tab) => chosen && nativeSessionKey(tab) === nativeSessionKey(chosen));
  if (chosen && stillOpen) selectNativeSession(chosen);
}

export function cancelNativeSessionSwitcher() {
  if (useNativeSessionSwitcher.getState().order)
    useNativeSessionSwitcher.setState({ order: null, index: 0 });
}
