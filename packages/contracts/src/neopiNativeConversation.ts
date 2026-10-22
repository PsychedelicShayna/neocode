import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { NeoPiJournalEntry, NeoPiJournalPage } from "./neopiJournal.ts";

export const NeoPiNativeRecord = Schema.Record(Schema.String, Schema.Unknown);
export const NeoPiNativeFrame = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [NeoPiNativeRecord]);
const JournalIdentity = Schema.Struct({ sessionId: Schema.String, sessionFile: Schema.NullOr(Schema.String), leafId: Schema.NullOr(Schema.String) });
export const NeoPiJournalNativeEvent = Schema.Union([
  Schema.StructWithRest(Schema.Struct({ ...JournalIdentity.fields, type: Schema.Literal("journal_state"), reason: Schema.Literals(["snapshot", "identity", "leaf"]) }), [NeoPiNativeRecord]),
  Schema.StructWithRest(Schema.Struct({ ...JournalIdentity.fields, type: Schema.Literal("journal_entry"), entry: NeoPiJournalEntry }), [NeoPiNativeRecord]),
  Schema.StructWithRest(Schema.Struct({ ...JournalIdentity.fields, type: Schema.Literal("message_persisted"), messageId: Schema.String, entryId: Schema.String }), [NeoPiNativeRecord]),
]);
export type NeoPiJournalNativeEvent = typeof NeoPiJournalNativeEvent.Type;
export const NeoPiStreamingMessageSnapshot = Schema.StructWithRest(Schema.Struct({
  ...JournalIdentity.fields,
  type: Schema.Literal("message_start"),
  snapshot: Schema.Literal(true),
  messageId: Schema.String,
  message: NeoPiNativeRecord,
}), [NeoPiNativeRecord]);
export type NeoPiStreamingMessageSnapshot = typeof NeoPiStreamingMessageSnapshot.Type;
export const NeoPiWatchJournalInput = Schema.Struct({ threadId: ThreadId });
export type NeoPiWatchJournalInput = typeof NeoPiWatchJournalInput.Type;
export const NeoPiJournalConnection = Schema.Struct({
  type: Schema.Literal("connection"),
  status: Schema.Literals(["connected", "unavailable", "disconnected", "gap", "identity_changed"]),
  ownership: Schema.Literals(["gui", "terminal", "stopped", "unknown"]),
  canNavigate: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  state: Schema.optional(NeoPiNativeRecord),
});
export const NeoPiJournalStreamEvent = Schema.Union([
  NeoPiJournalConnection,
  Schema.Struct({ type: Schema.Literal("snapshot"), page: NeoPiJournalPage }),
  Schema.Struct({ type: Schema.Literal("native"), event: NeoPiNativeFrame }),
]);
export type NeoPiJournalStreamEvent = typeof NeoPiJournalStreamEvent.Type;
export const NeoPiTreeExpected = Schema.Struct({
  expectedSessionId: Schema.String,
  expectedSessionFile: Schema.NullOr(Schema.String),
  expectedLeafId: Schema.NullOr(Schema.String),
});
const Image = Schema.StructWithRest(Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }), [NeoPiNativeRecord]);
const Text = Schema.StructWithRest(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }), [NeoPiNativeRecord]);
export const NeoPiNavigateTreeInput = Schema.Struct({
  threadId: ThreadId,
  ...NeoPiTreeExpected.fields,
  targetId: Schema.String,
  startIfStopped: Schema.optional(Schema.Boolean),
  summarize: Schema.optional(Schema.Boolean),
  customInstructions: Schema.optional(Schema.String),
  allowAskReopen: Schema.optional(Schema.Boolean),
  reanswerAskResult: Schema.optional(Schema.Struct({
    content: Schema.Array(Schema.Union([Text, Image])),
    details: Schema.optional(NeoPiNativeRecord),
    isError: Schema.optional(Schema.Boolean),
  })),
});
export type NeoPiNavigateTreeInput = typeof NeoPiNavigateTreeInput.Type;
export const NeoPiResumeTreeInput = Schema.Struct({ threadId: ThreadId, ...NeoPiTreeExpected.fields, resumeToken: Schema.String });
export type NeoPiResumeTreeInput = typeof NeoPiResumeTreeInput.Type;
export const NeoPiNavigateTreeResult = Schema.Struct({
  sessionId: Schema.String,
  sessionFile: Schema.optional(Schema.String),
  leafId: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["navigated", "unchanged", "cancelled", "ask_reopen"]),
  cancelled: Schema.Boolean,
  aborted: Schema.optional(Schema.Boolean),
  editorText: Schema.optional(Schema.String),
  editorImages: Schema.optional(Schema.Array(Image)),
  summaryEntry: Schema.optional(NeoPiJournalEntry),
  reopenAsk: Schema.optional(Schema.Struct({ toolCallId: Schema.String, questions: Schema.Array(NeoPiNativeRecord) })),
  askReanswerCommitted: Schema.optional(Schema.Boolean),
  resumeToken: Schema.optional(Schema.String),
});
export type NeoPiNavigateTreeResult = typeof NeoPiNavigateTreeResult.Type;
const Unavailable = Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String });
const Failure = Schema.Struct({ status: Schema.Literal("error"), code: Schema.String, message: Schema.String });
export const NeoPiTreeOperationResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available"), result: NeoPiNavigateTreeResult }), Unavailable, Failure,
]);
export type NeoPiTreeOperationResult = typeof NeoPiTreeOperationResult.Type;
export const NeoPiTreeResumeResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available"), result: Schema.Struct({ resumed: Schema.Literal(true) }) }), Unavailable, Failure,
]);
export type NeoPiTreeResumeResult = typeof NeoPiTreeResumeResult.Type;
export const NeoPiTreeCancelResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available"), result: Schema.Unknown }), Unavailable, Failure,
]);
export type NeoPiTreeCancelResult = typeof NeoPiTreeCancelResult.Type;
