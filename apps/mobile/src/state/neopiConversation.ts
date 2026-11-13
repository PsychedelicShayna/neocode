import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  emptyNativeConversation,
  nativeIdentityKey,
  type NativeIdentity,
} from "@t3tools/client-runtime/neopi-conversation";
import { createNeoPiConversationAtoms } from "@t3tools/client-runtime/state/neopi-conversation";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { scopedThreadKey } from "../lib/scopedEntities";
import { bindComposerDraftToNativeSession } from "./use-composer-drafts";
import { useAtomCommand } from "./use-atom-command";

export const nativeConversationAtoms = createNeoPiConversationAtoms(connectionAtomRuntime);
export const nativeJournalRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:neopi-journal:read",
  tag: WS_METHODS.neopiSessionsJournal,
});
export const nativeJournalQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:neopi-journal:initial",
  tag: WS_METHODS.neopiSessionsJournal,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
export const nativeSessionDraftKey = (threadRef: ScopedThreadRef, identity: NativeIdentity) =>
  `${threadRef.environmentId}:native-${encodeURIComponent(nativeIdentityKey(identity))}`;

export function useNeoPiConversation(threadRef: ScopedThreadRef) {
  const atom = nativeConversationAtoms.watch({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const result = useAtomValue(atom);
  const feed = Option.getOrNull(AsyncResult.value(result));
  const conversation = feed?.conversation ?? emptyNativeConversation();
  const refresh = useAtomRefresh(atom);
  const readOlder = useAtomCommand(nativeConversationAtoms.loadOlder, { reportFailure: false });
  const [bindingFailure, setBindingFailure] = useState<{
    identityKey: string;
    message: string;
  } | null>(null);
  const identityKey = conversation.identity
    ? nativeSessionDraftKey(threadRef, conversation.identity)
    : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Bind the external durable draft store to the canonical native file.
  useEffect(() => {
    if (!identityKey) return;
    let active = true;
    void bindComposerDraftToNativeSession(
      scopedThreadKey(threadRef.environmentId, threadRef.threadId),
      identityKey,
    ).catch((cause) => {
      if (active)
        setBindingFailure({
          identityKey,
          message:
            cause instanceof Error ? cause.message : "The native draft could not be restored.",
        });
    });
    return () => {
      active = false;
    };
  }, [identityKey, threadRef.environmentId, threadRef.threadId]);
  const loadOlder = async () => {
    await readOlder({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
  };
  return {
    conversation,
    connection: feed?.connection ?? null,
    busy: feed?.busy ?? null,
    loading: !feed && !AsyncResult.isFailure(result),
    refresh,
    loadOlder,
    paging: feed?.paging ?? false,
    error: AsyncResult.isFailure(result)
      ? String(Cause.squash(result.cause))
      : bindingFailure?.identityKey === identityKey
        ? bindingFailure.message
        : (feed?.pagingError ?? null),
  };
}
