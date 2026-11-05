import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, type RefObject } from "react";
import { resolveTimelineIsAtEnd, scrollMovedAwayFromEnd } from "./MessagesTimeline.logic";

/**
 * Calls `onLeave` when the reader scrolls the timeline up and off its live
 * edge, by any route: wheel, touch, scrollbar, keys, or a composer page key.
 * The list keeps re-pinning to the end while follow is on, so without this a
 * host that never hears about the gesture fights every scroll up.
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
        let previousTop = node.scrollTop;
        const onScroll = () => {
          const top = node.scrollTop;
          const left = scrollMovedAwayFromEnd({
            previousTop,
            top,
            isAtEnd: resolveTimelineIsAtEnd(listRef.current?.getState()),
          });
          previousTop = top;
          if (left) onLeave();
        };
        node.addEventListener("scroll", onScroll, { passive: true });
        detach = () => node.removeEventListener("scroll", onScroll);
      });
    };
    attach(12);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      detach?.();
    };
  }, [listRef, onLeave]);
}
