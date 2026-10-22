import {
  NeoPiNavigateTreeResult, NeoPiNativeFrame, NeoPiNativeRecord, NeoPiJournalNativeEvent, NeoPiStreamingMessageSnapshot,
  type NeoPiJournalStreamEvent, type NeoPiNavigateTreeInput, type NeoPiResumeTreeInput,
  type NeoPiTreeOperationResult, type NeoPiTreeResumeResult, type NeoPiTreeCancelResult,
  type ThreadId, type NeoPiSessionJournalResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { readNeoPiJournalPeer, neoPiJournalError, sameNeoPiJournalIdentity } from "./NeoPiJournalReader.ts";
import { makeNeoPiNativeOwnerResolver, makeNeoPiNativeSessionStarter, type NeoPiNativeOwner } from "./NeoPiNativeOwner.ts";
import type { NeoPiConfigurationIdentity } from "./NeoPiSessionConfiguration.ts";
import { makeNeoPiSessionJournal } from "./NeoPiSessionJournal.ts";

const liveTypes = new Set([
  "journal_state", "journal_entry", "message_persisted", "message_start", "message_update", "message_end",
  "agent_start", "agent_end", "turn_start", "turn_end", "session_settled", "model_changed",
  "thinking_level_changed", "mode_changed", "fast_mode_changed", "config_warnings_changed",
  "auto_compaction_start", "auto_compaction_end", "neocode_connection_closed",
]);
const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });
const connection = (status: "unavailable" | "disconnected" | "gap" | "identity_changed", reason: string, ownership: "gui" | "terminal" | "unknown" = "unknown"): NeoPiJournalStreamEvent =>
  ({ type: "connection", status, reason, ownership, canNavigate: false });

/** Events are subscribed by the resolver before any snapshot request is issued. */
export const observeNeoPiNativeOwner = (
  owner: NeoPiNativeOwner,
  expected: NeoPiConfigurationIdentity,
  resolveFile: (file: string) => Effect.Effect<string, unknown>,
): Stream.Stream<NeoPiJournalStreamEvent> => Stream.unwrap(Effect.gen(function* () {
  if (!owner.capabilities.has("session_journal"))
    return Stream.succeed(connection("unavailable", "The native owner lacks session_journal. Update NeoPi to read canonical history.", owner.ownership));
  if (owner.capabilities.has("session_journal_events")) {
    const boundary = yield* Schema.decodeUnknownEffect(Schema.Struct({
      sessionId: Schema.String, sessionFile: Schema.NullOr(Schema.String), leafId: Schema.NullOr(Schema.String),
    }))(yield* owner.request({ type: "snapshot_session_journal" }));
    if (boundary.sessionFile === null || !sameNeoPiJournalIdentity({
      sessionId: boundary.sessionId, sessionFile: yield* resolveFile(boundary.sessionFile),
    }, expected)) return Stream.succeed(connection("identity_changed", "The native snapshot belongs to a different canonical session. Refresh the binding.", owner.ownership));
  }
  const state = yield* Schema.decodeUnknownEffect(NeoPiNativeRecord)(yield* owner.request({ type: "get_state" }));
  const page = yield* readNeoPiJournalPeer(owner, expected, { scope: "branch", direction: "backward", limit: 128 }, resolveFile);
  if (page.status !== "available") return Stream.succeed(connection("gap", page.status === "error" ? page.message : page.reason, owner.ownership));
  if (!owner.capabilities.has("session_journal_events")) return Stream.fromIterable<NeoPiJournalStreamEvent>([
    connection("unavailable", "Canonical history is available, but this owner lacks session_journal_events. Live following is unavailable.", owner.ownership),
    { type: "snapshot", page: page.page },
  ]);
  const initial: ReadonlyArray<NeoPiJournalStreamEvent> = [
    { type: "connection", status: "connected", ownership: owner.ownership, canNavigate: owner.capabilities.has("session_tree_navigation"), state },
    { type: "snapshot", page: page.page },
  ];
  const seenEntries = new Set(page.page.entries.map((entry) => entry.id));
  const live = owner.events.pipe(
    Stream.filter((event) => liveTypes.has(event.type)),
    Stream.mapEffect((event): Effect.Effect<NeoPiJournalStreamEvent, unknown> => Effect.gen(function* () {
      if (event.type === "neocode_connection_closed") return connection("disconnected", "The native owner connection closed. Reconnect and reconcile native history.", owner.ownership);
      const journalEvent = event.type === "journal_state" || event.type === "journal_entry" || event.type === "message_persisted";
      const streamingSnapshot = event.type === "message_start" && event.snapshot === true;
      if (journalEvent) yield* Schema.decodeUnknownEffect(NeoPiJournalNativeEvent)(event);
      if (streamingSnapshot) yield* Schema.decodeUnknownEffect(NeoPiStreamingMessageSnapshot)(event);
      if (journalEvent || streamingSnapshot) {
        if (typeof event.sessionId !== "string" || typeof event.sessionFile !== "string" ||
          !sameNeoPiJournalIdentity({ sessionId: event.sessionId, sessionFile: yield* resolveFile(event.sessionFile) }, expected))
          return connection("identity_changed", "The owner changed its canonical native session. The old binding is invalid.", owner.ownership);
      }
      return { type: "native", event: yield* Schema.decodeUnknownEffect(NeoPiNativeFrame)(event) };
    })),
    Stream.filter((frame) => {
      if (frame.type !== "native" || frame.event.type !== "journal_entry") return true;
      const entry = frame.event.entry;
      if (typeof entry !== "object" || entry === null || !("id" in entry) || typeof entry.id !== "string") return true;
      if (seenEntries.has(entry.id)) return false;
      seenEntries.add(entry.id);
      if (seenEntries.size > 256) seenEntries.delete(seenEntries.values().next().value!);
      return true;
    }),
    Stream.concat(Stream.succeed(connection("disconnected", "The native stream ended. Reconnect and reconcile native history.", owner.ownership))),
    Stream.takeUntil((event) => event.type === "connection"),
  );
  return Stream.concat(Stream.fromIterable(initial), live);
})).pipe(Stream.catch((cause) => Stream.succeed(connection("gap", neoPiJournalError(cause).message))));

type ResolveOwner = (threadId: ThreadId) => Effect.Effect<{
  readonly expected: NeoPiConfigurationIdentity;
  readonly owner: NeoPiNativeOwner;
} | undefined, unknown, Scope.Scope>;

export const makeNeoPiNativeConversationWith = (
  resolve: ResolveOwner,
  resolveFile: (file: string) => Effect.Effect<string, unknown>,
  startStopped: (input: NeoPiNavigateTreeInput) => Effect.Effect<void, unknown> = () => Effect.void,
  readStopped?: (threadId: ThreadId) => Effect.Effect<NeoPiSessionJournalResult>,
) => Effect.gen(function* () {
  const pending = new Map<ThreadId, NeoPiNativeOwner>();
  const watch = (threadId: ThreadId) => Stream.unwrap(Effect.gen(function* () {
    const resolved = yield* resolve(threadId);
    if (!resolved) {
      const snapshot = readStopped ? yield* readStopped(threadId) : undefined;
      if (snapshot?.status === "available") return Stream.fromIterable<NeoPiJournalStreamEvent>([
        { type: "connection", status: "unavailable", ownership: "unknown", canNavigate: false, reason: "Read-only native history. No live owner observer is available. Start a stopped session explicitly to navigate its tree." },
        { type: "snapshot", page: snapshot.page },
      ]);
      return Stream.succeed(connection("unavailable", snapshot?.status === "error" ? snapshot.message : snapshot?.reason ?? "No readable native owner is connected. History remains available without starting a session."));
    }
    return observeNeoPiNativeOwner(resolved.owner, resolved.expected, resolveFile);
  })).pipe(Stream.catch((cause) => Stream.succeed(connection("disconnected", neoPiJournalError(cause).message))));
  const navigate = (input: NeoPiNavigateTreeInput): Effect.Effect<NeoPiTreeOperationResult> => Effect.gen(function* () {
    if (pending.has(input.threadId)) return { status: "error" as const, code: "session_busy", message: "A native tree navigation is already pending." };
    let resolved = yield* resolve(input.threadId);
    if (!resolved && input.startIfStopped) {
      yield* startStopped(input);
      resolved = yield* resolve(input.threadId);
    }
    if (!resolved) return unavailable("Start or resume this native session explicitly before navigating its tree.");
    if (!resolved.owner.capabilities.has("session_tree_navigation")) return unavailable("The existing native owner does not support session_tree_navigation.");
    const { threadId, startIfStopped: _, ...options } = input;
    if (options.expectedSessionId !== resolved.expected.sessionId || options.expectedSessionFile !== resolved.expected.sessionFile)
      return { status: "error" as const, code: "session_changed", message: "Navigation does not match the thread's canonical native binding." };
    if (pending.has(threadId)) return { status: "error" as const, code: "session_busy", message: "A native tree navigation is already pending." };
    pending.set(threadId, resolved.owner);
    return yield* Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(NeoPiNavigateTreeResult)(yield* resolved.owner.request({ type: "navigate_tree", ...options }));
      return { status: "available" as const, result };
    }).pipe(
      Effect.onInterrupt(() => resolved.owner.request({ type: "abort" }).pipe(Effect.ignore)),
      Effect.ensuring(Effect.sync(() => { pending.delete(threadId); })),
    );
  }).pipe(Effect.scoped, Effect.catch((cause) => Effect.succeed(neoPiJournalError(cause))));
  const resume = (input: NeoPiResumeTreeInput): Effect.Effect<NeoPiTreeResumeResult> => Effect.gen(function* () {
    const resolved = yield* resolve(input.threadId);
    if (!resolved) return unavailable("The native owner is disconnected. No ask continuation was started.");
    if (!resolved.owner.capabilities.has("session_tree_navigation")) return unavailable("The native owner does not support session_tree_navigation.");
    const { threadId: _, ...options } = input;
    if (options.expectedSessionId !== resolved.expected.sessionId || options.expectedSessionFile !== resolved.expected.sessionFile)
      return { status: "error" as const, code: "session_changed", message: "Resume does not match the thread's canonical native binding." };
    const result = yield* Schema.decodeUnknownEffect(Schema.Struct({ resumed: Schema.Literal(true) }))(yield* resolved.owner.request({ type: "resume_tree", ...options }));
    return { status: "available" as const, result };
  }).pipe(Effect.scoped, Effect.catch((cause) => Effect.succeed(neoPiJournalError(cause))));
  const cancel = (threadId: ThreadId): Effect.Effect<NeoPiTreeCancelResult> => Effect.gen(function* () {
    const owner = pending.get(threadId);
    if (!owner) return unavailable("There is no NeoCode navigation to cancel. No native turn was interrupted.");
    return { status: "available" as const, result: yield* owner.request({ type: "abort" }) };
  }).pipe(Effect.catch((cause) => Effect.succeed(neoPiJournalError(cause))));
  return { watch, navigate, resume, cancel };
});

export const makeNeoPiNativeConversation = Effect.fn("NeoPiNativeConversation.make")(function* () {
  const resolve = yield* makeNeoPiNativeOwnerResolver();
  const fs = yield* FileSystem.FileSystem;
  const startStopped = yield* makeNeoPiNativeSessionStarter();
  const journal = yield* makeNeoPiSessionJournal();
  return yield* makeNeoPiNativeConversationWith(resolve, (file) => fs.realPath(file), startStopped, (threadId) =>
    journal({ threadId, scope: "branch", direction: "backward", limit: 128 }));
});
