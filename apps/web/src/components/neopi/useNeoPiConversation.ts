import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { createNeoPiConversationAtoms } from "@t3tools/client-runtime/state/neopi-conversation";
import { emptyNativeConversation } from "@t3tools/client-runtime/neopi-conversation";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { connectionAtomRuntime } from "../../connection/runtime";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

export const nativeConversationAtoms = createNeoPiConversationAtoms(connectionAtomRuntime);

export function useNeoPiConversation(threadRef: ScopedThreadRef) {
  const atom = nativeConversationAtoms.watch({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const result = useAtomValue(atom);
  const feed = Option.getOrNull(AsyncResult.value(result));
  const refresh = useAtomRefresh(atom);
  const readOlder = useAtomCommand(nativeConversationAtoms.loadOlder, { reportFailure: false });
  const loadOlder = async () => {
    await readOlder({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
  };
  return {
    conversation: feed?.conversation ?? emptyNativeConversation(),
    connection: feed?.connection ?? null,
    refresh,
    loadOlder,
    paging: feed?.paging ?? false,
    error: AsyncResult.isFailure(result)
      ? formatEnvironmentQueryError(result.cause)
      : (feed?.pagingError ?? null),
    loading: !feed,
    busy: feed?.busy ?? null,
  };
}
