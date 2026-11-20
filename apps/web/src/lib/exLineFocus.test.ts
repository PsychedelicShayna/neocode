// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { guardHeldKey, isGuardedRepeat } from "./exLineFocus";

function keydown(key: string, repeat: boolean) {
  const event = new KeyboardEvent("keydown", { key, repeat, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

afterEach(() => {
  window.dispatchEvent(new Event("blur"));
});

describe("held-key guard", () => {
  it("keeps guarding Enter while Escape is guarded too", () => {
    guardHeldKey("Enter");
    guardHeldKey("Escape");
    expect(keydown("Enter", true).defaultPrevented).toBe(true);
    expect(keydown("Escape", true).defaultPrevented).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
    expect(isGuardedRepeat({ key: "Escape", repeat: true })).toBe(false);
    expect(isGuardedRepeat({ key: "Enter", repeat: true })).toBe(true);
  });

  it("is cleared by a fresh press of its key, as when the keyup was lost elsewhere", () => {
    guardHeldKey("Enter");
    expect(keydown("Enter", false).defaultPrevented).toBe(false);
    expect(isGuardedRepeat({ key: "Enter", repeat: true })).toBe(false);
    expect(keydown("Enter", true).defaultPrevented).toBe(false);
  });
});
