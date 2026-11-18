import { useAtomValue } from "@effect/atom-react";
import {
  emptyNativeConversation,
  nativeIdentityKey,
  reduceNativeConversation,
  type NativeConversation,
  type NativeIdentity,
} from "@t3tools/client-runtime/neopi-conversation";
import {
  findOlderNativePage,
  mergeThreadConversation,
  nativeOlderHistoryAvailable,
  readOnlyThreadConversation,
} from "@t3tools/client-runtime/neopi-thread-observation";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { nativeSessionAtoms, useScreenVisible } from "./neopiNativeSessions";
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
  const { environmentId, threadId } = threadRef;
  const observation = useAtomValue(
    threadObservationAtoms.observe({ environmentId, threadId }, useScreenVisible()),
  );
  const connection = threadObservationConnection(observation);
  const refresh = useCallback(
    () => threadObservationAtoms.refresh(appAtomRegistry, { environmentId, threadId }),
    [environmentId, threadId],
  );
  const read = useAtomCommand(nativeJournalRead, { reportFailure: false });
  /** The conversation the last older page was joined into; the view derives from it. */
  const [paged, setPaged] = useState<NativeConversation | null>(null);
  const [readOnlyPage, setReadOnlyPage] = useState<NeoPiJournalPage | null>(null);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pagingRef = useRef(false);
  const active = useRef(true);
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
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  // A stop is re-read from the binding: whether NeoCode's own runtime still runs decides
  // between "stopped" and "control plane off".
  useEffect(() => {
    if (phase === "owner-stopped" || phase === "incompatible")
      threadObservationAtoms.refreshRef(appAtomRegistry, { environmentId, threadId });
  }, [phase, environmentId, threadId]);
  const fetchPage = useCallback(
    async (cursor: string | undefined, limit: number): Promise<NeoPiJournalPage> => {
      const response = await read({
        environmentId,
        input: {
          threadId,
          scope: "branch",
          direction: "backward",
          limit,
          ...(cursor ? { cursor } : {}),
        },
      });
      if (response._tag === "Failure") {
        const failure = squashAtomCommandFailure(response);
        throw failure instanceof Error ? failure : new Error("Could not read native history.");
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
          setError(cause instanceof Error ? cause.message : "Could not read native history.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [history, fetchPage]);
  const identityKey = conversation.identity
    ? nativeSessionDraftKey(threadRef, conversation.identity)
    : null;
  useEffect(() => {
    if (!identityKey) return;
    void bindComposerDraftToNativeSession(
      scopedThreadKey(environmentId, threadId),
      identityKey,
    ).catch((cause) => {
      if (active.current)
        setError(
          cause instanceof Error ? cause.message : "The native draft could not be restored.",
        );
    });
  }, [identityKey, environmentId, threadId]);
  const loadOlder = useCallback(async () => {
    if (pagingRef.current || !conversation.identity) return;
    const captured = conversation;
    const leafId = conversation.identity.leafId;
    pagingRef.current = true;
    setPaging(true);
    setError(null);
    try {
      const page = await findOlderNativePage(captured, (cursor) => fetchPage(cursor, 100));
      if (page && active.current)
        setPaged(
          reduceNativeConversation(
            { ...captured, cursorLeaf: leafId },
            { type: "older", page, revision: captured.revision },
          ),
        );
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : "Could not read older native entries.");
    } finally {
      pagingRef.current = false;
      if (active.current) setPaging(false);
    }
  }, [conversation, fetchPage]);
  return {
    conversation,
    connection,
    busy: feed && history === "live" ? feed.busy : null,
    olderAvailable: nativeOlderHistoryAvailable(conversation),
    loading: connection === null && observation.error === null,
    refresh,
    loadOlder,
    paging,
    error: observation.error ?? error,
  };
}
