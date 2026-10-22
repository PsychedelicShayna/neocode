import { WS_METHODS, type NeoPiJournalEntry, type NeoPiJournalStreamEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";
import { emptyNativeConversation, reduceNativeConversation, sameNativeSession, type NativeConversation, type NativeIdentity } from "../neopiConversation.ts";

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
export interface NativeConversationFeed {
  readonly conversation: NativeConversation;
  readonly connection: Extract<NeoPiJournalStreamEvent, { type: "connection" }> | null;
  readonly busy: boolean | null;
}
export const emptyNativeConversationFeed = (): NativeConversationFeed => ({ conversation: emptyNativeConversation(), connection: null, busy: null });

export function applyNativeConversationEvent(feed: NativeConversationFeed, event: NeoPiJournalStreamEvent): NativeConversationFeed {
  const state = feed.conversation;
  if (event.type === "connection") return { connection: event,
    busy: event.status === "connected" && typeof event.state?.isStreaming === "boolean" ? event.state.isStreaming : null,
    conversation: event.status === "connected" ? state : reduceNativeConversation(state, { type: "disconnect" }) };
  if (event.type === "snapshot") return { ...feed, conversation: reduceNativeConversation(state, event) };
  const frame = event.event;
  if (frame.type === "agent_start") return { ...feed, busy: true };
  if (frame.type === "agent_end") return { ...feed, busy: false };
  let conversation = state;
  if (typeof frame.sessionId === "string" && (typeof frame.sessionFile === "string" || frame.sessionFile === null) &&
      (typeof frame.leafId === "string" || frame.leafId === null)) {
    const identity: NativeIdentity = { sessionId: frame.sessionId, sessionFile: frame.sessionFile, leafId: frame.leafId };
    if ((frame.type === "message_start" || frame.type === "message_update" || frame.type === "message_end") &&
        !sameNativeSession(state.identity, identity)) return feed;
    if (frame.type === "journal_state") conversation = reduceNativeConversation(state, { type: "identity", identity });
    if (frame.type === "journal_entry") {
      const entry = record(frame.entry);
      if (typeof entry.id === "string" && typeof entry.type === "string" && typeof entry.timestamp === "string" &&
          (typeof entry.parentId === "string" || entry.parentId === null))
        conversation = reduceNativeConversation(state, { type: "entry", identity, entry: entry as NeoPiJournalEntry });
    }
    if (frame.type === "message_persisted" && typeof frame.messageId === "string" && typeof frame.entryId === "string")
      conversation = reduceNativeConversation(state, { type: "persisted", identity, messageId: frame.messageId, entryId: frame.entryId });
  }
  if ((frame.type === "message_start" || frame.type === "message_update" || frame.type === "message_end") && typeof frame.messageId === "string") {
    conversation = reduceNativeConversation(state, { type: "message", messageId: frame.messageId, message: record(frame.message) });
    if (frame.snapshot === true) return { ...feed, conversation, busy: true };
  }
  return conversation === state ? feed : { ...feed, conversation };
}

/** Reduce every frame before React observes the atom, including frames in one render batch. */
export function createNeoPiConversationAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    watch: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:neopi-sessions:journal-live", tag: WS_METHODS.neopiSessionsWatchJournal, idleTtlMs: 0,
      transform: (stream) => Stream.unwrap(Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        return SubscriptionRef.changes(supervisor.session).pipe(Stream.switchMap((session) => {
          const current = Option.getOrNull(session);
          const disconnected: NeoPiJournalStreamEvent = { type: "connection", status: "disconnected", ownership: "unknown", canNavigate: false,
            reason: "Reconnect to follow native conversation changes." };
          const initial = Stream.succeed({ session: current, event: disconnected });
          return current === null ? initial : initial.pipe(Stream.concat(stream.pipe(Stream.map((event) => ({ session: current, event })))));
        }), Stream.filterEffect((value) => SubscriptionRef.get(supervisor.session).pipe(Effect.map((session) => Option.getOrNull(session) === value.session))),
        Stream.map((value) => value.event), Stream.scan(emptyNativeConversationFeed(), applyNativeConversationEvent));
      })),
    }),
    navigate: createEnvironmentRpcCommand(runtime, { label: "environment-data:neopi-sessions:navigate-tree", tag: WS_METHODS.neopiSessionsNavigateTree }),
    resume: createEnvironmentRpcCommand(runtime, { label: "environment-data:neopi-sessions:resume-tree", tag: WS_METHODS.neopiSessionsResumeTree }),
    cancel: createEnvironmentRpcCommand(runtime, { label: "environment-data:neopi-sessions:cancel-navigation", tag: WS_METHODS.neopiSessionsCancelNavigation }),
  };
}
