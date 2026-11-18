import { useAtomValue } from "@effect/atom-react";
import { createNativeSessionAtoms } from "@t3tools/client-runtime/state/neopi-native-sessions";
import {
  emptyNativeSessionFeed,
  type NativeObserverPhase,
  type NativeSessionFeed,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { NeoPiNativeSessionsRequestInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useSyncExternalStore } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  closeNativeSessionTab,
  moveNativeSessionTab,
  openNativeSessionTab,
  replaceNativeSessionTab,
  type NativeSessionTabs,
} from "./nativeSessionTabs";
import { useAtomCommand } from "./use-atom-command";
import { relocateNativeWorkspace } from "./nativeWorkspaceRelocation";

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
/** Parked observations a retry may wake; a detach waits for Reconnect. */
const RETRYABLE_PHASES: ReadonlySet<NativeObserverPhase> = new Set([
  "owner-stopped",
  "incompatible",
  "identity-changed",
  "unauthorized",
]);
/**
 * Re-attaches (never opens) a session whose observation stopped on its owner,
 * as clicking its already-selected tab did before: a terminal owner started
 * again on the same file is picked up. Anything else is left alone, so no wake
 * is left queued for a later stop.
 */
export function retryStoppedNativeSession(target: NativeSessionTarget) {
  const phase = nativeSessionAtoms.cached(target)?.observer.phase;
  if (phase !== undefined && RETRYABLE_PHASES.has(phase)) nativeSessionAtoms.retry(target);
}
export const closeNativeSession = (target: NativeSessionTarget) =>
  useNativeSessionSelection.setState((state) => {
    const next = closeNativeSessionTab(state.tabs, state.target, target);
    return { target: next.active, tabs: next.tabs };
  });
export const replaceNativeSession = (from: NativeSessionTarget, to: NativeSessionTarget) => {
  relocateNativeWorkspace(from, to);
  useNativeSessionSelection.setState((state) => ({
    target: to,
    tabs: replaceNativeSessionTab(state.tabs, from, to),
  }));
};
/** Drag-to-reorder: the tab lands on `toIndex`. The order persists with the selection. */
export const moveNativeSession = (target: NativeSessionTarget, toIndex: number) =>
  useNativeSessionSelection.setState((state) => ({
    tabs: moveNativeSessionTab(state.tabs, target, toIndex),
  }));

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

/** Reopens a detached or ownerless session; see `nativeSessionAtoms.reconnect`. */
export function useNativeSessionReconnect(target: NativeSessionTarget) {
  return useCallback(
    () => nativeSessionAtoms.reconnect(appAtomRegistry, target),
    [target.environmentId, target.ref.providerInstanceId, target.ref.sessionFile],
  );
}

const subscribeVisibility = (changed: () => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};
/** A visible but unfocused tiled window stays shown; only actual document concealment stops it. */
export function usePageVisible() {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");
}

/**
 * The feed atom a view subscribes to: the session's lease while the view is
 * shown and the page is visible. Otherwise it only holds the cached feed, which
 * the view shows, so it keeps its place and resumes from it when shown. Panels
 * of the visible session share its one lease, so a collapsed panel never holds
 * one of its own.
 */
function useNativeSessionFeedAtom(target: NativeSessionTarget, shown: boolean) {
  const pageVisible = usePageVisible();
  return nativeSessionAtoms.view(target, shown && pageVisible);
}

export function useNativeSession(target: NativeSessionTarget, shown = true) {
  const result = useAtomValue(useNativeSessionFeedAtom(target, shown));
  const request = useNativeSessionRequest(target);
  const feed = AsyncResult.isSuccess(result)
    ? result.value
    : (nativeSessionAtoms.cached(target) ?? emptyNativeSessionFeed());
  return {
    feed,
    session: feed.session,
    conversation: feed.conversation,
    request,
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
  shown = true,
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
  return useAtomValue(useNativeSessionFeedAtom(target, shown), project);
}
