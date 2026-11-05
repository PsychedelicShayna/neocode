import {
  nativeRecord,
  type NativeSessionFeed,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import type {
  ComposerDictationAnchor,
  ComposerDictationControl,
} from "../chat/composerDictation.logic";

type Request = (command: Record<string, unknown> & { type: string }) => Promise<unknown>;

interface Capture {
  readonly captureId: string;
  readonly anchor: ComposerDictationAnchor;
  /** Stop was requested; the transcript is flushing. */
  stopping: boolean;
  /** Escape: stop the microphone but keep the draft untouched. */
  discard: boolean;
}

const message = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "message" in cause &&
  typeof cause.message === "string"
    ? cause.message
    : String(cause);

/**
 * One NeoPi microphone capture feeding the composer draft. NeoPi records on the
 * machine that runs it and never submits; this inserts the final text at the
 * cursor the capture started from. Whichever of NeoPi's `dictation_end` frame
 * and the `dictation_stop` reply lands first finishes the capture.
 */
export function useNativeDictation(input: {
  readonly feed: Pick<NativeSessionFeed, "dictation">;
  readonly request: Request;
  readonly composerRef: { readonly current: ChatComposerHandle | null };
}): ComposerDictationControl {
  const { feed, request, composerRef } = input;
  const [capture, setCapture] = useState<Capture | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const previewRef = useRef<{ captureId: string; text: string } | null>(null);
  previewRef.current = feed.dictation;

  const settle = useCallback(
    (captureId: string, text: string, error: string | null) => {
      const current = captureRef.current;
      if (current?.captureId !== captureId) return;
      captureRef.current = null;
      setCapture(null);
      if (error) setNotice(error);
      if (!current.discard && text.trim())
        composerRef.current?.insertDictation(text, current.anchor);
    },
    [composerRef],
  );

  const stop = useCallback(
    (discard: boolean) => {
      const current = captureRef.current;
      if (!current) return;
      // Escape still discards while the transcript is flushing.
      if (discard) current.discard = true;
      if (current.stopping) return;
      current.stopping = true;
      setCapture({ ...current });
      const { captureId } = current;
      void requestRef
        .current({ type: "dictation_stop" })
        .then((result) => settle(captureId, String(nativeRecord(result).text ?? ""), null))
        .catch((cause) =>
          settle(
            captureId,
            previewRef.current?.captureId === captureId ? previewRef.current.text : "",
            message(cause),
          ),
        );
    },
    [settle],
  );

  const toggle = useCallback(() => {
    if (captureRef.current) {
      stop(false);
      return;
    }
    const snapshot = composerRef.current?.readSnapshot();
    const started: Capture = {
      captureId: randomUUID(),
      anchor: {
        prompt: snapshot?.value ?? "",
        cursor: snapshot?.expandedCursor ?? snapshot?.value.length ?? 0,
      },
      stopping: false,
      discard: false,
    };
    captureRef.current = started;
    setCapture(started);
    setNotice(null);
    void requestRef
      .current({ type: "dictation_start", captureId: started.captureId })
      .catch((cause) => {
        // A stop that cancelled the pending start settles through its own reply.
        if (captureRef.current !== started || started.stopping) return;
        captureRef.current = null;
        setCapture(null);
        setNotice(message(cause));
      });
  }, [composerRef, stop]);

  // NeoPi ended the capture itself: an error, or a stop from another window.
  const observed = feed.dictation;
  useEffect(() => {
    if (capture && observed?.captureId === capture.captureId && observed.phase === "ended")
      settle(observed.captureId, observed.text, observed.error);
  }, [capture, observed, settle]);

  useEffect(() => {
    if (!capture) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      stop(true);
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [capture, stop]);

  // Leaving the session must never leave the microphone open.
  useEffect(
    () => () => {
      if (!captureRef.current) return;
      captureRef.current = null;
      void requestRef.current({ type: "dictation_stop" }).catch(() => undefined);
    },
    [],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);
  const live = capture && observed?.captureId === capture.captureId ? observed : null;
  const phase = !capture
    ? "idle"
    : capture.stopping || live?.phase === "transcribing"
      ? "transcribing"
      : live?.phase === "recording"
        ? "recording"
        : "starting";
  const preview = live?.text ?? "";
  // The composer takes this as a prop: a stable identity keeps it from re-rendering
  // on every feed update that leaves the capture unchanged.
  return useMemo(
    () => ({ phase, preview, notice, toggle, dismissNotice }),
    [phase, preview, notice, toggle, dismissNotice],
  );
}
