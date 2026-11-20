// @vitest-environment jsdom

import { EnvironmentId, MessageId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, useCallback, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { createPageScrollController } from "./pageScrollController";
import { notifyTimelinePageScroll, useLeaveLiveEdgeOnScroll } from "./useLeaveLiveEdgeOnScroll";

function message(id: string, role: "user" | "assistant"): TimelineEntry {
  const createdAt = "2026-03-17T19:12:28.000Z";
  return {
    kind: "message",
    id,
    createdAt,
    message: {
      id: MessageId.make(id),
      role,
      text: id,
      turnId: null,
      createdAt,
      updatedAt: createdAt,
      streaming: role === "assistant",
    },
  };
}

async function withTimeline(
  routeThreadKey: string,
  run: (fixture: {
    prepend: () => Promise<void>;
    measure: (id: string, height: number) => Promise<void>;
    placeReader: (id: string, offset: number) => Promise<void>;
    composerPageUp: () => Promise<void>;
    attachToLiveEnd: () => Promise<void>;
    contentAtTop: () => { id: string; offset: number } | undefined;
  }) => Promise<void>,
  initiallyIncludesHistory = false,
) {
  const ref = createRef<LegendListRef>();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const prompt = message("prompt", "user");
  const answer = message("answer", "assistant");
  // A small row below the large streaming message can be fully onscreen while
  // the top of the viewport is still well inside the message.
  const nextPrompt = message("next-prompt", "user");
  const earlier = message("earlier", "user");
  const heights: Record<string, number> = {
    earlier: 120,
    prompt: 100,
    answer: 1000,
    "next-prompt": 500,
  };
  const props = {
    listRef: ref,
    isWorking: true,
    activeTurnStartedAt: null,
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaries: [],
    routeThreadKey,
    onOpenTurnDiff() {},
    supportsConversationRollback: false,
    onRevertToTurnCount() {},
    isRevertingCheckpoint: false,
    onImageExpand() {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady() {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: false,
    onIsAtEndChange() {},
    onManualNavigation() {},
  } satisfies Omit<ComponentProps<typeof MessagesTimeline>, "timelineEntries">;
  const flush = () => act(() => vi.advanceTimersByTimeAsync(50));
  function ReaderTimeline({ entries }: { entries: TimelineEntry[] }) {
    const [following, setFollowing] = useState(false);
    const onLeave = useCallback(() => setFollowing(false), []);
    const onReturn = useCallback(() => setFollowing(true), []);
    useLeaveLiveEdgeOnScroll(ref, following, onLeave, onReturn);
    return (
      <MessagesTimeline
        {...props}
        liveFollowEnabled={following}
        timelineEntries={entries}
        onManualNavigation={onLeave}
      />
    );
  }
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const row = this.matches("[data-message-id]") ? this : this.querySelector("[data-message-id]");
    const id = row?.getAttribute("data-message-id");
    const height = this.classList.contains("scrollbar-gutter-both")
      ? 400
      : id
        ? (heights[id] ?? 24)
        : 24;
    const list = ref.current;
    const state = list?.getState();
    const index = id ? state?.indexByKey(id) : undefined;
    const node = list?.getScrollableNode() as HTMLElement | undefined;
    const top =
      index !== undefined && node && node !== this
        ? (state?.positionAtIndex(index) ?? 0) - node.scrollTop
        : 0;
    return new DOMRect(0, top, 800, height);
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(4000);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  const scroll = (node: HTMLElement, top: number) => {
    node.scrollTop = top;
    node.dispatchEvent(new Event("scroll"));
  };
  try {
    // jsdom has no layout or scrolling. Supply only the DOM geometry and DOM
    // scroll operations; use LegendList itself for measurement and anchoring.
    const scrollTo = function (this: HTMLElement, options: ScrollToOptions) {
      scroll(this, options.top ?? 0);
    };
    const scrollBy = function (this: HTMLElement, options: ScrollToOptions) {
      scroll(this, this.scrollTop + (options.top ?? 0));
    };
    const old = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
    Object.defineProperties(HTMLElement.prototype, {
      scrollTo: { configurable: true, value: scrollTo },
      scrollBy: { configurable: true, value: scrollBy },
    });
    try {
      const entries = initiallyIncludesHistory
        ? [earlier, prompt, answer, nextPrompt]
        : [prompt, answer, nextPrompt];
      await act(() => root.render(<ReaderTimeline entries={entries} />));
      await flush();
      const list = ref.current!;
      const node = list.getScrollableNode() as HTMLElement;
      const idToIndex = (id: string) =>
        list
          .getState()
          .data.findIndex((row: { message?: { id: string } }) => row.message?.id === id);
      const measure = async (id: string, height: number) => {
        heights[id] = height;
        const key: string = list.getState().data[idToIndex(id)].id;
        await act(() => list.setItemSize(key, { height, width: 800 }));
        await flush();
      };
      if (initiallyIncludesHistory) await measure("earlier", 120);
      await measure("prompt", 100);
      await measure("answer", 1000);
      await measure("next-prompt", 500);
      const placeReader = async (id: string, offset: number) => {
        const readerTop = list.getState().positionAtIndex(idToIndex(id)) + offset;
        // LegendList applies a separate anchor reset to jumps longer than
        // the viewport. Approach the target via ordinary scroll steps.
        while (Math.abs(readerTop - node.scrollTop) > 300) {
          await act(() =>
            scroll(node, node.scrollTop + Math.sign(readerTop - node.scrollTop) * 300),
          );
          await flush();
        }
        await act(() => scroll(node, readerTop));
        await flush();
      };
      await placeReader("answer", 800);
      const contentAtTop = () => {
        const state = list.getState();
        for (let index = 0; index < state.data.length; index++) {
          const offset = node.scrollTop - state.positionAtIndex(index);
          if (offset >= 0 && offset < state.sizeAtIndex(index))
            return { id: state.data[index].message?.id, offset };
        }
      };
      await run({
        measure,
        contentAtTop,
        placeReader,
        async attachToLiveEnd() {
          // A page-focused End re-arms follow without relying on the final scroll position.
          await act(() => {
            document.body.dispatchEvent(
              new KeyboardEvent("keydown", { key: "End", bubbles: true }),
            );
          });
        },
        async composerPageUp() {
          const controller = createPageScrollController({
            getContainer: () => ({
              get clientHeight() {
                return node.clientHeight;
              },
              get scrollHeight() {
                return node.scrollHeight;
              },
              get scrollTop() {
                return node.scrollTop;
              },
              set scrollTop(top) {
                scroll(node, top);
              },
              getBoundingClientRect: () => node.getBoundingClientRect(),
            }),
            getScrollPaddingBottomPx: () => 0,
            onScrollStart: (key) => notifyTimelinePageScroll(node, key),
            env: {
              now: Date.now,
              requestAnimationFrame: (callback) =>
                window.setTimeout(() => callback(Date.now()), 16),
              cancelAnimationFrame,
              setTimeout: (callback, delay) => window.setTimeout(callback, delay),
              clearTimeout: (handle) => window.clearTimeout(handle),
            },
          });
          await act(async () => {
            controller.handleKeyDown("PageUp");
            controller.handleKeyUp("PageUp");
            await vi.advanceTimersByTimeAsync(300);
          });
          controller.dispose();
        },
        async prepend() {
          await act(() =>
            root.render(<ReaderTimeline entries={[earlier, prompt, answer, nextPrompt]} />),
          );
          await flush();
        },
      });
    } finally {
      for (const key of ["scrollTo", "scrollBy"] as const) {
        if (old[key]) Object.defineProperty(HTMLElement.prototype, key, old[key]);
        else delete HTMLElement.prototype[key];
      }
    }
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
}

it("keeps the same viewport-top content when the last answer grows below the reader", async () => {
  await withTimeline("reader-growth", async ({ measure, contentAtTop }) => {
    const before = contentAtTop();
    expect(before).toEqual({ id: "answer", offset: 800 });
    await measure("answer", 1455);
    expect(contentAtTop()).toEqual(before);
  });
});

it("preserves viewport-top content when pulling earlier history into a detached timeline", async () => {
  await withTimeline("reader-prepend", async ({ prepend, contentAtTop }) => {
    const before = contentAtTop();
    expect(before).toEqual({ id: "answer", offset: 800 });
    await prepend();
    expect(contentAtTop()).toEqual(before);
  });
});

it("keeps the reader's earlier row still when an offscreen history row grows", async () => {
  await withTimeline(
    "reader-history-growth",
    async ({ placeReader, measure, contentAtTop }) => {
      await placeReader("prompt", 32);
      const before = contentAtTop();
      expect(before).toEqual({ id: "prompt", offset: 32 });
      await measure("earlier", 280);
      expect(contentAtTop()).toEqual(before);
    },
    true,
  );
});

it("holds the page the composer scrolled to while the reply keeps growing", async () => {
  await withTimeline(
    "reader-pageup",
    async ({ placeReader, attachToLiveEnd, composerPageUp, measure, contentAtTop }) => {
      await placeReader("answer", 990);
      await attachToLiveEnd();
      await composerPageUp();
      const before = contentAtTop();
      expect(before?.id).toBe("answer");
      expect(before?.offset).toBeCloseTo(626, 1);
      await measure("answer", 1455);
      expect(contentAtTop()).toEqual(before);
    },
  );
});
