import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  emptyNativeConversation,
  nativeIdentityKey,
  reduceNativeConversation,
  sameNativeSession,
  type NativeIdentity,
} from "@t3tools/client-runtime/neopi-conversation";
import { createNeoPiConversationAtoms } from "@t3tools/client-runtime/state/neopi-conversation";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type NeoPiJournalPage, type ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { scopedThreadKey } from "../lib/scopedEntities";
import { bindComposerDraftToNativeSession } from "./use-composer-drafts";
import { useAtomCommand } from "./use-atom-command";

export const nativeConversationAtoms = createNeoPiConversationAtoms(connectionAtomRuntime);
export const nativeJournalRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:neopi-journal:read",
  tag: WS_METHODS.neopiSessionsJournal,
});
export const nativeSessionDraftKey = (threadRef: ScopedThreadRef, identity: NativeIdentity) =>
  `${threadRef.environmentId}:native-${encodeURIComponent(nativeIdentityKey(identity))}`;

/** The shared reducer folds every native frame before React; mobile only owns paging and draft binding. */
export function useNeoPiConversation(threadRef: ScopedThreadRef) {
  const atom = nativeConversationAtoms.watch({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const read = useAtomCommand(nativeJournalRead, { reportFailure: false });
  const [conversation, setConversation] = useState(emptyNativeConversation);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceEntries = useRef<NeoPiJournalPage["entries"] | null>(null);
  const current = useRef(conversation);
  current.current = conversation;
  const pagingRef = useRef(false);
  const active = useRef(true);
  const feed = AsyncResult.isSuccess(result) ? result.value : null;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!feed) return;
    const unchanged = sourceEntries.current === feed.conversation.entries;
    sourceEntries.current = feed.conversation.entries;
    setConversation((previous) => {
      const next = feed.conversation;
      if (!next.identity || next.needsSnapshot) return next;
      if (
        unchanged &&
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
  }, [feed]);
  const refreshRevision = useRef(-1);
  useEffect(() => {
    if (
      !feed?.conversation.needsSnapshot ||
      feed.connection?.status !== "connected" ||
      refreshRevision.current === feed.conversation.revision
    )
      return;
    refreshRevision.current = feed.conversation.revision;
    refresh();
  }, [feed, refresh]);
  const identityKey = conversation.identity
    ? nativeSessionDraftKey(threadRef, conversation.identity)
    : null;
  useEffect(() => {
    if (!identityKey) return;
    void bindComposerDraftToNativeSession(
      scopedThreadKey(threadRef.environmentId, threadRef.threadId),
      identityKey,
    ).catch((cause) => {
      if (active.current)
        setError(
          cause instanceof Error ? cause.message : "The native draft could not be restored.",
        );
    });
  }, [identityKey, threadRef.environmentId, threadRef.threadId]);
  const loadOlder = useCallback(async () => {
    if (pagingRef.current) return;
    const captured = current.current;
    if (!captured.identity) return;
    pagingRef.current = true;
    setPaging(true);
    setError(null);
    try {
      const fetchPage = async (cursor: string | undefined): Promise<NeoPiJournalPage> => {
        const response = await read({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            scope: "branch",
            direction: "backward",
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
        });
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
        if (response.value.status !== "available")
          throw new Error(
            response.value.status === "error" ? response.value.message : response.value.reason,
          );
        return response.value.page;
      };
      const applyPage = (page: NeoPiJournalPage) => {
        if (!active.current) return;
        setConversation((state) => {
          if (
            state.revision !== captured.revision ||
            !sameNativeSession(state.identity, captured.identity!) ||
            state.identity?.leafId !== captured.identity!.leafId ||
            state.needsSnapshot
          )
            return state;
          return reduceNativeConversation(
            { ...state, cursorLeaf: captured.identity!.leafId },
            { type: "older", page, revision: captured.revision },
          );
        });
      };
      let cursor = captured.cursor;
      if (captured.cursorLeaf !== captured.identity.leafId) {
        const first = await fetchPage(undefined);
        applyPage(first);
        cursor = first.nextCursor;
      }
      if (!cursor || !active.current) return;
      const page = await fetchPage(cursor);
      applyPage(page);
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : "Could not read older native entries.");
    } finally {
      pagingRef.current = false;
      if (active.current) setPaging(false);
    }
  }, [read, threadRef.environmentId, threadRef.threadId]);
  return {
    conversation,
    connection: feed?.connection ?? null,
    busy: feed?.busy ?? null,
    loading: !feed && !AsyncResult.isFailure(result),
    refresh,
    loadOlder,
    paging,
    error: AsyncResult.isFailure(result) ? String(Cause.squash(result.cause)) : error,
  };
}
