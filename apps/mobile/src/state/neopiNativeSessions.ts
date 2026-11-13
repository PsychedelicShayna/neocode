import { useAtomValue } from "@effect/atom-react";
import type { NeoPiNativeSessionsRequestInput } from "@t3tools/contracts";
import { createNativeSessionAtoms } from "@t3tools/client-runtime/state/neopi-native-sessions";
import {
  emptyNativeSessionFeed,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";
import { appAtomRegistry } from "./atom-registry";

export const nativeSessionAtoms = createNativeSessionAtoms(connectionAtomRuntime);

/** Reopens a detached or ownerless session; see `nativeSessionAtoms.reconnect`. */
export function useNativeSessionReconnect(target: NativeSessionTarget) {
  const {
    environmentId,
    ref: { providerInstanceId, sessionFile },
  } = target;
  return useCallback(
    () =>
      nativeSessionAtoms.reconnect(appAtomRegistry, {
        environmentId,
        ref: { providerInstanceId, sessionFile },
      }),
    [environmentId, providerInstanceId, sessionFile],
  );
}
export function useNativeSession(target: NativeSessionTarget) {
  const {
    environmentId,
    ref: { providerInstanceId, sessionFile },
  } = target;
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
        environmentId,
        input: {
          ref: { providerInstanceId, sessionFile },
          command,
          ...(attachments ? { attachments } : {}),
        },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      return response.value;
    },
    [send, environmentId, providerInstanceId, sessionFile],
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
