import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, type RefObject } from "react";
import { resolveTimelineIsAtEnd, scrollMovedAwayFromEnd } from "./MessagesTimeline.logic";
import { isTimelineScrollTarget } from "./timelineScrollTarget";

const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
/** Finger travel that is a drag rather than a tap. */
const TOUCH_SLOP_PX = 8;

/**
 * An upward gesture (`deltaY` < 0) on `target` that moves the timeline itself.
 * A scroller nested in it (a tool output, a code block) that takes the gesture
 * keeps the timeline following.
 */
export function upwardGestureLeavesTimeline(
  target: EventTarget | null,
  timeline: HTMLElement,
  deltaY: number,
): boolean {
  return (
    deltaY < 0 &&
    timeline.scrollHeight > timeline.clientHeight &&
    isTimelineScrollTarget(target, timeline, deltaY)
  );
}

/**
 * Calls `onLeave` when the reader moves the timeline up and off its live edge:
 * wheel, touchpad, scrollbar, touch, keys, a composer page key, or a text
 * selection that drags the view. The list keeps re-pinning to the end while
 * follow is on, so without this a host that never hears about the gesture
 * fights every scroll up.
 *
 * Leaving is read from the reader's input, never from scroll positions alone:
 * the list lowers scrollTop on its own when it corrects a row estimate or the
 * window resizes. The one position check left is a selection drag, counted
 * only while the pointer is held down on the content. Following resumes when
 * the host sees the reader back at the end, never because new output arrives.
 */
export function useLeaveLiveEdgeOnScroll(
  listRef: RefObject<LegendListRef | null>,
  onLeave: () => void,
): void {
  useEffect(() => {
    let frame: number | null = null;
    let detach: (() => void) | null = null;
    const attach = (remainingAttempts: number) => {
      frame = requestAnimationFrame(() => {
        frame = null;
        const node = listRef.current?.getScrollableNode();
        if (!node) {
          // The list may not have mounted on the first frame.
          if (remainingAttempts > 0) attach(remainingAttempts - 1);
          return;
        }
        const view = node.ownerDocument.defaultView ?? window;
        let previousTop = node.scrollTop;
        let pointerHeld = false;
        let touchStartY: number | null = null;
        const onScroll = () => {
          const top = node.scrollTop;
          const left = scrollMovedAwayFromEnd({
            previousTop,
            top,
            isAtEnd: resolveTimelineIsAtEnd(listRef.current?.getState()),
            byUser: pointerHeld,
          });
          previousTop = top;
          if (left) onLeave();
        };
        const onWheel = (event: WheelEvent) => {
          if (!event.ctrlKey && upwardGestureLeavesTimeline(event.target, node, event.deltaY))
            onLeave();
        };
        // Only the scrollbar puts a pointerdown on the scroll node itself.
        const onPointerDown = (event: PointerEvent) => {
          if (event.target === node) {
            if (node.scrollHeight > node.clientHeight) onLeave();
            return;
          }
          pointerHeld = true;
        };
        const onPointerUp = () => {
          pointerHeld = false;
        };
        const onTouchStart = (event: TouchEvent) => {
          touchStartY = event.touches[0]?.clientY ?? null;
        };
        // A finger moving down drags the content down, toward older rows.
        const onTouchMove = (event: TouchEvent) => {
          const y = event.touches[0]?.clientY;
          if (touchStartY === null || y === undefined || y <= touchStartY + TOUCH_SLOP_PX) return;
          const deltaY = touchStartY - y;
          touchStartY = null;
          if (upwardGestureLeavesTimeline(event.target, node, deltaY)) onLeave();
        };
        // Up keys scroll the timeline when it or the page has focus; the
        // composer claims (prevents) a PageUp it forwards to the timeline.
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          const target = event.target;
          const editable =
            target instanceof Element &&
            target.closest("input, textarea, [contenteditable=true]") !== null;
          // A composer PageUp scrolls the timeline as a whole, as does an up
          // key with focus on the page itself.
          const onPage =
            target === node.ownerDocument.body || target === node.ownerDocument.documentElement;
          const scrolled = editable
            ? event.key === "PageUp" && event.defaultPrevented
            : SCROLL_UP_KEYS.has(event.key);
          if (scrolled && upwardGestureLeavesTimeline(editable || onPage ? node : target, node, -1))
            onLeave();
        };
        // A release outside the window never arrives.
        const onBlur = () => {
          pointerHeld = false;
        };
        node.addEventListener("scroll", onScroll, { passive: true });
        node.addEventListener("wheel", onWheel, { passive: true });
        node.addEventListener("pointerdown", onPointerDown, { passive: true });
        node.addEventListener("touchstart", onTouchStart, { passive: true });
        node.addEventListener("touchmove", onTouchMove, { passive: true });
        view.addEventListener("pointerup", onPointerUp);
        view.addEventListener("pointercancel", onPointerUp);
        view.addEventListener("keydown", onKeyDown);
        view.addEventListener("blur", onBlur);
        detach = () => {
          node.removeEventListener("scroll", onScroll);
          node.removeEventListener("wheel", onWheel);
          node.removeEventListener("pointerdown", onPointerDown);
          node.removeEventListener("touchstart", onTouchStart);
          node.removeEventListener("touchmove", onTouchMove);
          view.removeEventListener("pointerup", onPointerUp);
          view.removeEventListener("pointercancel", onPointerUp);
          view.removeEventListener("keydown", onKeyDown);
          view.removeEventListener("blur", onBlur);
        };
      });
    };
    attach(12);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      detach?.();
    };
  }, [listRef, onLeave]);
}
