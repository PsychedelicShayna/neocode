import { useAtomValue } from "@effect/atom-react";
import {
  emptyNativeConversation,
  nativeIdentityKey,
  reduceNativeConversation,
  sameNativeSession,
  type NativeIdentity,
} from "@t3tools/client-runtime/neopi-conversation";
import {
  createNeoPiConversationAtoms,
  createNeoPiThreadObservationAtoms,
  threadObservationConnection,
} from "@t3tools/client-runtime/state/neopi-conversation";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type NeoPiJournalPage, type ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { nativeSessionAtoms } from "./neopiNativeSessions";
import { bindComposerDraftToNativeSession } from "./use-composer-drafts";
import { useAtomCommand } from "./use-atom-command";

export const nativeConversationAtoms = createNeoPiConversationAtoms(connectionAtomRuntime);
export const threadObservationAtoms = createNeoPiThreadObservationAtoms(
  connectionAtomRuntime,
  nativeSessionAtoms,
);
export const nativeJournalRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:neopi-journal:read",
  tag: WS_METHODS.neopiSessionsJournal,
});
export const nativeSessionDraftKey = (threadRef: ScopedThreadRef, identity: NativeIdentity) =>
  `${threadRef.environmentId}:native-${encodeURIComponent(nativeIdentityKey(identity))}`;

/**
 * The thread's transcript from the native session controller (attach only, never starting
 * an owner); mobile only owns paging, read-only history for a stopped session and draft binding.
 */
export function useNeoPiConversation(threadRef: ScopedThreadRef) {
  const observation = useAtomValue(threadObservationAtoms.observe(threadRef));
  const connection = threadObservationConnection(observation);
  const refresh = useCallback(
    () => threadObservationAtoms.refresh(appAtomRegistry, threadRef),
    [threadRef.environmentId, threadRef.threadId],
  );
  const read = useAtomCommand(nativeJournalRead, { reportFailure: false });
  const [conversation, setConversation] = useState(emptyNativeConversation);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceEntries = useRef<NeoPiJournalPage["entries"] | null>(null);
  const current = useRef(conversation);
  current.current = conversation;
  const pagingRef = useRef(false);
  const active = useRef(true);
  const feed = observation.feed;
  const stopped = connection?.ownership === "stopped";
  const live = stopped ? null : (feed?.conversation ?? null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!live) return;
    const unchanged = sourceEntries.current === live.entries;
    sourceEntries.current = live.entries;
    setConversation((previous) => {
      const next = live;
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
  }, [live]);
  // No owner runs the session: show its history read-only. The journal read never starts one.
  useEffect(() => {
    if (!stopped) return;
    let cancelled = false;
    void read({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, scope: "branch", direction: "backward", limit: 128 },
    }).then((response) => {
      if (cancelled || !active.current) return;
      if (response._tag === "Failure") {
        const failure = squashAtomCommandFailure(response);
        return setError(
          failure instanceof Error ? failure.message : "Could not read native history.",
        );
      }
      if (response.value.status !== "available")
        return setError(
          response.value.status === "error" ? response.value.message : response.value.reason,
        );
      const page = response.value.page;
      setConversation((state) => reduceNativeConversation(state, { type: "snapshot", page }));
    });
    return () => {
      cancelled = true;
    };
  }, [stopped, read, threadRef.environmentId, threadRef.threadId]);
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
    connection,
    busy: feed && !stopped ? feed.busy : null,
    loading: connection === null && observation.error === null,
    refresh,
    loadOlder,
    paging,
    error: observation.error ?? error,
  };
}
