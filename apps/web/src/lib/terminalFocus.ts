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

/** One terminal, identified as its viewport names it. */
export interface TerminalIdentity {
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalId: string;
}

function readFocusedTerminal(): TerminalIdentity | null {
  if (typeof document === "undefined") return null;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || !activeElement.isConnected) return null;
  const viewport = activeElement.closest<HTMLElement>("[data-terminal-id]");
  const { terminalId, terminalThreadId, terminalEnvironmentId } = viewport?.dataset ?? {};
  if (!terminalId || !terminalThreadId || !terminalEnvironmentId) return null;
  return { environmentId: terminalEnvironmentId, threadId: terminalThreadId, terminalId };
}

let lastFocusedTerminal: TerminalIdentity | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    () => {
      lastFocusedTerminal = readFocusedTerminal() ?? lastFocusedTerminal;
    },
    true,
  );
}

/**
 * The terminal that has focus, or else the one that had it last. The Ex line
 * acts on this one; the caller checks that it still exists.
 */
export function getLastFocusedTerminal(): TerminalIdentity | null {
  return readFocusedTerminal() ?? lastFocusedTerminal;
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
