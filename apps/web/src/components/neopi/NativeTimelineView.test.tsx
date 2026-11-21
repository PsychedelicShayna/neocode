// @vitest-environment jsdom

import type { LegendListRef } from "@legendapp/list/react";
import type { TranscriptRow } from "@t3tools/client-runtime/neopi-transcript";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  type ResponseStreamingMode,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { NativeTimelineView } from "./NativeTimelineView";

const settings = vi.hoisted(() => ({ responseStreamingMode: "token" as ResponseStreamingMode }));
vi.mock(import("../../hooks/useSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentSettings: <T = UnifiedSettings,>(
    _environmentId: EnvironmentId,
    select?: (value: UnifiedSettings) => T,
  ): T => {
    const value = { ...DEFAULT_UNIFIED_SETTINGS, ...settings };
    return select ? select(value) : (value as T);
  },
}));

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

it.each([
  { mode: "paragraph", first: "", midway: "First paragraph.\n\n" },
  { mode: "token", first: "First", midway: "First paragraph.\n\nSecond" },
  { mode: "turn", first: "", midway: "" },
] as const)(
  "shows $mode response streaming in the native transcript",
  async ({ mode, first, midway }) => {
    const container = document.body.appendChild(document.createElement("div"));
    const ref = createRef<LegendListRef>();
    const root = createRoot(container);
    const timestamp = "2026-03-17T19:12:28.000Z";
    const answer = async (text: string, live: boolean, ended?: true) => {
      await act(() =>
        root.render(
          <NativeTimelineView
            rows={[
              {
                kind: "assistant",
                id: "answer",
                entry: { id: "answer", parentId: null, type: "message", timestamp },
                timestamp,
                live,
                ...(ended ? { ended } : {}),
                text,
                images: [],
                meta: null,
              },
            ]}
            busy={live}
            environmentId={EnvironmentId.make("environment-local")}
            listRef={ref}
            timelineKey="native-streaming-test"
            cwd={undefined}
            loadEarlier={null}
            onImageExpand={() => {}}
          />,
        ),
      );
      await act(() => vi.advanceTimersByTimeAsync(50));
      return (
        ref.current?.getState().data.find((row) => row.message?.id === "answer")?.message.text ?? ""
      );
    };
    settings.responseStreamingMode = mode;
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 400),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    try {
      expect(await answer("First", true)).toBe(first);
      expect(await answer("First paragraph.\n\nSecond", true)).toBe(midway);
      expect(await answer("First paragraph.\n\nSecond paragraph.", true, true)).toBe(
        "First paragraph.\n\nSecond paragraph.",
      );
      expect(await answer("First paragraph.\n\nSecond paragraph.", false)).toBe(
        "First paragraph.\n\nSecond paragraph.",
      );
    } finally {
      await act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      vi.useRealTimers();
      settings.responseStreamingMode = "token";
    }
  },
);

it("jumps from older native output to the live end and follows new output", async () => {
  const ref = createRef<LegendListRef>();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const timestamp = "2026-03-17T19:12:28.000Z";
  const rows: readonly TranscriptRow[] = [
    {
      kind: "assistant",
      id: "answer",
      entry: { id: "answer", parentId: null, type: "message", timestamp },
      timestamp,
      live: true,
      text: "Streaming answer",
      images: [],
      meta: null,
    },
  ];
  const flush = () => act(() => vi.advanceTimersByTimeAsync(50));
  const scroll = (node: HTMLElement, top: number) => {
    node.scrollTop = Math.max(0, Math.min(top, node.scrollHeight - node.clientHeight));
    node.dispatchEvent(new Event("scroll"));
  };
  let answerHeight = 1000;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = this.classList.contains("scrollbar-gutter-both")
      ? 400
      : this.matches('[data-message-id="answer"]') ||
          this.querySelector('[data-message-id="answer"]')
        ? answerHeight
        : 24;
    return new DOMRect(0, 0, 800, height);
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() =>
    Math.max(400, ref.current?.getState().contentLength ?? 0),
  );
  const old = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
  Object.defineProperties(HTMLElement.prototype, {
    scrollTo: {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        scroll(this, options.top ?? 0);
      },
    },
    scrollBy: {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        scroll(this, this.scrollTop + (options.top ?? 0));
      },
    },
  });
  try {
    await act(() =>
      root.render(
        <NativeTimelineView
          rows={rows}
          busy
          environmentId={EnvironmentId.make("environment-local")}
          timelineKey="native-test"
          cwd={undefined}
          listRef={ref}
          loadEarlier={null}
          onImageExpand={() => {}}
        />,
      ),
    );
    await flush();
    const list = ref.current!;
    const node = list.getScrollableNode() as HTMLElement;
    const measure = async (height: number) => {
      answerHeight = height;
      const answer = list.getState().data.find((row) => row.message?.id === "answer");
      await act(() => list.setItemSize(answer.id, { height, width: 800 }));
      await flush();
    };
    const gap = () => node.scrollHeight - node.clientHeight - node.scrollTop;
    const button = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Scroll to end"]');
    await measure(1000);
    expect(gap()).toBeCloseTo(0);
    expect(button()).toBeNull();

    await act(() => {
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true }));
      scroll(node, node.scrollTop - 300);
    });
    await flush();
    expect(gap()).toBeGreaterThan(200);
    expect(button()).not.toBeNull();

    await act(() => button()!.click());
    await flush();
    expect(gap()).toBeCloseTo(0);
    expect(button()).toBeNull();

    const pinnedTop = node.scrollTop;
    await measure(1455);
    expect(node.scrollTop).toBeGreaterThan(pinnedTop + 400);
    expect(gap()).toBeCloseTo(0);
    expect(button()).toBeNull();
  } finally {
    await act(() => root.unmount());
    for (const key of ["scrollTo", "scrollBy"] as const) {
      if (old[key]) Object.defineProperty(HTMLElement.prototype, key, old[key]);
      else delete HTMLElement.prototype[key];
    }
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
