import {
  WS_METHODS,
  type EnvironmentId,
  type NeoPiJournalEntry,
  type NeoPiJournalStreamEvent,
  type NeoPiThreadNativeRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { createNativeSessionAtoms } from "./neopiNativeSessions.ts";
import type { NativeSessionFeed } from "../neopiNativeSessions.ts";
import { threadNativeConnection } from "../neopiThreadObservation.ts";
import {
  emptyNativeConversation,
  reduceNativeConversation,
  sameNativeSession,
  type NativeConversation,
  type NativeIdentity,
} from "../neopiConversation.ts";

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export interface NativeConversationFeed {
  readonly conversation: NativeConversation;
  readonly connection: Extract<NeoPiJournalStreamEvent, { type: "connection" }> | null;
  readonly busy: boolean | null;
}
export const emptyNativeConversationFeed = (): NativeConversationFeed => ({
  conversation: emptyNativeConversation(),
  connection: null,
  busy: null,
});

export function applyNativeConversationEvent(
  feed: NativeConversationFeed,
  event: NeoPiJournalStreamEvent,
): NativeConversationFeed {
  const state = feed.conversation;
  if (event.type === "connection")
    return {
      connection: event,
      busy:
        event.status === "connected" && typeof event.state?.isStreaming === "boolean"
          ? event.state.isStreaming
          : null,
      conversation:
        event.status === "connected"
          ? state
          : reduceNativeConversation(state, { type: "disconnect" }),
    };
  if (event.type === "snapshot")
    return { ...feed, conversation: reduceNativeConversation(state, event) };
  const frame = event.event;
  if (frame.type === "agent_start")
    return {
      ...feed,
      busy: true,
      conversation: reduceNativeConversation(state, { type: "turn_started" }),
    };
  if (frame.type === "agent_end") return { ...feed, busy: false };
  let conversation = state;
  if (
    typeof frame.sessionId === "string" &&
    (typeof frame.sessionFile === "string" || frame.sessionFile === null) &&
    (typeof frame.leafId === "string" || frame.leafId === null)
  ) {
    const identity: NativeIdentity = {
      sessionId: frame.sessionId,
      sessionFile: frame.sessionFile,
      leafId: frame.leafId,
    };
    if (
      (frame.type === "message_start" ||
        frame.type === "message_update" ||
        frame.type === "message_end") &&
      !sameNativeSession(state.identity, identity)
    )
      return feed;
    if (frame.type === "journal_state") {
      // A reconnect boundary can predate the page already rendered by the client.
      // Recover durable IDs without moving that hydrated branch backwards.
      if (frame.reason !== "snapshot" || !sameNativeSession(state.identity, identity))
        conversation = reduceNativeConversation(state, { type: "identity", identity });
      if (frame.reason === "snapshot" && Array.isArray(frame.messageEntryIds)) {
        const messageEntryIds = frame.messageEntryIds.flatMap((value) => {
          const pair = record(value);
          return typeof pair.messageId === "string" && typeof pair.entryId === "string"
            ? [{ messageId: pair.messageId, entryId: pair.entryId }]
            : [];
        });
        conversation = reduceNativeConversation(conversation, {
          type: "persistence_snapshot",
          identity,
          messageEntryIds,
        });
      }
    }
    if (frame.type === "journal_entry") {
      const entry = record(frame.entry);
      if (
        typeof entry.id === "string" &&
        typeof entry.type === "string" &&
        typeof entry.timestamp === "string" &&
        (typeof entry.parentId === "string" || entry.parentId === null)
      )
        conversation = reduceNativeConversation(state, {
          type: "entry",
          identity,
          entry: entry as NeoPiJournalEntry,
        });
    }
    if (
      frame.type === "message_persisted" &&
      typeof frame.messageId === "string" &&
      typeof frame.entryId === "string"
    )
      conversation = reduceNativeConversation(state, {
        type: "persisted",
        identity,
        messageId: frame.messageId,
        entryId: frame.entryId,
      });
  }
  if (
    (frame.type === "message_start" ||
      frame.type === "message_update" ||
      frame.type === "message_end") &&
    typeof frame.messageId === "string"
  ) {
    conversation = reduceNativeConversation(state, {
      type: "message",
      messageId: frame.messageId,
      message: record(frame.message),
    });
    if (frame.snapshot === true) return { ...feed, conversation, busy: true };
  }
  return conversation === state ? feed : { ...feed, conversation };
}

/** Reduce every frame before React observes the atom, including frames in one render batch. */
export function createNeoPiConversationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    watch: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:neopi-sessions:journal-live",
      tag: WS_METHODS.neopiSessionsWatchJournal,
      idleTtlMs: 0,
      transform: (stream) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const supervisor = yield* EnvironmentSupervisor;
            return SubscriptionRef.changes(supervisor.session).pipe(
              Stream.switchMap((session) => {
                const current = Option.getOrNull(session);
                const disconnected: NeoPiJournalStreamEvent = {
                  type: "connection",
                  status: "disconnected",
                  ownership: "unknown",
                  canNavigate: false,
                  reason: "Reconnect to follow native conversation changes.",
                };
                const initial = Stream.succeed({ session: current, event: disconnected });
                return current === null
                  ? initial
                  : initial.pipe(
                      Stream.concat(
                        stream.pipe(Stream.map((event) => ({ session: current, event }))),
                      ),
                    );
              }),
              Stream.filterEffect((value) =>
                SubscriptionRef.get(supervisor.session).pipe(
                  Effect.map((session) => Option.getOrNull(session) === value.session),
                ),
              ),
              Stream.map((value) => value.event),
              Stream.scan(emptyNativeConversationFeed(), applyNativeConversationEvent),
            );
          }),
        ),
    }),
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
