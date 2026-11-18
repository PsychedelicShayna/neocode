import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { NeoPiJournalEntry } from "./neopiJournal.ts";
import { NeoPiNativeSessionRef } from "./neopiNativeSessions.ts";

export const NeoPiNativeRecord = Schema.Record(Schema.String, Schema.Unknown);
export const NeoPiNativeThreadInput = Schema.Struct({ threadId: ThreadId });
export type NeoPiNativeThreadInput = typeof NeoPiNativeThreadInput.Type;
export const NeoPiTreeExpected = Schema.Struct({
  expectedSessionId: Schema.String,
  expectedSessionFile: Schema.NullOr(Schema.String),
  expectedLeafId: Schema.NullOr(Schema.String),
});
const Image = Schema.StructWithRest(
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
  [NeoPiNativeRecord],
);
const Text = Schema.StructWithRest(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  [NeoPiNativeRecord],
);
export const NeoPiNavigateTreeInput = Schema.Struct({
  threadId: ThreadId,
  ...NeoPiTreeExpected.fields,
  targetId: Schema.String,
  startIfStopped: Schema.optional(Schema.Boolean),
  summarize: Schema.optional(Schema.Boolean),
  customInstructions: Schema.optional(Schema.String),
  allowAskReopen: Schema.optional(Schema.Boolean),
  reanswerAskResult: Schema.optional(
    Schema.Struct({
      content: Schema.Array(Schema.Union([Text, Image])),
      details: Schema.optional(NeoPiNativeRecord),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type NeoPiNavigateTreeInput = typeof NeoPiNavigateTreeInput.Type;
export const NeoPiResumeTreeInput = Schema.Struct({
  threadId: ThreadId,
  ...NeoPiTreeExpected.fields,
  resumeToken: Schema.String,
});
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
  reopenAsk: Schema.optional(
    Schema.Struct({ toolCallId: Schema.String, questions: Schema.Array(NeoPiNativeRecord) }),
  ),
  askReanswerCommitted: Schema.optional(Schema.Boolean),
  resumeToken: Schema.optional(Schema.String),
});
export type NeoPiNavigateTreeResult = typeof NeoPiNavigateTreeResult.Type;
const Unavailable = Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String });
const Failure = Schema.Struct({
  status: Schema.Literal("error"),
  code: Schema.String,
  message: Schema.String,
});
export const NeoPiTreeOperationResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available"), result: NeoPiNavigateTreeResult }),
  Unavailable,
  Failure,
]);
export type NeoPiTreeOperationResult = typeof NeoPiTreeOperationResult.Type;
export const NeoPiTreeResumeResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    result: Schema.Struct({ resumed: Schema.Literal(true) }),
  }),
  Unavailable,
  Failure,
]);
export type NeoPiTreeResumeResult = typeof NeoPiTreeResumeResult.Type;
export const NeoPiTreeCancelResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available"), result: Schema.Unknown }),
  Unavailable,
  Failure,
]);
export type NeoPiTreeCancelResult = typeof NeoPiTreeCancelResult.Type;
/**
 * A thread's canonical native session, from its saved binding, for an active thread only.
 * `runtime` is what NeoCode's own runtime for the thread is right now: `gui` when it owns the
 * session, `terminal` when it attached to a terminal owner, `none` when it is not running. A
 * view that finds no attachable owner can then tell a stopped session from a NeoCode-owned
 * one whose control plane is off or unsupported.
 */
export const NeoPiThreadNativeRef = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    ref: NeoPiNativeSessionRef,
    sessionId: Schema.String,
    runtime: Schema.Literals(["gui", "terminal", "none"]),
  }),
  Unavailable,
]);
export type NeoPiThreadNativeRef = typeof NeoPiThreadNativeRef.Type;
