export type TerminalFocusOwner = "drawer" | "right-panel";

/** Class of the hidden textarea through which a terminal surface takes keys. */
export const TERMINAL_INPUT_CLASS_NAME = "t3-ghostty-input";

export function getTerminalFocusOwner(): TerminalFocusOwner | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  const owner = activeElement.closest<HTMLElement>("[data-terminal-owner]")?.dataset.terminalOwner;
  if (owner === "drawer" || owner === "right-panel") return owner;
  return null;
}

export function isTerminalFocused(): boolean {
  return getTerminalFocusOwner() !== null;
}

let lastTerminalFocusOwner: TerminalFocusOwner | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    () => {
      lastTerminalFocusOwner = getTerminalFocusOwner() ?? lastTerminalFocusOwner;
    },
    true,
  );
}

/**
 * The terminal that has focus, or else the one that had it last. Commands
 * invoked from outside a terminal act on this one; the caller checks that it
 * still exists.
 */
export function getLastTerminalFocusOwner(): TerminalFocusOwner | null {
  return getTerminalFocusOwner() ?? lastTerminalFocusOwner;
}

/**
 * Whether a terminal's own keyboard input has focus, so every key belongs to
 * the program running in it. Focus on a terminal's toolbar or tab list does
 * not count; those are GUI controls inside the terminal owner.
 */
export function isTerminalInputFocused(): boolean {
  if (typeof document === "undefined") return false;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || !activeElement.isConnected) return false;
  return (
    activeElement.classList.contains(TERMINAL_INPUT_CLASS_NAME) &&
    activeElement.closest("[data-terminal-owner]") !== null
  );
}
