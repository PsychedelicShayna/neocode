import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

const STORAGE_KEY = "t3code:composer-body-height";
const MIN_HEIGHT = 64;
/** Share of the window the docked prompt may take; the conversation keeps the rest. */
const MAX_VIEWPORT_SHARE = 0.7;

function clampHeight(height: number): number {
  return Math.round(
    Math.min(Math.max(height, MIN_HEIGHT), window.innerHeight * MAX_VIEWPORT_SHARE),
  );
}

function readStoredHeight(): number | null {
  const value = Number(globalThis.localStorage?.getItem(STORAGE_KEY));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Height of the docked composer body. Unset, the body follows its draft between
 * a compact minimum and a viewport cap; dragging the dock's top edge pins a
 * height (kept across reloads) and double-clicking the edge returns to auto.
 */
export function useComposerBodyResize() {
  const [height, setHeight] = useState<number | null>(readStoredHeight);
  const drag = useRef<{ startY: number; startHeight: number; pointerId: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastPress = useRef(0);

  useEffect(() => {
    if (height === null) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, String(height));
  }, [height]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !bodyRef.current) return;
    event.preventDefault();
    // Pointer capture swallows dblclick in Chromium and pointer events carry no
    // click count, so a second press within the double-click window resets.
    if (event.timeStamp - lastPress.current < 400) {
      lastPress.current = 0;
      drag.current = null;
      setHeight(null);
      return;
    }
    lastPress.current = event.timeStamp;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      startY: event.clientY,
      startHeight: bodyRef.current.getBoundingClientRect().height,
      pointerId: event.pointerId,
    };
  }, []);
  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // The dock grows upward: dragging the edge up makes the prompt taller.
    setHeight(clampHeight(state.startHeight + state.startY - event.clientY));
  }, []);
  const onPointerUp = useCallback((event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      setHeight(null);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const measured = bodyRef.current?.getBoundingClientRect().height ?? MIN_HEIGHT;
    const delta = event.key === "ArrowUp" ? 16 : -16;
    setHeight((current) => clampHeight(clampHeight(current ?? measured) + delta));
  }, []);

  return {
    bodyRef,
    bodyStyle:
      height === null
        ? undefined
        : { height: clampHeight(height), maxHeight: `${MAX_VIEWPORT_SHARE * 100}dvh` },
    pinned: height !== null,
    handleProps: {
      tabIndex: 0,
      "aria-valuemin": MIN_HEIGHT,
      "aria-valuemax": Math.round(window.innerHeight * MAX_VIEWPORT_SHARE),
      "aria-valuenow": clampHeight(height ?? MIN_HEIGHT),
      "aria-valuetext": height === null ? "Fits the draft" : `${clampHeight(height)} pixels`,
      onKeyDown,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}
