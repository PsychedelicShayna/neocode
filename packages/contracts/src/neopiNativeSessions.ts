import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { NonNegativeInt } from "./baseSchemas.ts";
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

// ---------------------------------------------------------------------------
// Observation: one essential `watch` stream per visible view (it is the lease),
// bulk state pulled by cursor through unary `read`, demand through `setDemand`,
// and essential flow control returned through `credit`.
// ---------------------------------------------------------------------------

/** Unique per key mutation inside one identity domain; essential and bulk share it. */
export const NeoPiNativeRevision = NonNegativeInt;
/** Monotonic creation order of a projection key; fixes a pass cohort. */
export const NeoPiNativeOrdinal = NonNegativeInt;

/**
 * Everything that issued a cursor, reply, build or finalizer. Any field
 * changing makes older cursors unusable: the next read rebases with a full pass.
 * `branchGeneration` changes on navigation, never on append.
 */
export const NeoPiNativeObservationDomain = Schema.Struct({
  serverIncarnation: Schema.String,
  ownerEpoch: NonNegativeInt,
  projectionIncarnation: NonNegativeInt,
  buildAttempt: NonNegativeInt,
  branchGeneration: NonNegativeInt,
});
export type NeoPiNativeObservationDomain = typeof NeoPiNativeObservationDomain.Type;

/**
 * Typed stop outcome, built at decode from whitelisted fields only. The native
 * `stopDetails` object (its private fallback fields, handle and frozen request)
 * never crosses this boundary; each value is exactly as the source gave it.
 */
export const NeoPiStopOutcome = Schema.Struct({
  /** `stopDetails.type`. */
  stopType: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.NullOr(Schema.String)),
  explanation: Schema.optionalKey(Schema.NullOr(Schema.String)),
  errorClassificationMessage: Schema.optionalKey(Schema.String),
  errorStatus: Schema.optionalKey(Schema.Number),
  errorId: Schema.optionalKey(Schema.Number),
});
export type NeoPiStopOutcome = typeof NeoPiStopOutcome.Type;

/** A native message record that has passed the stop-outcome filter: `stopDetails` is rejected. */
export const NeoPiNativeObservedMessage = Schema.StructWithRest(
  Schema.Struct({ stopDetails: Schema.optionalKey(Schema.Never) }),
  [NeoPiNativeSessionRecord],
);
export type NeoPiNativeObservedMessage = typeof NeoPiNativeObservedMessage.Type;

/** One file of the built-in edit tool's argument preview, as NeoPi emits it. */
export const NeoPiEditFilePreview = Schema.Struct({
  path: Schema.String,
  diff: Schema.optionalKey(Schema.String),
  firstChangedLine: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
  op: Schema.optionalKey(Schema.String),
  rename: Schema.optionalKey(Schema.String),
});
export type NeoPiEditFilePreview = typeof NeoPiEditFilePreview.Type;

export const NeoPiToolCoverage = Schema.Literals(["authoritative", "since-build", "unknown"]);
export type NeoPiToolCoverage = typeof NeoPiToolCoverage.Type;

/** Value of one projection key, by state class. */
export const NeoPiNativeEntityValue = Schema.Union([
  /** `open → ended → durable(entryId)`; an ended message never regresses. */
  Schema.Struct({
    class: Schema.Literal("message"),
    messageId: Schema.String,
    phase: Schema.Literals(["open", "ended", "durable"]),
    entryId: Schema.NullOr(Schema.String),
    message: NeoPiNativeObservedMessage,
    stopOutcome: Schema.optionalKey(NeoPiStopOutcome),
  }),
  /** Folded tool state; a terminal or background-final update stays until its durable result joins. */
  Schema.Struct({
    class: Schema.Literal("tool"),
    toolCallId: Schema.String,
    coverage: NeoPiToolCoverage,
    state: NeoPiNativeSessionRecord,
  }),
  /** Latest edit-tool preview per call; only the built-in `edit` tool has this reducer. */
  Schema.Struct({
    class: Schema.Literal("editPreview"),
    toolCallId: Schema.String,
    generation: NonNegativeInt,
    /** False for the final preview. */
    streaming: Schema.Boolean,
    files: Schema.Array(NeoPiEditFilePreview),
  }),
  Schema.Struct({
    class: Schema.Literals([
      "run",
      "operation",
      "setting",
      "roster",
      "fault",
      "receipt",
      "presentation",
    ]),
    value: NeoPiNativeSessionRecord,
  }),
]);
export type NeoPiNativeEntityValue = typeof NeoPiNativeEntityValue.Type;
export type NeoPiNativeEntityClass = NeoPiNativeEntityValue["class"];

export const NeoPiNativeEntity = Schema.Struct({
  key: Schema.String,
  ordinal: NeoPiNativeOrdinal,
  revision: NeoPiNativeRevision,
  value: NeoPiNativeEntityValue,
});
export type NeoPiNativeEntity = typeof NeoPiNativeEntity.Type;

/**
 * A removed key. Absence in a patch or incremental pass never means removal.
 * `joinEntryId` is set when a live message or tool was retired by its durable
 * journal entry: the client keeps the live row until it holds that entry, and
 * never erases it before (r12 C2 coherence invariant 2).
 */
export const NeoPiNativeTombstone = Schema.Struct({
  key: Schema.String,
  ordinal: NeoPiNativeOrdinal,
  revision: NeoPiNativeRevision,
  joinEntryId: Schema.optionalKey(Schema.String),
});
export type NeoPiNativeTombstone = typeof NeoPiNativeTombstone.Type;

/**
 * One slice of an entity whose encoded value exceeds the reply budget. The
 * entity is the `NeoPiNativeEntity` JSON formed by joining `data` of indexes
 * `0..count-1` at one `revision`; a newer revision restarts at index 0.
 */
export const NeoPiNativeSegment = Schema.Struct({
  key: Schema.String,
  revision: NeoPiNativeRevision,
  index: NonNegativeInt,
  count: NonNegativeInt,
  encodedBytes: NonNegativeInt,
  data: Schema.String,
});
export type NeoPiNativeSegment = typeof NeoPiNativeSegment.Type;

/**
 * Ordered retention for live-only records without a reducer: every
 * `tool_stream_update` of a tool other than `edit`, and every notice. The inbox
 * is bounded, and nothing is retained while no view holds a lease; dropped
 * records are replaced by a `gap` covering `fromSeq..toSeq`, whose `seq` is
 * `toSeq`. A gap that grows keeps its `fromSeq` and replaces the shorter one
 * with the same `fromSeq`.
 */
export const NeoPiNativeInboxRecord = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool_stream_update"),
    seq: NonNegativeInt,
    toolCallId: Schema.String,
    toolName: Schema.String,
    update: Schema.optionalKey(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("notice"),
    seq: NonNegativeInt,
    level: Schema.String,
    message: Schema.String,
    source: Schema.optionalKey(Schema.String),
  }),
  /**
   * Records received and no longer retained, with no replay source; never a
   * temporary read failure. `evicted`: confirmed eviction at the inbox bound.
   * `not-observed`: dropped while no view held a lease (missing coverage);
   * coverage must not be presented as complete across it. `mixed`: gaps of
   * both reasons merged because gaps alone exceeded the bound; records were
   * missed here, and whether a viewer fell behind or none was attached is no
   * longer known. Adjacent gaps of one reason merge and keep it. Counts are of
   * records received in the whole interval.
   */
  Schema.Struct({
    type: Schema.Literal("gap"),
    seq: NonNegativeInt,
    reason: Schema.Literals(["evicted", "not-observed", "mixed"]),
    fromSeq: NonNegativeInt,
    toSeq: NonNegativeInt,
    /** Server receive times (ms since epoch) of the first and last dropped record. */
    firstReceivedAt: Schema.Number,
    lastReceivedAt: Schema.Number,
    notices: NonNegativeInt,
    toolStreams: Schema.Array(
      Schema.Struct({
        toolCallId: Schema.String,
        toolName: Schema.String,
        updates: NonNegativeInt,
      }),
    ),
    /** More tool calls were dropped than `toolStreams` lists; their per-call detail is not known. */
    toolStreamsTruncated: Schema.Boolean,
  }),
]);
export type NeoPiNativeInboxRecord = typeof NeoPiNativeInboxRecord.Type;

/** A native journal entry after the stop-outcome filter; `NeoPiJournalEntry` plus the outcome. */
export const NeoPiNativeObservedJournalEntry = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    parentId: Schema.NullOr(Schema.String),
    type: Schema.String,
    timestamp: Schema.String,
    message: Schema.optionalKey(NeoPiNativeObservedMessage),
    stopOutcome: Schema.optionalKey(NeoPiStopOutcome),
  }),
  [NeoPiNativeSessionRecord],
);
export type NeoPiNativeObservedJournalEntry = typeof NeoPiNativeObservedJournalEntry.Type;

/**
 * Journal entries joined by entry identity. `append` extends the head the
 * cursor's `journalAt` names; `horizon` is a fresh backward page ending at
 * `leafId`, joined by entry id, and an unjoined older range stays a placeholder.
 */
export const NeoPiNativeJournalSlice = Schema.Struct({
  continuity: Schema.Literals(["append", "horizon"]),
  leafId: Schema.NullOr(Schema.String),
  entries: Schema.Array(NeoPiNativeObservedJournalEntry),
  /** For `horizon`: the native page cursor for the entries before it, which fills a placeholder on demand. */
  nextCursor: Schema.optionalKey(Schema.String),
});
export type NeoPiNativeJournalSlice = typeof NeoPiNativeJournalSlice.Type;

/**
 * A pass in progress. Its cohort is the keys with ordinal ≤ `lastOrdinal`,
 * fixed with `watermark` when the pass starts. `afterOrdinal` is the ordinal of
 * the last key sent: ordinals are unique, and it stays a valid position even
 * after that key's tombstone expires mid-pass. `segment` is set while an
 * oversized value is mid-transfer.
 */
export const NeoPiNativePass = Schema.Struct({
  kind: Schema.Literals(["incremental", "full"]),
  passId: Schema.String,
  watermark: NeoPiNativeRevision,
  lastOrdinal: NeoPiNativeOrdinal,
  afterOrdinal: Schema.NullOr(NeoPiNativeOrdinal),
  segment: Schema.NullOr(
    Schema.Struct({ key: Schema.String, revision: NeoPiNativeRevision, nextIndex: NonNegativeInt }),
  ),
});
export type NeoPiNativePass = typeof NeoPiNativePass.Type;

/** Client-held read position. `pass` is null between passes. */
export const NeoPiNativeCursor = Schema.Struct({
  epoch: NeoPiNativeObservationDomain,
  base: NeoPiNativeRevision,
  pass: Schema.NullOr(NeoPiNativePass),
  inboxSeq: NonNegativeInt,
  journalAt: Schema.NullOr(Schema.String),
});
export type NeoPiNativeCursor = typeof NeoPiNativeCursor.Type;

export const NeoPiNativeSessionsReadInput = Schema.Struct({
  leaseId: Schema.String,
  /** Strictly increasing per lease; one not above the highest admitted is rejected as stale, and a newer one ends a waiting older read. */
  readId: NonNegativeInt,
  /**
   * Null starts a full pass. A cursor held from an earlier lease may be sent: the
   * server judges it by its domain alone, and a different domain starts a full pass.
   */
  cursor: Schema.NullOr(NeoPiNativeCursor),
});
export type NeoPiNativeSessionsReadInput = typeof NeoPiNativeSessionsReadInput.Type;

export const NeoPiNativeSessionsReadResult = Schema.Union([
  /** Nothing changed before the lease's read deadline; send the same cursor again. */
  Schema.Struct({ type: Schema.Literal("unchanged") }),
  /** No projection is published yet; essential state still arrives on the watch stream. */
  Schema.Struct({ type: Schema.Literal("building") }),
  Schema.Struct({
    type: Schema.Literal("pass"),
    passId: Schema.String,
    /**
     * The pass this reply belongs to. Only completing a `full` pass removes, by
     * absence, held entities at or below the completed watermark.
     */
    kind: Schema.Literals(["incremental", "full"]),
    baseCursor: NeoPiNativeCursor,
    /** Revision through which the returned cohort is covered. */
    coveredThrough: NeoPiNativeRevision,
    /** The cursor for the next read; its `pass` is null once this pass completed. */
    continuation: NeoPiNativeCursor,
    /** The whole pass was answered in this one reply, at one revision. */
    complete: Schema.Boolean,
    /** An incremental pass was promoted to a fresh full pass; discard accumulated membership. */
    promoted: Schema.Boolean,
    entities: Schema.Array(NeoPiNativeEntity),
    tombstones: Schema.Array(NeoPiNativeTombstone),
    segments: Schema.Array(NeoPiNativeSegment),
    inbox: Schema.Array(NeoPiNativeInboxRecord),
    journal: Schema.NullOr(NeoPiNativeJournalSlice),
  }),
]);
export type NeoPiNativeSessionsReadResult = typeof NeoPiNativeSessionsReadResult.Type;

export const NeoPiNativeDemandItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["summary", "transcript", "roster"]) }),
  Schema.Struct({ kind: Schema.Literal("child"), childId: Schema.String, runToken: Schema.String }),
]);
export type NeoPiNativeDemandItem = typeof NeoPiNativeDemandItem.Type;

export const NeoPiNativeSessionsSetDemandInput = Schema.Struct({
  leaseId: Schema.String,
  generation: NonNegativeInt,
  demand: Schema.Array(NeoPiNativeDemandItem),
});
export type NeoPiNativeSessionsSetDemandInput = typeof NeoPiNativeSessionsSetDemandInput.Type;
/**
 * `applied`: a new generation took effect. `unchanged`: same generation, same
 * demand. `stale`: a lower generation, ignored. The same generation with a
 * different demand fails with `demand_conflict`.
 */
export const NeoPiNativeSessionsSetDemandResult = Schema.Struct({
  outcome: Schema.Literals(["applied", "unchanged", "stale"]),
});
export type NeoPiNativeSessionsSetDemandResult = typeof NeoPiNativeSessionsSetDemandResult.Type;

/**
 * Returns essential credit. `applied` is the cumulative count of watch-stream
 * envelopes the client has taken off its stream queue and applied on this
 * lease, so a retry is harmless. The server keeps sent − applied ≤ the lease's
 * `creditWindow`, which never exceeds the client's stream queue capacity, so
 * the client's socket reader never waits on this stream.
 */
export const NeoPiNativeSessionsCreditInput = Schema.Struct({
  leaseId: Schema.String,
  applied: NonNegativeInt,
});
export type NeoPiNativeSessionsCreditInput = typeof NeoPiNativeSessionsCreditInput.Type;

/** Error codes carried by `NeoPiNativeSessionsError.code` on observation RPCs. */
export const NEOPI_NATIVE_OBSERVATION_ERROR_CODES = {
  /** The lease is released or was never issued; its watch stream has ended. */
  leaseUnknown: "lease_unknown",
  /** A read with an older `readId` than one already admitted on the lease. */
  staleRead: "stale_read",
  /** `setDemand` repeated a generation with a different demand. */
  demandConflict: "demand_conflict",
} as const;

/** Server-side observation state, as essential lifecycle facts. */
export const NeoPiNativeObservationLifecycle = Schema.Literals([
  "building",
  "observing",
  /** The owner exited; a successor is being awaited. */
  "reconnecting",
  /** No live authority; start and takeover are explicit user routes. Ends the stream. */
  "owner-stopped",
  /** Discovery timed out; cached state is kept and only attach is retried. */
  "authority-unresolved",
  /** A live owner was found that this server cannot attach to; nothing is started. Ends the stream. */
  "incompatible",
  /** Explicit close or detach. Ends the stream. */
  "detached",
  /** The session identity changed. Ends the stream. */
  "identity-changed",
]);
export type NeoPiNativeObservationLifecycle = typeof NeoPiNativeObservationLifecycle.Type;

/**
 * Essential `watch` envelopes. Each one consumes one unit of credit. Becomes
 * the `watch` success schema when the server and client cut over, replacing
 * `NeoPiNativeSessionsStreamEvent`.
 */
export const NeoPiNativeEssentialEnvelope = Schema.Union([
  /** Always first. The lease lives exactly as long as this stream. */
  Schema.Struct({
    type: Schema.Literal("leased"),
    leaseId: Schema.String,
    domain: NeoPiNativeObservationDomain,
    creditWindow: NonNegativeInt,
    /** How long an idle `read` waits before answering `unchanged`. */
    readDeadlineMs: NonNegativeInt,
  }),
  /**
   * What `open` would describe now (ref, attachment, capabilities, native state).
   * Sent right after `leased`, and again whenever it changes: a successor owner,
   * an adopted identity, a takeover.
   */
  Schema.Struct({
    type: Schema.Literal("session"),
    revision: NeoPiNativeRevision,
    session: NeoPiNativeSessionsOpenResult,
  }),
  Schema.Struct({
    type: Schema.Literal("identity"),
    revision: NeoPiNativeRevision,
    domain: NeoPiNativeObservationDomain,
    sessionId: Schema.String,
    sessionFile: Schema.String,
    leafId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("lifecycle"),
    revision: NeoPiNativeRevision,
    state: NeoPiNativeObservationLifecycle,
    reason: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("status"),
    revision: NeoPiNativeRevision,
    live: NeoPiNativeSessionLive,
  }),
  /** A pending interaction opened; `request` is its native record. */
  Schema.Struct({
    type: Schema.Literal("obligation-opened"),
    revision: NeoPiNativeRevision,
    id: Schema.String,
    request: NeoPiNativeSessionCommand,
  }),
  Schema.Struct({
    type: Schema.Literal("obligation-settled"),
    revision: NeoPiNativeRevision,
    id: Schema.String,
    outcome: Schema.Literals(["answered", "cancelled", "resulted"]),
  }),
]);
export type NeoPiNativeEssentialEnvelope = typeof NeoPiNativeEssentialEnvelope.Type;

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
