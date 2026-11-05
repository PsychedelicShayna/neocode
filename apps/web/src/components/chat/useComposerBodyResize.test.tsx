// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useComposerBodyResize } from "./useComposerBodyResize";

const storageKey = "t3code:composer-body-height";

function ComposerBody() {
  const resize = useComposerBodyResize();
  return (
    <>
      <div role="separator" aria-label="Resize prompt" {...resize.handleProps} />
      <div data-body ref={resize.bodyRef} style={resize.bodyStyle}>
        Draft
      </div>
    </>
  );
}

describe("composer keyboard resizing", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("innerHeight", 1000);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 400, 120),
    );
    localStorage.removeItem(storageKey);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.removeItem(storageKey);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function press(key: string, modifiers: KeyboardEventInit = {}) {
    const separator = container.querySelector<HTMLElement>("[role=separator]");
    if (!separator) throw new Error("Expected resize separator");
    separator.focus();
    await act(async () => {
      separator.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }),
      );
    });
  }

  it("pins an automatic draft height with the arrows and resets to auto with Enter", async () => {
    await act(async () => root.render(<ComposerBody />));
    await press("ArrowUp");
    expect(localStorage.getItem(storageKey)).toBe("136");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Resize prompt");
    await press("ArrowDown");
    expect(localStorage.getItem(storageKey)).toBe("120");
    await press("Enter");
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(container.querySelector<HTMLElement>("[data-body]")?.style.height).toBe("");
  });

  it("clamps keyboard changes to the minimum and the current viewport after a resize", async () => {
    localStorage.setItem(storageKey, "700");
    await act(async () => root.render(<ComposerBody />));
    await press("ArrowUp");
    expect(localStorage.getItem(storageKey)).toBe("700");
    vi.stubGlobal("innerHeight", 300);
    await press("ArrowDown");
    expect(localStorage.getItem(storageKey)).toBe("194");
    for (let index = 0; index < 20; index++) await press("ArrowDown");
    expect(localStorage.getItem(storageKey)).toBe("64");
  });

  it("leaves modified arrow shortcuts to their existing handlers", async () => {
    await act(async () => root.render(<ComposerBody />));
    await press("ArrowUp", { ctrlKey: true });
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
});
