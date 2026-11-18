import type { LegendListRef } from "@legendapp/list/react";
import { act, createElement, createRef } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { gestureMovesTimeline, useLeaveLiveEdgeOnScroll } from "./useLeaveLiveEdgeOnScroll";

class ScrollElement extends EventTarget {
  scrollTop = 0;
  scrollHeight = 100;
  clientHeight = 100;
  overflowY = "visible";
  overscrollBehaviorY = "auto";

  constructor(readonly parentElement: ScrollElement | null = null) {
    super();
  }

  contains(target: ScrollElement): boolean {
    return (
      target === this || (target.parentElement !== null && this.contains(target.parentElement))
    );
  }
}

function moves(target: ScrollElement, timeline: ScrollElement, deltaY: number) {
  return gestureMovesTimeline(target, timeline as unknown as HTMLElement, deltaY);
}

/** A streaming timeline pinned at its end, holding a scrollable tool output body. */
function setup() {
  const timeline = Object.assign(new ScrollElement(), {
    overflowY: "auto",
    scrollHeight: 5000,
    clientHeight: 700,
    scrollTop: 4300,
  });
  const toolBody = Object.assign(new ScrollElement(new ScrollElement(timeline)), {
    overflowY: "auto",
    scrollHeight: 900,
    clientHeight: 300,
    scrollTop: 400,
  });
  return { timeline, toolBody, line: new ScrollElement(toolBody) };
}

beforeEach(() => {
  vi.stubGlobal("Element", ScrollElement);
  vi.stubGlobal("getComputedStyle", (element: ScrollElement) => element);
});
afterEach(() => vi.unstubAllGlobals());

describe("gestureMovesTimeline", () => {
  it("keeps following when a tool output body with room to scroll takes a wheel-up", () => {
    const { timeline, line } = setup();
    expect(moves(line, timeline, -120)).toBe(false);
  });

  it("keeps following when the body is at its top but contains its overscroll", () => {
    const { timeline, toolBody, line } = setup();
    toolBody.scrollTop = 0;
    toolBody.overscrollBehaviorY = "contain";
    expect(moves(line, timeline, -120)).toBe(false);
  });

  it("leaves on a wheel-up over the timeline's own content", () => {
    const { timeline } = setup();
    expect(moves(new ScrollElement(timeline), timeline, -120)).toBe(true);
    expect(moves(timeline, timeline, -1)).toBe(true);
  });

  it("does not return the reader on a wheel-down that a tool output body takes", () => {
    const { timeline, line } = setup();
    expect(moves(line, timeline, 120)).toBe(false);
  });

  it("never moves a timeline that cannot scroll", () => {
    const { timeline } = setup();
    timeline.scrollHeight = timeline.clientHeight;
    expect(moves(timeline, timeline, -120)).toBe(false);
    expect(moves(timeline, timeline, 120)).toBe(false);
  });
});

describe("useLeaveLiveEdgeOnScroll without scrollend", () => {
  // A browser window lacking `onscrollend`, as Safari has.
  const view = new EventTarget();
  const node = Object.assign(new ScrollElement(), {
    overflowY: "auto",
    scrollHeight: 5000,
    clientHeight: 700,
    scrollTop: 4300,
    ownerDocument: { defaultView: view, body: {}, documentElement: {} },
  });
  const list = {
    getScrollableNode: () => node,
    getState: () => ({
      contentLength: node.scrollHeight,
      scroll: node.scrollTop,
      scrollLength: node.clientHeight,
    }),
  };
  const listRef = createRef<LegendListRef>();
  Object.assign(listRef, { current: list });
  const onLeave = vi.fn();
  const onReturn = vi.fn();
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    useLeaveLiveEdgeOnScroll(listRef, true, onLeave, onReturn);
    return null;
  }
  const wheelUp = () =>
    node.dispatchEvent(Object.assign(new Event("wheel"), { deltaY: -100, ctrlKey: false }));
  const scrollTo = (top: number) => {
    node.scrollTop = top;
    node.dispatchEvent(new Event("scroll"));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    node.scrollTop = 4300;
    onLeave.mockClear();
    onReturn.mockClear();
    act(() => {
      renderer = create(createElement(Probe));
    });
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    vi.useRealTimers();
  });

  it("resumes following once a nudge pauses inside the follow band", () => {
    wheelUp();
    expect(onLeave).toHaveBeenCalled();
    scrollTo(4270);
    vi.advanceTimersByTime(100);
    expect(onReturn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("leaves a real scroll up where the reader put it", () => {
    wheelUp();
    scrollTo(3600);
    vi.advanceTimersByTime(500);
    expect(onReturn).not.toHaveBeenCalled();
    expect(node.scrollTop).toBe(3600);
  });

  it("puts back a real scroll up that a pin pulled down to the end", () => {
    wheelUp();
    scrollTo(3800);
    scrollTo(4300);
    vi.advanceTimersByTime(500);
    expect(onReturn).not.toHaveBeenCalled();
    expect(node.scrollTop).toBe(3800);
  });
});
