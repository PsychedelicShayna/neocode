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
