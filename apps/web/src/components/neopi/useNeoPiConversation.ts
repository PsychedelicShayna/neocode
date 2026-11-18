import { useAtomValue } from "@effect/atom-react";
import type { NeoPiJournalPage, ScopedThreadRef } from "@t3tools/contracts";
import {
  createNeoPiConversationAtoms,
  createNeoPiThreadObservationAtoms,
  threadObservationConnection,
} from "@t3tools/client-runtime/state/neopi-conversation";
import {
  emptyNativeConversation,
  reduceNativeConversation,
  sameNativeSession,
} from "@t3tools/client-runtime/neopi-conversation";
import {
  findOlderNativePage,
  nativeOlderHistoryAvailable,
} from "@t3tools/client-runtime/neopi-thread-observation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { nativeSessionAtoms, usePageVisible } from "../../state/neopiNativeSessions";
import { neopiSessionJournal } from "../../state/neopiSessions";
import { useAtomCommand } from "../../state/use-atom-command";

export const nativeConversationAtoms = createNeoPiConversationAtoms(connectionAtomRuntime);
export const threadObservationAtoms = createNeoPiThreadObservationAtoms(
  connectionAtomRuntime,
  nativeSessionAtoms,
);

/**
 * The thread's native observation and its thread status. A mounted thread view is the
 * selected thread; it holds the attach-only lease while the document is visible (window
 * focus plays no part) and only the cached feed while hidden.
 */
export function useThreadNativeObservation(threadRef: ScopedThreadRef) {
  const observation = useAtomValue(threadObservationAtoms.observe(threadRef, usePageVisible()));
  return { observation, connection: threadObservationConnection(observation) };
}

export function useNeoPiConversation(threadRef: ScopedThreadRef) {
  const { observation, connection } = useThreadNativeObservation(threadRef);
  const refresh = useCallback(
    () => threadObservationAtoms.refresh(appAtomRegistry, threadRef),
    [threadRef.environmentId, threadRef.threadId],
  );
  const read = useAtomCommand(neopiSessionJournal, { reportFailure: false });
  const [conversation, setConversation] = useState(emptyNativeConversation);
  const [paging, setPaging] = useState(false);
  const [pagingError, setPagingError] = useState<string | null>(null);
  const feed = observation.feed;
  const history = connection?.history ?? null;
  const live = history === "live" ? (feed?.conversation ?? null) : null;
  const phase = feed?.observer.phase ?? null;
  const sourceEntries = useRef<ReadonlyArray<NeoPiJournalPage["entries"][number]> | null>(null);
  const current = useRef(conversation);
  current.current = conversation;
  // Nothing of another session is rendered or bound: the view only says the session changed.
  useEffect(() => {
    if (history !== "none") return;
    sourceEntries.current = null;
    setConversation(emptyNativeConversation());
  }, [history]);
  // A stop is re-read from the binding: whether NeoCode's own runtime still runs decides
  // between "stopped" and "control plane off".
  useEffect(() => {
    if (phase === "owner-stopped" || phase === "incompatible")
      threadObservationAtoms.refreshRef(appAtomRegistry, threadRef);
  }, [phase, threadRef.environmentId, threadRef.threadId]);
  useEffect(() => {
    if (!live) return;
    const unchangedEntries = sourceEntries.current === live.entries;
    sourceEntries.current = live.entries;
    setConversation((previous) => {
      const next = live;
      if (!next.identity || next.needsSnapshot) return next;
      if (
        unchangedEntries &&
        sameNativeSession(previous.identity, next.identity) &&
        previous.identity?.leafId === next.identity.leafId
      )
        return {
          ...previous,
          pending: next.pending,
          persisted: next.persisted,
          revision: next.revision,
        };
      const merged = reduceNativeConversation(previous, {
        type: "snapshot",
        page: {
          ...next.identity,
          sessionFile: next.identity.sessionFile ?? "",
          entries: next.entries,
          totalEntries: next.entries.length,
          ...(next.cursor ? { nextCursor: next.cursor } : {}),
        },
      });
      const keepCursor =
        sameNativeSession(previous.identity, next.identity) &&
        previous.identity?.leafId === next.identity.leafId &&
        previous.cursorLeaf === next.cursorLeaf;
      return {
        ...next,
        entries: merged.entries,
        ...(keepCursor ? { cursor: previous.cursor, cursorLeaf: previous.cursorLeaf } : {}),
      };
    });
  }, [live]);

  const fetchPage = useCallback(
    async (nextCursor: string | undefined, limit: number): Promise<NeoPiJournalPage> => {
      const response = await read({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          scope: "branch",
          direction: "backward",
          limit,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        },
      });
      if (response._tag === "Failure") {
        if (isAtomCommandInterrupted(response)) throw new Error("History request cancelled.");
        throw squashAtomCommandFailure(response);
      }
      if (response.value.status !== "available")
        throw new Error(
          response.value.status === "error" ? response.value.message : response.value.reason,
        );
      return response.value.page;
    },
    [read, threadRef.environmentId, threadRef.threadId],
  );

  // No owner can be observed: show the session's history read-only. The journal read never
  // starts an owner.
  useEffect(() => {
    if (history !== "read-only") return;
    let cancelled = false;
    fetchPage(undefined, 128).then(
      (page) => {
        if (!cancelled)
          setConversation((state) => reduceNativeConversation(state, { type: "snapshot", page }));
      },
      (cause: unknown) => {
        if (!cancelled)
          setPagingError(cause instanceof Error ? cause.message : "Could not read native history.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [history, fetchPage]);

  const loadOlder = useCallback(async () => {
    if (paging) return;
    const captured = current.current;
    if (!captured.identity) return;
    setPaging(true);
    setPagingError(null);
    try {
      const page = await findOlderNativePage(captured, (cursor) => fetchPage(cursor, 100));
      if (!page) return;
      setConversation((state) =>
        reduceNativeConversation(
          { ...state, cursorLeaf: captured.identity!.leafId },
          { type: "older", page, revision: captured.revision },
        ),
      );
    } catch (cause) {
      setPagingError(
        cause instanceof Error ? cause.message : "Could not load older native entries.",
      );
    } finally {
      setPaging(false);
    }
  }, [paging, fetchPage]);

  return {
    conversation,
    connection,
    refresh,
    loadOlder,
    olderAvailable: nativeOlderHistoryAvailable(conversation),
    paging,
    error: observation.error ?? pagingError,
    loading: connection === null && observation.error === null,
    busy: feed && history === "live" ? feed.busy : null,
  };
}
