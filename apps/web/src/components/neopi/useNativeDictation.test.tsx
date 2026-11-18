// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { guardHeldKey } from "~/lib/exLineFocus";
import type { ComposerDictationControl } from "../chat/composerDictation.logic";
import { useNativeDictation } from "./useNativeDictation";

const request = vi.fn(async (_command: { type: string }) => ({}));
let control: ComposerDictationControl | null = null;

function Probe() {
  const value = useNativeDictation({
    feed: { dictation: null },
    request,
    composerRef: { current: null },
    unavailableReason: null,
  });
  useLayoutEffect(() => {
    control = value;
  });
  return null;
}

function escape(repeat: boolean) {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", repeat, bubbles: true, cancelable: true }),
    );
  });
}

const stops = () => request.mock.calls.filter(([command]) => command.type === "dictation_stop");

describe("dictation and the held Escape that closed the Ex line", () => {
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await act(async () => control?.toggle());
  });

  afterEach(async () => {
    window.dispatchEvent(new Event("blur"));
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    request.mockClear();
  });

  it("keeps recording through the held repeats, and a fresh Escape still discards", () => {
    expect(control?.phase).not.toBe("idle");
    guardHeldKey("Escape");
    escape(true);
    escape(true);
    expect(stops()).toHaveLength(0);

    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
    escape(false);
    expect(stops()).toHaveLength(1);
  });
});
