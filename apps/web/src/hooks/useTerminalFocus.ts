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
 * Sends `send(true)` when a terminal's keyboard input takes focus in this
 * window and `send(false)` when it stops, changes only. A window without
 * focus receives no keys, so it reports false; that also clears a terminal
 * removed while the window was in the background, which fires no focusout
 * and, on return, no focusin. Returns the stop function, which reports false.
 */
export function startTerminalInputFocusReport(send: (focused: boolean) => void): () => void {
  let reported = false;
  const report = (focused: boolean) => {
    if (focused === reported) return;
    reported = focused;
    send(focused);
  };
  const sync = () => report(isTerminalInputFocused());
  const blur = () => report(false);

  sync();
  const unsubscribe = subscribeToTerminalFocusChanges(sync);
  // Removing the focused terminal fires no focusout, so any key also
  // re-checks; the shell then sees the corrected state from the next key.
  window.addEventListener("keydown", sync, true);
  // Not capture: element focus and blur do not bubble, so these fire only for
  // the window itself.
  window.addEventListener("focus", sync);
  window.addEventListener("blur", blur);
  return () => {
    unsubscribe();
    window.removeEventListener("keydown", sync, true);
    window.removeEventListener("focus", sync);
    window.removeEventListener("blur", blur);
    blur();
  };
}

/**
 * Tells the desktop shell when a terminal's keyboard input gains or loses
 * focus in this window, so the shell leaves that terminal's keys to the
 * program running in it. Mount once per window.
 */
export function useDesktopTerminalInputFocusReport(): void {
  useEffect(() => {
    const send = window.desktopBridge?.setTerminalInputFocused;
    if (!send) return;
    return startTerminalInputFocusReport((focused) => void send(focused).catch(() => undefined));
  }, []);
}
