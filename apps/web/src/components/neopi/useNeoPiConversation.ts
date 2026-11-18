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
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { nativeSessionAtoms } from "../../state/neopiNativeSessions";
import { neopiSessionJournal } from "../../state/neopiSessions";
import { useAtomCommand } from "../../state/use-atom-command";

export const nativeConversationAtoms = createNeoPiConversationAtoms(connectionAtomRuntime);
export const threadObservationAtoms = createNeoPiThreadObservationAtoms(
  connectionAtomRuntime,
  nativeSessionAtoms,
);

/** The thread's native observation and its thread status; mounting it holds the attach-only watch. */
export function useThreadNativeObservation(threadRef: ScopedThreadRef) {
  const observation = useAtomValue(threadObservationAtoms.observe(threadRef));
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
  const stopped = connection?.ownership === "stopped";
  const live = stopped ? null : (feed?.conversation ?? null);
  const sourceEntries = useRef<ReadonlyArray<NeoPiJournalPage["entries"][number]> | null>(null);
  const current = useRef(conversation);
  current.current = conversation;
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

  // No owner runs the session: show its history read-only. The journal read never starts one.
  useEffect(() => {
    if (!stopped) return;
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
  }, [stopped, fetchPage]);

  const loadOlder = useCallback(async () => {
    if (paging) return;
    const captured = current.current;
    if (!captured.identity) return;
    setPaging(true);
    setPagingError(null);
    try {
      let cursor = captured.cursor;
      // Branch cursors are leaf-bound. Obtain a new cursor after live appends.
      if (captured.cursorLeaf !== captured.identity.leafId)
        cursor = (await fetchPage(undefined, 100)).nextCursor;
      if (!cursor) return;
      const page = await fetchPage(cursor, 100);
      setConversation((state) =>
        reduceNativeConversation(
          { ...state, cursorLeaf: captured.identity!.leafId },
          {
            type: "older",
            page,
            revision: captured.revision,
          },
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
    paging,
    error: observation.error ?? pagingError,
    loading: connection === null,
    busy: feed && !stopped ? feed.busy : null,
  };
}
