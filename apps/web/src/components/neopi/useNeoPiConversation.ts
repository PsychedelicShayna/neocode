import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { NeoPiJournalPage, ScopedThreadRef } from "@t3tools/contracts";
import { createNeoPiConversationAtoms } from "@t3tools/client-runtime/state/neopi-conversation";
import { emptyNativeConversation, reduceNativeConversation, sameNativeSession } from "@t3tools/client-runtime/neopi-conversation";
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { neopiSessionJournal } from "../../state/neopiSessions";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

export const nativeConversationAtoms = createNeoPiConversationAtoms(connectionAtomRuntime);

export function useNeoPiConversation(threadRef: ScopedThreadRef) {
  const atom = nativeConversationAtoms.watch({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const read = useAtomCommand(neopiSessionJournal, { reportFailure: false });
  const [conversation, setConversation] = useState(emptyNativeConversation);
  const [paging, setPaging] = useState(false);
  const [pagingError, setPagingError] = useState<string | null>(null);
  const feed = AsyncResult.isSuccess(result) ? result.value : null;
  const sourceEntries = useRef<ReadonlyArray<NeoPiJournalPage["entries"][number]> | null>(null);
  const current = useRef(conversation);
  current.current = conversation;
  useEffect(() => {
    if (!feed) return;
    const unchangedEntries = sourceEntries.current === feed.conversation.entries;
    sourceEntries.current = feed.conversation.entries;
    setConversation((previous) => {
      const next = feed.conversation;
      if (!next.identity || next.needsSnapshot) return next;
      if (unchangedEntries && sameNativeSession(previous.identity, next.identity) &&
          previous.identity?.leafId === next.identity.leafId)
        return { ...previous, pending: next.pending, persisted: next.persisted, revision: next.revision };
      const merged = reduceNativeConversation(previous, { type: "snapshot", page: {
        ...next.identity, sessionFile: next.identity.sessionFile ?? "", entries: next.entries,
        totalEntries: next.entries.length, ...(next.cursor ? { nextCursor: next.cursor } : {}),
      } });
      const keepCursor = sameNativeSession(previous.identity, next.identity) &&
        previous.identity?.leafId === next.identity.leafId && previous.cursorLeaf === next.cursorLeaf;
      return { ...next, entries: merged.entries,
        ...(keepCursor ? { cursor: previous.cursor, cursorLeaf: previous.cursorLeaf } : {}) };
    });
  }, [feed]);
  const needsSnapshot = feed?.conversation.needsSnapshot === true;
  const refreshRevision = useRef(-1);
  useEffect(() => {
    if (!needsSnapshot || feed?.connection?.status !== "connected") return;
    const revision = feed.conversation.revision;
    if (refreshRevision.current === revision) return;
    refreshRevision.current = revision;
    refresh();
  }, [feed, needsSnapshot, refresh]);

  const loadOlder = useCallback(async () => {
    if (paging) return;
    const captured = current.current;
    if (!captured.identity) return;
    setPaging(true); setPagingError(null);
    try {
      let cursor = captured.cursor;
      const fetchPage = async (nextCursor: string | undefined): Promise<NeoPiJournalPage> => {
        const response = await read({ environmentId: threadRef.environmentId, input: {
          threadId: threadRef.threadId, scope: "branch", direction: "backward", limit: 100,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        } });
        if (response._tag === "Failure") {
          if (isAtomCommandInterrupted(response)) throw new Error("History request cancelled.");
          throw squashAtomCommandFailure(response);
        }
        if (response.value.status !== "available") throw new Error(response.value.status === "error" ? response.value.message : response.value.reason);
        return response.value.page;
      };
      // Branch cursors are leaf-bound. Obtain a new cursor after live appends.
      if (captured.cursorLeaf !== captured.identity.leafId) cursor = (await fetchPage(undefined)).nextCursor;
      if (!cursor) return;
      const page = await fetchPage(cursor);
      setConversation((state) => reduceNativeConversation({ ...state, cursorLeaf: captured.identity!.leafId }, {
        type: "older", page, revision: captured.revision,
      }));
    } catch (cause) {
      setPagingError(cause instanceof Error ? cause.message : "Could not load older native entries.");
    } finally { setPaging(false); }
  }, [paging, read, threadRef.environmentId, threadRef.threadId]);

  return { conversation, connection: feed?.connection ?? null, refresh, loadOlder, paging,
    error: AsyncResult.isFailure(result) ? formatEnvironmentQueryError(result.cause) : pagingError,
    loading: !feed, busy: feed?.busy ?? null };
}
