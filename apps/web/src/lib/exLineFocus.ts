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

let guardedKey: string | null = null;

/** Whether this keydown is an auto-repeat of the key that just closed the Ex line. */
export function isGuardedRepeat(event: { readonly key: string; readonly repeat?: boolean }) {
  return event.repeat === true && event.key === guardedKey;
}

/**
 * The key that ran a command or closed the Ex line is still held: until it is
 * released (or the window loses focus), its auto-repeat reaches nothing,
 * neither the field focus returns to nor a shortcut. A fresh press is not
 * affected.
 */
export function guardHeldKey(key: string): void {
  guardedKey = key;
  const swallow = (event: KeyboardEvent) => {
    if (!isGuardedRepeat(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const release = (event: KeyboardEvent) => {
    if (event.key === key) disarm();
  };
  const disarm = () => {
    if (guardedKey === key) guardedKey = null;
    document.removeEventListener("keydown", swallow, true);
    document.removeEventListener("keyup", release, true);
    window.removeEventListener("blur", disarm);
  };
  document.addEventListener("keydown", swallow, true);
  document.addEventListener("keyup", release, true);
  window.addEventListener("blur", disarm);
}
