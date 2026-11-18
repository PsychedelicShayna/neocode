import {
  WS_METHODS,
  type EnvironmentId,
  type NeoPiThreadNativeRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { createNativeSessionAtoms } from "./neopiNativeSessions.ts";
import type { NativeSessionFeed } from "../neopiNativeSessions.ts";
import { threadNativeConnection } from "../neopiThreadObservation.ts";

/** Native tree operations on a thread's session; observation is `createNeoPiThreadObservationAtoms`. */
export function createNeoPiConversationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    navigate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:neopi-sessions:navigate-tree",
      tag: WS_METHODS.neopiSessionsNavigateTree,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:neopi-sessions:resume-tree",
      tag: WS_METHODS.neopiSessionsResumeTree,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:neopi-sessions:cancel-navigation",
      tag: WS_METHODS.neopiSessionsCancelNavigation,
    }),
  };
}

/**
 * A thread's transcript observed through the native session controller: the thread's
 * native ref from its binding, then an attach-only watch of that ref (never Open, so a
 * thread view never starts an owner). Mounting the atom holds the watch, and with it the
 * lease; unmounting releases it.
 */
export function createNeoPiThreadObservationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  sessions: Pick<ReturnType<typeof createNativeSessionAtoms>, "watch" | "cached">,
) {
  const nativeRef = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:neopi-sessions:native-ref",
    tag: WS_METHODS.neopiSessionsNativeRef,
    staleTimeMs: 0,
  });
  const observation = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    return Atom.make((get): ThreadNativeObservation => {
      const resolved = get(nativeRef({ environmentId, input: { threadId } }));
      const ref = Option.getOrNull(AsyncResult.value(resolved));
      if (ref === null)
        return {
          ref: null,
          feed: null,
          error: AsyncResult.isFailure(resolved) ? String(Cause.squash(resolved.cause)) : null,
        };
      if (ref.status !== "available") return { ref, feed: null, error: null };
      const target = { environmentId, ref: ref.ref };
      const watched = get(sessions.watch({ environmentId, input: { ref: ref.ref } }));
      return {
        ref,
        feed: Option.getOrNull(AsyncResult.value(watched)) ?? sessions.cached(target) ?? null,
        error: AsyncResult.isFailure(watched) ? String(Cause.squash(watched.cause)) : null,
      };
    }).pipe(Atom.withLabel(`environment-data:neopi-sessions:thread:${key}`));
  });
  const observe = (thread: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => observation(JSON.stringify([thread.environmentId, thread.threadId]));
  return {
    observe,
    /**
     * Re-reads the binding and, unless the view is attached, re-attaches. Re-attaching
     * runs attach-only discovery again; it never opens or starts an owner.
     */
    refresh: (
      registry: AtomRegistry.AtomRegistry,
      thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
    ) => {
      const current = registry.get(observe(thread));
      registry.refresh(
        nativeRef({ environmentId: thread.environmentId, input: { threadId: thread.threadId } }),
      );
      if (current.ref?.status === "available" && current.feed?.connected !== true)
        registry.refresh(
          sessions.watch({ environmentId: thread.environmentId, input: { ref: current.ref.ref } }),
        );
    },
  };
}

export interface ThreadNativeObservation {
  readonly ref: NeoPiThreadNativeRef | null;
  readonly feed: NativeSessionFeed | null;
  readonly error: string | null;
}

/** The thread statuses for an observation; see `threadNativeConnection`. */
export const threadObservationConnection = (observation: ThreadNativeObservation) =>
  threadNativeConnection(
    observation.ref,
    observation.feed && {
      phase: observation.feed.observer.phase,
      reason: observation.feed.observer.reason,
      connected: observation.feed.connected,
      session: observation.feed.session && {
        sessionId: observation.feed.session.sessionId,
        capabilities: observation.feed.session.capabilities,
      },
    },
  );
