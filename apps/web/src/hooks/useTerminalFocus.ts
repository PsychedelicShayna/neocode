import { useEffect, useSyncExternalStore } from "react";

import { isTerminalFocused, isTerminalInputFocused } from "../lib/terminalFocus";

export function subscribeToTerminalFocusChanges(listener: () => void): () => void {
  window.addEventListener("focusin", listener, true);
  window.addEventListener("focusout", listener, true);
  return () => {
    window.removeEventListener("focusin", listener, true);
    window.removeEventListener("focusout", listener, true);
  };
}

export function useTerminalFocus(): boolean {
  return useSyncExternalStore(subscribeToTerminalFocusChanges, isTerminalFocused, () => false);
}

/**
 * Tells the desktop shell when a terminal's keyboard input gains or loses
 * focus in this window, so the shell leaves that terminal's keys to the
 * program running in it. Mount once per window.
 */
export function useDesktopTerminalInputFocusReport(): void {
  useEffect(() => {
    const report = window.desktopBridge?.setTerminalInputFocused;
    if (!report) return;
    let reported = false;
    const send = (focused: boolean) => {
      reported = focused;
      void report(focused).catch(() => undefined);
    };
    const sync = () => {
      const focused = isTerminalInputFocused();
      if (focused !== reported) send(focused);
    };
    sync();
    const unsubscribe = subscribeToTerminalFocusChanges(sync);
    return () => {
      unsubscribe();
      if (reported) send(false);
    };
  }, []);
}
