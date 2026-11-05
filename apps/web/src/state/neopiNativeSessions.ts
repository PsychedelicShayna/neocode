import { useAtomValue } from "@effect/atom-react";
import { createNativeSessionAtoms } from "@t3tools/client-runtime/state/neopi-native-sessions";
import {
  emptyNativeSessionFeed,
  type NativeSessionFeed,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { NeoPiNativeSessionsRequestInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { connectionAtomRuntime } from "../connection/runtime";
import {
  closeNativeSessionTab,
  cycleNativeSessionTab,
  openNativeSessionTab,
  replaceNativeSessionTab,
  type NativeSessionTabs,
} from "./nativeSessionTabs";
import { useAtomCommand } from "./use-atom-command";

export const nativeSessionAtoms = createNativeSessionAtoms(connectionAtomRuntime);
interface NativeSessionSelection {
  readonly target: NativeSessionTarget | null;
  /** Open session tabs in display order; the selected target is always one of them. */
  readonly tabs: NativeSessionTabs;
}
export const useNativeSessionSelection = create(
  persist<NativeSessionSelection>(() => ({ target: null, tabs: [] }), {
    name: "neocode-native-selected-session",
    // Selections saved before tabs existed hold only `target`.
    merge: (saved, current) => {
      const persisted: Partial<NativeSessionSelection> = saved ?? {};
      const target = persisted.target ?? null;
      const tabs = persisted.tabs ?? [];
      return { ...current, target, tabs: target ? openNativeSessionTab(tabs, target) : tabs };
    },
  }),
);

let nativeOpenGeneration = 0;
/** A pending open may select only until another open or tab mutation supersedes it. */
export function beginNativeSessionOpen(): () => boolean {
  const generation = ++nativeOpenGeneration;
  const selection = useNativeSessionSelection.getState();
  return () =>
    generation === nativeOpenGeneration && selection === useNativeSessionSelection.getState();
}
/** Selecting opens the session's tab when it has none. */
export const selectNativeSession = (target: NativeSessionTarget) =>
  useNativeSessionSelection.setState((state) => ({
    target,
    tabs: openNativeSessionTab(state.tabs, target),
  }));
export const closeNativeSession = (target: NativeSessionTarget) =>
  useNativeSessionSelection.setState((state) => {
    const next = closeNativeSessionTab(state.tabs, state.target, target);
    return { target: next.active, tabs: next.tabs };
  });
export const replaceNativeSession = (from: NativeSessionTarget, to: NativeSessionTarget) =>
  useNativeSessionSelection.setState((state) => ({
    target: to,
    tabs: replaceNativeSessionTab(state.tabs, from, to),
  }));
/** Returns whether there was another tab to move to. */
export const cycleNativeSession = (direction: "previous" | "next") => {
  const { target, tabs } = useNativeSessionSelection.getState();
  const next = tabs.length > 1 ? cycleNativeSessionTab(tabs, target, direction) : null;
  if (next) useNativeSessionSelection.setState({ target: next });
  return next !== null;
};

/** Sends one native command to the session's owner and resolves with its response. */
export function useNativeSessionRequest(target: NativeSessionTarget) {
  const send = useAtomCommand(nativeSessionAtoms.request, { reportFailure: false });
  return useCallback(
    async (
      command: Record<string, unknown> & { type: string },
      attachments?: NeoPiNativeSessionsRequestInput["attachments"],
    ) => {
      const response = await send({
        environmentId: target.environmentId,
        input: { ref: target.ref, command, ...(attachments?.length ? { attachments } : {}) },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      return response.value;
    },
    [send, target.environmentId, target.ref.providerInstanceId, target.ref.sessionFile],
  );
}

export function useNativeSession(target: NativeSessionTarget) {
  const result = useAtomValue(
    nativeSessionAtoms.watch({ environmentId: target.environmentId, input: { ref: target.ref } }),
  );
  const request = useNativeSessionRequest(target);
  const feed = AsyncResult.isSuccess(result)
    ? result.value
    : (nativeSessionAtoms.cached(target) ?? emptyNativeSessionFeed());
  return {
    feed,
    session: feed.session,
    conversation: feed.conversation,
    request,
    loading: AsyncResult.isInitial(result),
    error: AsyncResult.isFailure(result) ? String(Cause.squash(result.cause)) : feed.error,
  };
}

const EMPTY_FEED = emptyNativeSessionFeed();

/**
 * One part of a session's feed. The component re-renders only when the selected
 * value changes by reference, so a status bar can follow `feed.agents` without
 * re-rendering on every streamed token. `select` must be a stable function.
 */
export function useNativeSessionSlice<A>(
  target: NativeSessionTarget,
  select: (feed: NativeSessionFeed) => A,
): A {
  const project = useCallback(
    (result: AsyncResult.AsyncResult<NativeSessionFeed, unknown>) =>
      select(
        AsyncResult.isSuccess(result)
          ? result.value
          : (nativeSessionAtoms.cached(target) ?? EMPTY_FEED),
      ),
    [select, target],
  );
  return useAtomValue(
    nativeSessionAtoms.watch({ environmentId: target.environmentId, input: { ref: target.ref } }),
    project,
  );
}
