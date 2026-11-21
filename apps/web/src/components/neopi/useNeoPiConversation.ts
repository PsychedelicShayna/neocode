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
  type NativeConversation,
} from "@t3tools/client-runtime/neopi-conversation";
import {
  findOlderNativePage,
  mergeThreadConversation,
  nativeOlderHistoryAvailable,
  readOnlyThreadConversation,
} from "@t3tools/client-runtime/neopi-thread-observation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { nativeSessionAtoms, usePageVisible } from "../../state/neopiNativeSessions";
import { neopiSessionJournal } from "../../state/neopiSessions";
import { useAtomCommand } from "../../state/use-atom-command";

export const nativeConversationAtoms = createNeoPiConversationAtoms(connectionAtomRuntime);
const threadObservationAtoms = createNeoPiThreadObservationAtoms(
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
  const { environmentId, threadId } = threadRef;
  const { observation, connection } = useThreadNativeObservation(threadRef);
  const refresh = useCallback(
    () => threadObservationAtoms.refresh(appAtomRegistry, { environmentId, threadId }),
    [environmentId, threadId],
  );
  const read = useAtomCommand(neopiSessionJournal, { reportFailure: false });
  /** The conversation the last older page was joined into; the view derives from it. */
  const [paged, setPaged] = useState<NativeConversation | null>(null);
  const [readOnlyPage, setReadOnlyPage] = useState<NeoPiJournalPage | null>(null);
  const [paging, setPaging] = useState(false);
  const [pagingError, setPagingError] = useState<string | null>(null);
  const feed = observation.feed;
  const history = connection?.history ?? null;
  const phase = feed?.observer.phase ?? null;
  // Derived during render. Nothing of another session is rendered or bound: with history
  // "none" the view shows nothing, and paged history joins only the same session.
  const conversation = useMemo(() => {
    if (history === "live" && feed) return mergeThreadConversation(paged, feed.conversation);
    if (history === "read-only")
      return mergeThreadConversation(paged, readOnlyThreadConversation(readOnlyPage));
    return emptyNativeConversation();
  }, [history, feed, paged, readOnlyPage]);
  // A stop is re-read from the binding: whether NeoCode's own runtime still runs decides
  // between "stopped" and "control plane off".
  useEffect(() => {
    if (phase === "owner-stopped" || phase === "incompatible")
      threadObservationAtoms.refreshRef(appAtomRegistry, { environmentId, threadId });
  }, [phase, environmentId, threadId]);

  const fetchPage = useCallback(
    async (nextCursor: string | undefined, limit: number): Promise<NeoPiJournalPage> => {
      const response = await read({
        environmentId,
        input: {
          threadId,
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
    [read, environmentId, threadId],
  );

  // No owner can be observed: read the session's history once, read-only. The journal read
  // never starts an owner.
  useEffect(() => {
    if (history !== "read-only") return;
    let cancelled = false;
    fetchPage(undefined, 128).then(
      (page) => {
        if (!cancelled) setReadOnlyPage(page);
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
    if (paging || !conversation.identity) return;
    const captured = conversation;
    const leafId = conversation.identity.leafId;
    setPaging(true);
    setPagingError(null);
    try {
      const page = await findOlderNativePage(captured, (cursor) => fetchPage(cursor, 100));
      if (!page) return;
      setPaged(
        reduceNativeConversation(
          { ...captured, cursorLeaf: leafId },
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
  }, [paging, conversation, fetchPage]);

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
    runPaused: feed !== null && history === "live" && feed.runPause !== null,
  };
}
