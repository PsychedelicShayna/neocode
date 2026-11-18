/** Marks the Ex command line's input; its keys belong to it alone. */
export const EX_LINE_INPUT_ATTRIBUTE = "data-ex-line-input";

/** Whether the Ex command line's input has focus. */
export function isExLineFocused(): boolean {
  if (typeof document === "undefined") return false;
  const activeElement = document.activeElement;
  return (
    activeElement instanceof HTMLElement &&
    activeElement.closest(`[${EX_LINE_INPUT_ATTRIBUTE}]`) !== null
  );
}

/** Keys that ran a command or closed the Ex line and are still held, each with its disarm. */
const guards = new Map<string, () => void>();

/**
 * Whether this keydown is an auto-repeat of a key that just closed the Ex
 * line. Listeners on the window run before the document's guard, so any of
 * them that acts on Enter or Escape checks this.
 */
export function isGuardedRepeat(event: { readonly key: string; readonly repeat?: boolean }) {
  return event.repeat === true && guards.has(event.key);
}

/**
 * The key that ran a command or closed the Ex line is still held: until it is
 * released, pressed afresh, or the window loses focus, its auto-repeat reaches
 * nothing, neither the field focus returns to nor a shortcut. Each key has its
 * own guard. A fresh press disarms the guard first, so a keyup lost inside an
 * embedded page cannot keep it armed.
 */
export function guardHeldKey(key: string): void {
  guards.get(key)?.();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== key) return;
    if (!event.repeat) {
      disarm();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === key) disarm();
  };
  const disarm = () => {
    if (guards.get(key) === disarm) guards.delete(key);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", disarm);
  };
  guards.set(key, disarm);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", disarm);
}
