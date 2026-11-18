import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import type { NeoPiNativeSessionsRequestInput } from "@t3tools/contracts";
import { createNativeSessionAtoms } from "@t3tools/client-runtime/state/neopi-native-sessions";
import {
  emptyNativeSessionFeed,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useSyncExternalStore } from "react";
import { AppState } from "react-native";
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

const subscribeAppState = (changed: () => void) => {
  const subscription = AppState.addEventListener("change", changed);
  return () => subscription.remove();
};

/**
 * Whether the current screen is shown: focused and the app in the foreground. A screen
 * covered by another one, or the app in the background, holds no lease; it keeps the
 * cached feed and resumes from it when shown again.
 */
export function useScreenVisible() {
  const foreground = useSyncExternalStore(
    subscribeAppState,
    () => AppState.currentState === "active",
  );
  return useIsFocused() && foreground;
}

export function useNativeSession(target: NativeSessionTarget) {
  const visible = useScreenVisible();
  const result = useAtomValue(nativeSessionAtoms.view(target, visible));
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
