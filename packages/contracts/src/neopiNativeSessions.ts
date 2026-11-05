import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ReviewDiffFileContentsInput, ReviewDiffPreviewInput } from "./review.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ChatFileAttachment,
  ChatImageAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "./orchestration.ts";

export const NeoPiNativeSessionRef = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionFile: Schema.String,
});
export type NeoPiNativeSessionRef = typeof NeoPiNativeSessionRef.Type;

export const NeoPiNativeSessionsGetDiffPreviewInput = Schema.Struct({
  ref: NeoPiNativeSessionRef,
  ...Struct.omit(ReviewDiffPreviewInput.fields, ["cwd"]),
});
export type NeoPiNativeSessionsGetDiffPreviewInput =
  typeof NeoPiNativeSessionsGetDiffPreviewInput.Type;
export const NeoPiNativeSessionsGetDiffFileContentsInput = Schema.Struct({
  ref: NeoPiNativeSessionRef,
  ...Struct.omit(ReviewDiffFileContentsInput.fields, ["cwd"]),
});
export type NeoPiNativeSessionsGetDiffFileContentsInput =
  typeof NeoPiNativeSessionsGetDiffFileContentsInput.Type;
export const NeoPiNativeSessionRecord = Schema.Record(Schema.String, Schema.Unknown);
export const NeoPiNativeSessionCommand = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String }),
  [NeoPiNativeSessionRecord],
);
export type NeoPiNativeSessionCommand = typeof NeoPiNativeSessionCommand.Type;
export const NeoPiNativeSessionAttachment = Schema.Literals(["owned", "terminal"]);
/**
 * What a running owner is doing. `waiting` means a dialog (question or
 * approval) blocks the agent; `busy` means a turn is in flight.
 */
export const NeoPiNativeSessionLive = Schema.Struct({
  state: Schema.Literals(["busy", "waiting", "idle"]),
  isStreaming: Schema.Boolean,
  pendingDialogs: Schema.Number,
  /** VCS branch of the owner's working directory, when NeoPi could read it. */
  branch: Schema.NullOr(Schema.String),
});
export type NeoPiNativeSessionLive = typeof NeoPiNativeSessionLive.Type;
export const NeoPiNativeSessionSummary = Schema.Struct({
  ref: NeoPiNativeSessionRef,
  sessionId: Schema.String,
  cwd: Schema.String,
  title: Schema.NullOr(Schema.String),
  firstMessage: Schema.String,
  modifiedAt: Schema.String,
  owner: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({
      kind: Schema.Literal("process"),
      pid: Schema.Number,
      attachable: Schema.Boolean,
    }),
    Schema.Struct({ kind: Schema.Literal("neocode"), attachment: NeoPiNativeSessionAttachment }),
  ]),
  /** Absent when no owner process answered or the server predates live state. */
  live: Schema.optional(NeoPiNativeSessionLive),
  /** When the session was settled out of the active list, ISO 8601; absent while active. */
  settledAt: Schema.optional(Schema.String),
});
export type NeoPiNativeSessionSummary = typeof NeoPiNativeSessionSummary.Type;
export const NeoPiNativeSessionsListInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(Schema.String),
});
export type NeoPiNativeSessionsListInput = typeof NeoPiNativeSessionsListInput.Type;
export const NeoPiNativeSessionsListResult = Schema.Struct({
  sessions: Schema.Array(NeoPiNativeSessionSummary),
  diagnostics: Schema.Array(
    Schema.Struct({ providerInstanceId: ProviderInstanceId, message: Schema.String }),
  ),
});
export type NeoPiNativeSessionsListResult = typeof NeoPiNativeSessionsListResult.Type;
export const NeoPiNativeSessionsOpenInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionFile: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
});
export type NeoPiNativeSessionsOpenInput = typeof NeoPiNativeSessionsOpenInput.Type;
export const NeoPiNativeSessionsOpenResult = Schema.Struct({
  ref: NeoPiNativeSessionRef,
  sessionId: Schema.String,
  cwd: Schema.String,
  attachment: NeoPiNativeSessionAttachment,
  capabilities: Schema.Array(Schema.String),
  state: NeoPiNativeSessionRecord,
});
export type NeoPiNativeSessionsOpenResult = typeof NeoPiNativeSessionsOpenResult.Type;
export const NeoPiNativeSessionsRequestInput = Schema.Struct({
  ref: NeoPiNativeSessionRef,
  command: NeoPiNativeSessionCommand,
  /** Uploaded client media, resolved by the server before the native prompt is dispatched. */
  attachments: Schema.optional(
    Schema.Array(Schema.Union([ChatImageAttachment, ChatFileAttachment])).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  ),
});
export type NeoPiNativeSessionsRequestInput = typeof NeoPiNativeSessionsRequestInput.Type;
export const NeoPiNativeSessionsWatchInput = Schema.Struct({ ref: NeoPiNativeSessionRef });
export type NeoPiNativeSessionsWatchInput = typeof NeoPiNativeSessionsWatchInput.Type;
export const NeoPiNativeSessionsStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    session: NeoPiNativeSessionsOpenResult,
    journal: Schema.Unknown,
  }),
  Schema.Struct({ type: Schema.Literal("event"), frame: NeoPiNativeSessionCommand }),
  Schema.Struct({ type: Schema.Literal("answered"), id: Schema.String }),
  /**
   * `code` names why the owner went away: `detached` after an explicit disconnect,
   * `owner_exited` when the terminal that owned the session quit and nothing replaced it.
   */
  Schema.Struct({
    type: Schema.Literal("closed"),
    reason: Schema.String,
    code: Schema.optional(Schema.String),
  }),
  /** The terminal owner exited. The server is waiting for a replacement; a fresh `snapshot` follows. */
  Schema.Struct({ type: Schema.Literal("reconnecting"), reason: Schema.String }),
]);
export type NeoPiNativeSessionsStreamEvent = typeof NeoPiNativeSessionsStreamEvent.Type;
export const NeoPiNativeSessionsCloseInput = NeoPiNativeSessionsWatchInput;
export type NeoPiNativeSessionsCloseInput = typeof NeoPiNativeSessionsCloseInput.Type;
export const NeoPiNativeSessionsCloseResult = Schema.Struct({ closed: Schema.Boolean });
export type NeoPiNativeSessionsCloseResult = typeof NeoPiNativeSessionsCloseResult.Type;
export const NeoPiNativeSessionsSetSettledInput = Schema.Struct({
  ref: NeoPiNativeSessionRef,
  settled: Schema.Boolean,
});
export type NeoPiNativeSessionsSetSettledInput = typeof NeoPiNativeSessionsSetSettledInput.Type;
export const NeoPiNativeSessionsSetSettledResult = Schema.Struct({ settled: Schema.Boolean });
export type NeoPiNativeSessionsSetSettledResult = typeof NeoPiNativeSessionsSetSettledResult.Type;
export class NeoPiNativeSessionsError extends Schema.TaggedError<NeoPiNativeSessionsError>()(
  "NeoPiNativeSessionsError",
  { message: Schema.String, code: Schema.optional(Schema.String) },
) {}
