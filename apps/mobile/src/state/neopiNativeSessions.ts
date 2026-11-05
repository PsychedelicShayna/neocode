import { useAtomValue } from "@effect/atom-react";
import type { NeoPiNativeSessionsRequestInput } from "@t3tools/contracts";
import { createNativeSessionAtoms } from "@t3tools/client-runtime/state/neopi-native-sessions";
import {
  emptyNativeSessionFeed,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";
import { appAtomRegistry } from "./atom-registry";

export const nativeSessionAtoms = createNativeSessionAtoms(connectionAtomRuntime);

/** Reopens a detached or ownerless session; see `nativeSessionAtoms.reconnect`. */
export function useNativeSessionReconnect(target: NativeSessionTarget) {
  return useCallback(
    () => nativeSessionAtoms.reconnect(appAtomRegistry, target),
    [target.environmentId, target.ref.providerInstanceId, target.ref.sessionFile],
  );
}
export function useNativeSession(target: NativeSessionTarget) {
  const result = useAtomValue(
    nativeSessionAtoms.watch({ environmentId: target.environmentId, input: { ref: target.ref } }),
  );
  const send = useAtomCommand(nativeSessionAtoms.request, { reportFailure: false });
  const request = useCallback(
    async (
      command: Record<string, unknown> & { type: string },
      attachments?: NeoPiNativeSessionsRequestInput["attachments"],
    ) => {
      const response = await send({
        environmentId: target.environmentId,
        input: { ref: target.ref, command, ...(attachments ? { attachments } : {}) },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      return response.value;
    },
    [send, target.environmentId, target.ref.providerInstanceId, target.ref.sessionFile],
  );
  const feed = AsyncResult.isSuccess(result)
    ? result.value
    : (nativeSessionAtoms.cached(target) ?? emptyNativeSessionFeed());
  return {
    feed,
    request,
    error: AsyncResult.isFailure(result) ? String(Cause.squash(result.cause)) : feed.error,
  };
}
