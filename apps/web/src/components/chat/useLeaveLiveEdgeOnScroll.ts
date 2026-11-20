import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, type RefObject } from "react";
import {
  resolveTimelineIsAtEnd,
  scrollMovedAwayFromEnd,
  settleUpwardGesture,
} from "./MessagesTimeline.logic";
import type { PageScrollKey } from "./pageScrollController";
import { isTimelineScrollTarget } from "./timelineScrollTarget";

const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const SCROLL_DOWN_KEYS = new Set(["ArrowDown", "PageDown", "End"]);
/** Finger travel that is a drag rather than a tap. */
const TOUCH_SLOP_PX = 8;
/** Without `scrollend` (Safari has lacked it), this pause in scrolling settles a gesture. */
const SCROLL_SETTLE_MS = 150;
const TIMELINE_PAGE_SCROLL_START = "timeline-page-scroll-start";

/** A composer page key that the page scroll controller routed to this list. */
export function notifyTimelinePageScroll(node: HTMLElement, key: PageScrollKey): void {
  node.dispatchEvent(new CustomEvent(TIMELINE_PAGE_SCROLL_START, { detail: key }));
}

/**
 * A gesture on `target` that scrolls the timeline itself in the direction of
 * `deltaY` (negative: up). A scroller nested in it (a tool output, a code
 * block) that takes the gesture leaves the timeline alone.
 */
export function gestureMovesTimeline(
  target: EventTarget | null,
  timeline: HTMLElement,
  deltaY: number,
): boolean {
  return (
    timeline.scrollHeight > timeline.clientHeight &&
    isTimelineScrollTarget(target, timeline, deltaY)
  );
}

/**
 * Tells the host when the reader leaves the timeline's live edge and when they
 * come back to it, read from the reader's own input: wheel, touchpad,
 * scrollbar, touch, keys, a composer page key, or a selection drag. The list
 * keeps re-pinning to the end while follow is on, so a host that never hears
 * about the gesture fights every scroll up.
 *
 * Scroll positions alone never decide: the list moves scrollTop itself when it
 * pins, corrects a row estimate or the window resizes. An upward gesture stops
 * follow at once; when its scrolling settles, a nudge that stayed in the follow
 * band resumes it (`settleUpwardGesture`). A downward gesture that brings the
 * view into the band resumes it too. A pin or a layout change never does.
 */
export function useLeaveLiveEdgeOnScroll(
  listRef: RefObject<LegendListRef | null>,
  following: boolean,
  onLeave: () => void,
  onReturn: () => void,
): void {
  const followingRef = useRef(following);
  useEffect(() => {
    followingRef.current = following;
  }, [following]);
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
        // The native scroll event can run before LegendList updates its own
        // offset. A final End/wheel event might be the only event at the edge.
        const atEnd = () =>
          resolveTimelineIsAtEnd({
            contentLength: node.scrollHeight,
            scroll: node.scrollTop,
            scrollLength: node.clientHeight,
          }) === true;
        let previousTop = node.scrollTop;
        let pointerHeld = false;
        let scrollbarHeld = false;
        let touchY: number | null = null;
        /** The open upward gesture, until its scrolling settles. */
        let upward: { startedFollowing: boolean; startTop: number; highestTop: number } | null =
          null;
        /** The reader's last input moved toward the end; reaching the band resumes. */
        let returning = false;
        const up = () => {
          returning = false;
          upward ??= {
            startedFollowing: followingRef.current,
            startTop: node.scrollTop,
            highestTop: node.scrollTop,
          };
          onLeave();
        };
        const down = () => {
          upward = null;
          returning = true;
          // Already in the band, a downward input scrolls nothing to report.
          if (atEnd()) {
            returning = false;
            onReturn();
          }
        };
        // Detected once per list: Safari has lacked `scrollend`.
        const scrollEndSupported = "onscrollend" in view;
        let settleTimer: ReturnType<typeof setTimeout> | undefined;
        const onScroll = () => {
          const top = node.scrollTop;
          const movedDown = top > previousTop;
          if (upward) upward.highestTop = Math.min(upward.highestTop, top);
          if (
            scrollMovedAwayFromEnd({
              previousTop,
              top,
              isAtEnd: resolveTimelineIsAtEnd(listRef.current?.getState()),
              byUser: pointerHeld,
            })
          )
            onLeave();
          previousTop = top;
          if (!scrollEndSupported && upward) {
            clearTimeout(settleTimer);
            settleTimer = setTimeout(onScrollEnd, SCROLL_SETTLE_MS);
          }
          if (returning && movedDown && atEnd()) {
            returning = false;
            onReturn();
          }
        };
        const onScrollEnd = () => {
          // A pin already in flight can settle before the reader's own scroll
          // moves the view; only a settle after the reader moved it up counts.
          if (!upward || scrollbarHeld || upward.highestTop >= upward.startTop) return;
          const outcome = settleUpwardGesture({ ...upward, top: node.scrollTop });
          upward = null;
          if (outcome.kind === "resume") onReturn();
          else if (outcome.kind === "restore") node.scrollTop = outcome.top;
        };
        const onWheel = (event: WheelEvent) => {
          if (event.ctrlKey || !gestureMovesTimeline(event.target, node, event.deltaY)) return;
          if (event.deltaY < 0) up();
          else down();
        };
        // Only the scrollbar puts a pointerdown on the scroll node itself.
        const onPointerDown = (event: PointerEvent) => {
          if (event.target !== node) {
            pointerHeld = true;
            return;
          }
          if (node.scrollHeight <= node.clientHeight) return;
          scrollbarHeld = true;
          returning = false;
          upward = null;
          onLeave();
        };
        const onPointerUp = () => {
          pointerHeld = false;
          if (!scrollbarHeld) return;
          scrollbarHeld = false;
          // Releasing the thumb in the band is coming back; anywhere else stays.
          if (atEnd()) onReturn();
        };
        const onTouchStart = (event: TouchEvent) => {
          touchY = event.touches[0]?.clientY ?? null;
        };
        // A finger moving down drags the content toward older rows.
        const onTouchMove = (event: TouchEvent) => {
          const y = event.touches[0]?.clientY;
          if (touchY === null || y === undefined || Math.abs(y - touchY) <= TOUCH_SLOP_PX) return;
          const deltaY = touchY - y;
          touchY = null;
          if (!gestureMovesTimeline(event.target, node, deltaY)) return;
          if (deltaY < 0) up();
          else down();
        };
        const onPageScrollStart = (event: Event) => {
          if ((event as CustomEvent<PageScrollKey>).detail === "PageUp") {
            // Each frame writes scrollTop and may emit its own scrollend.
            // This is a deliberate page navigation, not a small wheel nudge.
            returning = false;
            upward = null;
            onLeave();
          } else {
            down();
          }
        };
        // Page keys scroll the timeline when it or the page has focus.
        const onKeyDown = (event: KeyboardEvent) => {
          if (
            event.defaultPrevented ||
            event.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          )
            return;
          const target = event.target;
          const editable =
            target instanceof Element &&
            target.closest("input, textarea, [contenteditable=true]") !== null;
          const onPage =
            target === node.ownerDocument.body || target === node.ownerDocument.documentElement;
          const isUp = SCROLL_UP_KEYS.has(event.key);
          if (
            editable ||
            (!isUp && !SCROLL_DOWN_KEYS.has(event.key)) ||
            !gestureMovesTimeline(onPage ? node : target, node, isUp ? -1 : 1)
          )
            return;
          if (isUp) up();
          else down();
        };
        // A release outside the window never arrives.
        const onBlur = () => {
          pointerHeld = false;
          scrollbarHeld = false;
        };
        node.addEventListener("scroll", onScroll, { passive: true });
        node.addEventListener("scrollend", onScrollEnd);
        node.addEventListener("wheel", onWheel, { passive: true });
        node.addEventListener("pointerdown", onPointerDown, { passive: true });
        node.addEventListener("touchstart", onTouchStart, { passive: true });
        node.addEventListener("touchmove", onTouchMove, { passive: true });
        node.addEventListener(TIMELINE_PAGE_SCROLL_START, onPageScrollStart);
        view.addEventListener("pointerup", onPointerUp);
        view.addEventListener("pointercancel", onPointerUp);
        view.addEventListener("keydown", onKeyDown);
        view.addEventListener("blur", onBlur);
        detach = () => {
          node.removeEventListener("scroll", onScroll);
          clearTimeout(settleTimer);
          node.removeEventListener("scrollend", onScrollEnd);
          node.removeEventListener("wheel", onWheel);
          node.removeEventListener("pointerdown", onPointerDown);
          node.removeEventListener("touchstart", onTouchStart);
          node.removeEventListener("touchmove", onTouchMove);
          node.removeEventListener(TIMELINE_PAGE_SCROLL_START, onPageScrollStart);
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
  }, [listRef, onLeave, onReturn]);
}
