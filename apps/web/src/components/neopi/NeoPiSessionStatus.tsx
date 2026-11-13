import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { projectNeoPiSessionStatus } from "@t3tools/client-runtime/neopi-session-status";
import { AsyncResult } from "effect/reactivity";
import { nativeConversationAtoms } from "./useNeoPiConversation";
import { neopiSessionConfigurationChanges } from "../../state/neopiSessions";

export function useNeoPiSessionStatus(threadRef: ScopedThreadRef) {
  const watch = useAtomValue(
    nativeConversationAtoms.watch({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const result = useAtomValue(
    neopiSessionConfigurationChanges({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  if (AsyncResult.isFailure(result)) {
    return {
      status: "unavailable" as const,
      reason: "Native session status is unavailable. Reconnect to read it again.",
    };
  }
  if (!AsyncResult.isSuccess(result) || result.value === null) {
    return { status: "loading" as const, reason: "Reading native session status..." };
  }
  return projectNeoPiSessionStatus(
    result.value,
    AsyncResult.isSuccess(watch) && watch.value.connection?.status === "connected",
  );
}
