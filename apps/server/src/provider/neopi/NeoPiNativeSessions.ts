// @effect-diagnostics nodeBuiltinImport:off -- native session identity is a canonical filesystem path; lease ids are random UUIDs.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  NEOPI_NATIVE_OBSERVATION_ERROR_CODES,
  NeoPiJournalPage,
  NeoPiModelsError,
  type NeoPiNativeObservationDomain,
  NeoPiNativeSessionCommand,
  NeoPiNativeSessionLive,
  NeoPiNativeSessionRecord,
  NeoPiNativeSessionsError,
  type NeoPiNativeEssentialEnvelope,
  type NeoPiNativeObservationLifecycle,
  type NeoPiNativeSessionRef,
  type NeoPiNativeSessionSummary,
  type NeoPiNativeSessionsCreditInput,
  type NeoPiNativeSessionsListInput,
  type NeoPiNativeSessionsListResult,
  type NeoPiNativeSessionsOpenInput,
  type NeoPiNativeSessionsOpenResult,
  type NeoPiNativeSessionsReadInput,
  type NeoPiNativeSessionsReadResult,
  type NeoPiNativeSessionsRequestInput,
  type NeoPiNativeSessionsSetDemandInput,
  type NeoPiNativeSessionsSetDemandResult,
  type NeoPiNativeSessionsSetSettledInput,
  type NeoPiNativeSessionsSetSettledResult,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  make as makeClient,
  type HostToolCallFrame,
  type HostToolCancelFrame,
  type NeoPiRpcClient,
  type NeoPiRpcFrameSink,
  type SessionEventFrame,
  type UiRequestFrame,
} from "effect-neopi-rpc/client";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import { MAX_RPC_REASSEMBLED_BYTES } from "effect-neopi-rpc/frame";
import type { NonEmptyReadonlyArray } from "effect/Array";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  makeNeoPiNativeSettledStore,
  type NeoPiNativeSettledRecord,
  type NeoPiNativeSettledStore,
  resolveNativeSettlement,
} from "./NeoPiNativeSettlement.ts";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import { makeNeoPiNativeHostToolPump } from "./NeoPiHostToolBridge.ts";
import { makeNeoPiLoginUi, type NeoPiLoginUi } from "./NeoPiLoginUi.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  neoPiAvailableCommands,
  neoPiSlashCommandName,
  neoPiTerminalTextRoute,
} from "./NeoPiCommandCatalog.ts";
import { NEOPI_CAPABILITIES } from "./NeoPiCompatibility.ts";
import { makeSharedListing } from "./NeoPiSharedListing.ts";
import { parseNeoPiLaunchArguments } from "./NeoPiLaunchArgs.ts";
import { prepareNeoPiNativePrompt } from "./NeoPiNativeAttachments.ts";
import {
  decodeNeoPiControlRegistry,
  neoPiOwnerVersion,
  olderOwnerMessage,
  resolveNativeLive,
} from "./NeoPiNativeLiveness.ts";
import { NeoPiNativeProjection, type NeoPiNativeRequestMark } from "./NeoPiNativeProjection.ts";
import { readNeoPiNativeObservation, sameObservationDomain } from "./NeoPiNativeCursor.ts";
import { observeNeoPiJournalEntry, observeNeoPiMessage } from "./NeoPiStopOutcome.ts";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";
import {
  neoPiSessionCatalogSource,
  type NeoPiSessionCatalogSource,
} from "./NeoPiSessionCatalogSource.ts";

const CatalogRow = Schema.Struct({
  path: Schema.String,
  id: Schema.String,
  cwd: Schema.String,
  title: Schema.NullOr(Schema.String),
  firstMessage: Schema.String,
  modified: Schema.String,
  inUse: Schema.NullOr(Schema.Struct({ pid: Schema.Number })),
  control: Schema.NullOr(Schema.Struct({ instanceId: Schema.String })),
  /** Present only for `sessions list --live`; null when no owner answered in time. */
  live: Schema.optional(Schema.NullOr(NeoPiNativeSessionLive)),
});
type CatalogRow = typeof CatalogRow.Type;
const Catalog = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), sessions: Schema.Array(CatalogRow) }),
);
const StateIdentity = Schema.Struct({ sessionId: Schema.String, sessionFile: Schema.String });
const JournalIdentity = Schema.Struct({
  sessionId: Schema.String,
  sessionFile: Schema.String,
  leafId: Schema.NullOr(Schema.String),
});
const UiResponse = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
  NeoPiNativeSessionRecord,
]);
const ControlIdentity = Schema.Struct({
  session: StateIdentity,
  cwd: Schema.String,
  revisions: Schema.Struct({ generation: Schema.Number }),
});
/** Child roster history and background jobs, as the owner advertises them. */
const SUBAGENT_HISTORY_CAPABILITY = "subagent_history";
const JOBS_CAPABILITY = "background_jobs";
/** Frames after which the owner's `get_state` aggregates may have moved. */
const STATE_REFRESH_EVENTS: ReadonlySet<string> = new Set([
  "model_changed",
  "models_configuration_changed",
  "thinking_level_changed",
  "chat_mode_changed",
  "mode_changed",
  "prompt_result",
  "agent_end",
  "session_settled",
  "manual_compaction_end",
  "auto_compaction_end",
  "advisor_cost_changed",
  "journal_state",
  "journal_entry",
]);
/** A burst of triggers costs one trailing read per class. */
const REFRESH_MIN_GAP = Duration.seconds(1);
/**
 * A terminal owner's control connection carries no `job_lifecycle` frames and can
 * miss telemetry changed elsewhere, so an observed one is re-read on this cadence.
 */
const TERMINAL_POLL_INTERVAL = Duration.seconds(5);
/**
 * Frame types still folded while no lease is held (C1): identity, pending interactions
 * and the live-only inbox (which becomes a "not observed" gap). Everything else is bulk.
 */
const UNOBSERVED_FOLDED: ReadonlySet<string> = new Set([
  "journal_state",
  "extension_ui_request",
  "tool_approval_request",
  "tool_approval_cancel",
  "plan_proposal_request",
  "plan_proposal_cancel",
  "host_tool_call",
  "host_tool_cancel",
  "host_uri_request",
  "host_uri_cancel",
  "tool_stream_update",
  "notice",
]);
/** Build retries are bounded in rate and never terminal (C3.5). */
/** Fault key for an owner that refused to raise its subagent subscription level (value: `{source, level: "error", requestedLevel, message}`). */
const SUBAGENT_FAULT_KEY = "fault:subagent-subscription";
const BUILD_RETRY_MIN_MS = 250;
const BUILD_RETRY_MAX_MS = 5_000;
/** One attach-only discovery attempt; past it the authority is unresolved and attach is retried. */
const DISCOVERY_TIMEOUT = Duration.seconds(10);
const DISCOVERY_RETRY_MIN_MS = 1_000;
const DISCOVERY_RETRY_MAX_MS = 30_000;
/**
 * Essential envelopes outstanding per lease. The client's RPC stream queue holds
 * 16 chunks; staying below it means its socket reader never waits on this stream.
 */
const CREDIT_WINDOW = 8;
/** An idle `read` answers `unchanged` (or `building`) after this long. */
const READ_DEADLINE_MS = 20_000;
/** Per `read` reply: records visited and encoded bytes; larger values go in segments. */
const READ_LIMITS = { scanSteps: 1024, replyBytes: 512 * 1024 };
const PROJECTION_TOMBSTONES = 4096;
const PROJECTION_JOURNAL_ENTRIES = 512;
/** Lifecycle states after which the watch stream ends. */
const TERMINAL_LIFECYCLE: ReadonlySet<NeoPiNativeObservationLifecycle> = new Set([
  "owner-stopped",
  "incompatible",
  "detached",
  "identity-changed",
]);
/**
 * How long a vanished terminal owner (`/restart`, a quit) gets to come back before
 * NeoCode may start an owner of its own. Starting one earlier would take the
 * session's lease out from under a terminal that is still restarting.
 */
const OWNER_REATTACH_GRACE_MS = 10_000;
const OWNER_REATTACH_POLL = "500 millis";
/** Past the grace period an unresolved owner is still looked for, at this rate. */
const OWNER_UNRESOLVED_RETRY = "5 seconds";
/** Reattach failures that mean a live owner exists that this server cannot attach to. */
const INCOMPATIBLE_OWNER_CODES: ReadonlySet<string> = new Set([
  "owner_outdated",
  "unsupported",
  "session_in_use",
]);
/** A candidate successor's frames held until it is accepted; more are dropped (the rebuild rereads state). */
const CANDIDATE_FRAME_LIMIT = 4096;
/** How long a leaf announcement may wait for its journal entry before it counts as a navigation. */
const PENDING_LEAF_SETTLE = Duration.seconds(2);
/** A refused lowering of the owner's subagent level is retried this many times, at the build backoff. */
const LEVEL_LOWERING_RETRIES = 8;
/** Re-reads of the roster for children last seen running before an unwatched interval, at the build backoff. */
const UNOBSERVED_CHILD_REREADS = 8;
/**
 * Child statuses after which nothing more is owed: finished activations in lifecycle
 * frames, and `parked`, `aborted` or `idle` (result accepted) in the owner's history.
 */
const SETTLED_CHILD_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "aborted",
  "parked",
  "idle",
]);
/** How long a lease may hold a closed session without taking its terminal envelope. */
const CLOSED_LEASE_GRACE = Duration.seconds(5);
const nativeError = (cause: unknown): NeoPiNativeSessionsError => {
  if (Schema.is(NeoPiNativeSessionsError)(cause)) return cause;
  const error = new NeoPiNativeSessionsError({
    message: cause instanceof Error ? cause.message : String(cause),
    ...(cause instanceof NeoPiRpcError && cause.code ? { code: cause.code } : {}),
  });
  // Keep the original failure server-side without extending the public error schema.
  Object.defineProperty(error, "cause", { value: cause, configurable: true });
  return error;
};
const fail = (message: string, code = "session_unavailable") =>
  new NeoPiNativeSessionsError({ message, code });
const isNativeRecord = Schema.is(NeoPiNativeSessionRecord);
const decodeJournalIdentity = Schema.decodeUnknownEffect(JournalIdentity);
const decodeJournalPage = Schema.decodeUnknownEffect(NeoPiJournalPage);
const observeMessageRecord = (value: unknown) => {
  if (!isNativeRecord(value)) return value;
  const { message, stopOutcome } = observeNeoPiMessage(value);
  return stopOutcome === undefined ? message : { ...message, stopOutcome };
};
/**
 * Request replies that carry native messages pass the stop-outcome filter, like
 * live frames and build pages (r12 §P): journal `entries`, a `message` and
 * `messages`. The private stop fields never leave the server.
 */
const observeNeoPiReply = (reply: unknown): unknown => {
  if (!isNativeRecord(reply)) return reply;
  const observed: Record<string, unknown> = { ...reply };
  if (Array.isArray(reply.entries))
    observed.entries = reply.entries.map(
      (entry) =>
        observeNeoPiJournalEntry(entry) ??
        (isNativeRecord(entry) && "message" in entry
          ? { ...entry, message: observeMessageRecord(entry.message) }
          : entry),
    );
  if ("message" in reply) observed.message = observeMessageRecord(reply.message);
  if (Array.isArray(reply.messages)) observed.messages = reply.messages.map(observeMessageRecord);
  return observed;
};
/** How long one catalog scan answers every client's listing request. */
const CATALOG_SHARE_TTL = Duration.seconds(8);
const rowKey = (providerInstanceId: string, file: string) => `${providerInstanceId}\0${file}`;

export interface NeoPiNativeProfile {
  readonly providerInstanceId: ProviderInstanceId;
  readonly source: NeoPiSessionCatalogSource;
  /** The configured instance must still be the same object, not a replacement profile. */
  readonly validate: Effect.Effect<void, NeoPiNativeSessionsError>;
}
export interface NeoPiNativeConnection {
  readonly client: Pick<
    NeoPiRpcClient,
    "capabilities" | "request" | "respondUi" | "writeFrame" | "exit"
  >;
  readonly attachment: "owned" | "terminal";
  readonly cwd: string;
  /** A startup dialog can block stdio commands; the native control reader remains available. */
  readonly readState?: Effect.Effect<unknown, NeoPiNativeSessionsError>;
  readonly hostTools?: {
    readonly bind: (ref: NeoPiNativeSessionRef) => Effect.Effect<void, NeoPiNativeSessionsError>;
    readonly revoke: Effect.Effect<void>;
  };
}
/**
 * Receives every native frame (events, UI requests, host-tool calls, URI requests)
 * synchronously, in parser order, before the next frame is read (B1 sink). Must not
 * throw and must not wait.
 */
export interface NeoPiNativeFrameObserver {
  readonly frame: (frame: SessionEventFrame) => void;
  /** A host-tool call this server answered itself. */
  readonly resulted: (id: string) => void;
}
export interface NeoPiNativeSessionsDependencies {
  readonly profileIds: Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
  readonly profileChanges?: Stream.Stream<void>;
  readonly profile: (
    id: ProviderInstanceId,
  ) => Effect.Effect<NeoPiNativeProfile, NeoPiNativeSessionsError>;
  readonly canonicalize: (file: string) => Effect.Effect<string, NeoPiNativeSessionsError>;
  readonly preparePrompt: (
    input: NeoPiNativeSessionsRequestInput,
  ) => Effect.Effect<NeoPiNativeSessionCommand, NeoPiNativeSessionsError>;
  readonly catalog: (
    profile: NeoPiNativeProfile,
    cwd?: string,
    file?: string,
  ) => Effect.Effect<ReadonlyArray<CatalogRow>, NeoPiNativeSessionsError>;
  /** Runs between a read's scan and its wait; tests inject a change there. */
  readonly afterReadScan?: Effect.Effect<void>;
  /** Drops the shared listing so the next list rescans; absent in tests with a fresh catalog per call. */
  readonly invalidateCatalog?: Effect.Effect<void>;
  readonly connect: (
    profile: NeoPiNativeProfile,
    input: NeoPiNativeSessionsOpenInput,
    observer: NeoPiNativeFrameObserver,
    /** `attach` joins a live owner only and never starts one. */
    mode?: "auto" | "attach",
  ) => Effect.Effect<NeoPiNativeConnection, NeoPiNativeSessionsError, Scope.Scope>;
  /** Persisted settle decisions and the auto-settle window; omitted, nothing is ever settled. */
  readonly settlement?: {
    readonly store: NeoPiNativeSettledStore;
    readonly autoSettleAfterDays: Effect.Effect<number | null>;
  };
}
interface NativeSession {
  readonly profile: NeoPiNativeProfile;
  /** Replaced in place when a terminal owner is swapped for its successor. */
  native: NeoPiNativeConnection;
  nativeScope: Scope.Closeable;
  readonly scope: Scope.Closeable;
  /** The owner projection (C1): every native frame folds into it synchronously. */
  readonly projection: NeoPiNativeProjection;
  /** Open `watch` streams; each one is a lease. */
  readonly observations: Set<Observation>;
  /** Woken after every projection change; idle reads wait here. */
  readonly changed: Set<() => void>;
  /** Bumped by every change, so a read can tell one landed between its scan and its wait. */
  changeCount: number;
  /** Snapshot markers seen on the current connection, for the build's marker rule (C3.1). */
  readonly markers: NativeMarkers;
  /**
   * Each spelling of a session file the owner used, mapped to the one the projection
   * was fed for it. Identity is compared by value, so an alias of the same session
   * must keep feeding one value or it would read as an identity change.
   */
  readonly files: Map<string, string>;
  building: boolean;
  /** The build attempt in flight; a new owner epoch abandons it (its connection is gone). */
  attempt: Fiber.Fiber<boolean, unknown> | null;
  /** The last status summary sent, so only changes are sent. */
  statusKey: string;
  /** Reads owed after frames that change `get_state`, jobs or the roster. */
  readonly refreshes: Set<NativeRefresh>;
  refreshing: boolean;
  /** The subagent level last settled on the native peer, and under which owner epoch. */
  subagentLevel: { readonly epoch: number; readonly level: SubagentLevel } | null;
  /** The demand actor is applying a level. */
  demanding: boolean;
  /** The last level the owner refused to take, so the same request is not repeated. */
  refusal: { readonly epoch: number; readonly level: SubagentLevel } | null;
  /** The timer that resolves a leaf announcement no entry followed, with the leaf it belongs to. */
  leafWatch: { readonly leafId: string; cancelled: boolean } | null;
  /** Counts `agent_start`/`agent_end` frames; a `get_state` reply older than one cannot set `busy`. */
  busyEpoch: number;
  /** Bulk frames were skipped while no lease was held; the first lease rebuilds first. */
  bulkStale: boolean;
  /** When the last lease left, while some view was following children; null while watched. */
  unwatchedSince: number | null;
  readonly pendingUi: Map<string, SessionEventFrame>;
  readonly modelChanges: PubSub.PubSub<void>;
  readonly modelUi: NeoPiLoginUi;
  readonly openedAt: string;
  ref: NeoPiNativeSessionRef;
  sessionId: string;
  cwd: string;
  cwdFile: string;
  state: Record<string, unknown>;
  closed: boolean;
  /** A turn is in flight, from `agent_start`/`agent_end` frames and `get_state`. */
  busy: boolean;
  /** Set while the terminal owner is gone and its successor is awaited; requests wait on it. */
  recovery: Deferred.Deferred<void, NeoPiNativeSessionsError> | null;
  /** A prompt is waiting: when the grace period ends, start an owner instead of closing. */
  takeoverRequested: boolean;
}
interface NativeMarkers {
  count: number;
  last: { readonly sessionId: string; readonly sessionFile: string } | null;
}
type NativeRefresh = "state" | "jobs" | "roster" | "page";
/** NeoPi's per-connection subagent subscription: none, lifecycle and progress, or also every child step. */
type SubagentLevel = "off" | "progress" | "events";
const SUBAGENT_LEVEL_RANK: Readonly<Record<SubagentLevel, number>> = {
  off: 0,
  progress: 1,
  events: 2,
};
/** One `watch` stream: the lease (C4) and its essential outbox (C2). */
interface Observation {
  readonly leaseId: string;
  /** The connection that opened this watch: the only one that may read, set demand or return credit. */
  readonly owner: string;
  /** Null while attach-only discovery is still looking for the session's owner. */
  session: NativeSession | null;
  /** Unsent envelopes, coalesced by kind, so their count is bounded by open obligations. */
  readonly outbox: NeoPiNativeEssentialEnvelope[];
  sent: number;
  applied: number;
  /** A terminal lifecycle is queued; the stream ends once it is sent. */
  ending: boolean;
  failure: NeoPiNativeSessionsError | null;
  wake: (() => void) | null;
  /** Highest `readId` admitted. */
  readId: number;
  /** The inbox position the client acknowledged with its last read; pruning waits for every lease. */
  inboxSeq: number;
  /** The highest inbox position of any record actually sent to this lease: what an acknowledgement may cover. */
  sentInboxSeq: number;
  /** Ends or re-checks the read currently waiting on this lease. */
  interrupt: ((why: "changed" | "superseded" | "released") => void) | null;
  released: boolean;
  demand: {
    readonly generation: number;
    readonly payload: string;
    readonly level: SubagentLevel;
  } | null;
}

/** One owner/control connection per canonical native file, never per browser subscription. */
export const makeNeoPiNativeSessionsWith = Effect.fn("NeoPiNativeSessions.makeWith")(function* (
  dependencies: NeoPiNativeSessionsDependencies,
) {
  // A new or closed connection changes who owns a file, so the shared listing is rescanned.
  const invalidateCatalog = dependencies.invalidateCatalog ?? Effect.void;
  // Closing N owners must cost one RPC shutdown window, not N sequential windows.
  const lifetime = yield* Scope.fork(yield* Effect.scope, "parallel");
  const clock = yield* Clock.Clock;
  const sessions = new Map<string, NativeSession>();
  // Gates are per native path: unrelated sessions can start independently.
  const gates = new Map<string, Semaphore.Semaphore>();
  const gate = Effect.fnUntraced(function* (file: string) {
    const existing = gates.get(file);
    if (existing) return existing;
    const created = yield* Semaphore.make(1);
    const winner = gates.get(file) ?? created;
    gates.set(file, winner);
    return winner;
  });
  /**
   * Nothing retires an owner automatically in stage one (decision 4, r12 I4(4): no
   * NeoPi offers conditional retirement), so a session needs no retention count;
   * work against a closed one is refused.
   */
  const retain = (session: NativeSession) =>
    session.closed ? Effect.fail(fail("This native connection is closed.", "closed")) : Effect.void;
  /** Every live lease on this server, by id. */
  const observations = new Map<string, Observation>();
  /** Names this server instance in every cursor it issues (C2 identity domains). */
  const serverIncarnation = NodeCrypto.randomUUID();
  /** Wakes idle reads after a projection change; they re-check and go back to waiting if unchanged. */
  const notifyChanged = (session: NativeSession) => {
    session.changeCount++;
    if (session.changed.size === 0) return;
    const waiting = Array.from(session.changed);
    session.changed.clear();
    for (const wake of waiting) wake();
  };
  /**
   * Queues one essential envelope on one lease. Status, session, identity and
   * non-terminal lifecycle replace their unsent predecessor, and a settle cancels
   * its unsent open, so the outbox is bounded by the open obligations.
   */
  const enqueue = (observation: Observation, envelope: NeoPiNativeEssentialEnvelope) => {
    if (observation.ending || observation.released) return;
    const { outbox } = observation;
    if (envelope.type === "obligation-settled") {
      const opened = outbox.findIndex(
        (held) => held.type === "obligation-opened" && held.id === envelope.id,
      );
      if (opened >= 0) {
        outbox.splice(opened, 1);
        observation.wake?.();
        return;
      }
    } else if (
      envelope.type === "status" ||
      envelope.type === "session" ||
      envelope.type === "identity" ||
      (envelope.type === "lifecycle" && !TERMINAL_LIFECYCLE.has(envelope.state))
    ) {
      const held = outbox.findIndex(
        (item) =>
          item.type === envelope.type &&
          (item.type !== "lifecycle" || !TERMINAL_LIFECYCLE.has(item.state)),
      );
      if (held >= 0) outbox.splice(held, 1);
    }
    outbox.push(envelope);
    if (envelope.type === "lifecycle" && TERMINAL_LIFECYCLE.has(envelope.state))
      observation.ending = true;
    observation.wake?.();
  };
  const broadcast = (session: NativeSession, envelope: NeoPiNativeEssentialEnvelope) => {
    for (const observation of session.observations) enqueue(observation, envelope);
  };
  const lifecycle = (
    session: NativeSession,
    state: NeoPiNativeObservationLifecycle,
    reason?: string,
  ): NeoPiNativeEssentialEnvelope => ({
    type: "lifecycle",
    revision: session.projection.store.bump(),
    state,
    ...(reason === undefined ? {} : { reason }),
  });
  const sessionEnvelope = (session: NativeSession): NeoPiNativeEssentialEnvelope => ({
    type: "session",
    revision: session.projection.store.bump(),
    session: describe(session),
  });
  /** Sends the status summary when it changed since the last one sent. */
  const publishStatus = (session: NativeSession) => {
    const live = liveState(session, undefined);
    if (!live) return;
    const key = `${live.state}\0${live.isStreaming}\0${live.pendingDialogs}`;
    if (key === session.statusKey) return;
    session.statusKey = key;
    broadcast(session, { type: "status", revision: session.projection.store.bump(), live });
  };
  /** Detaches every lease of a session with the lifecycle state I3 names for why it ended. */
  const endObservations = (session: NativeSession, reason: string, code?: string) => {
    if (code === "profile_changed") {
      for (const observation of session.observations) {
        observation.failure = fail(reason, code);
        observation.wake?.();
      }
      return;
    }
    // Only an established absence ends a lease as owner-stopped. A code that is neither
    // absence nor one of the other named endings fails the stream with that code: the
    // client reattaches through discovery rather than being told the owner stopped.
    const state: NeoPiNativeObservationLifecycle | null =
      code === "detached"
        ? "detached"
        : code === "identity_conflict" || code === "session_changed"
          ? "identity-changed"
          : code !== undefined && INCOMPATIBLE_OWNER_CODES.has(code)
            ? "incompatible"
            : code === "owner_incompatible"
              ? "incompatible"
              : code === undefined ||
                  code === "owner_exited" ||
                  code === "no_owner" ||
                  code === "closed"
                ? "owner-stopped"
                : null;
    if (state === null) {
      for (const observation of session.observations) {
        observation.failure = fail(reason, code);
        observation.wake?.();
      }
      return;
    }
    broadcast(session, lifecycle(session, state, reason));
  };
  const finish = (session: NativeSession, reason: string, code?: string) =>
    Effect.gen(function* () {
      if (session.closed) return;
      session.closed = true;
      if (sessions.get(session.ref.sessionFile) === session)
        sessions.delete(session.ref.sessionFile);
      if (session.recovery) yield* Deferred.fail(session.recovery, fail(reason, code ?? "closed"));
      yield* session.native.hostTools?.revoke ?? Effect.void;
      const leases = Array.from(session.observations);
      endObservations(session, reason, code);
      notifyChanged(session);
      // Ending a session never depends on a viewer returning credit: a lease that has
      // not taken its terminal envelope within the grace period is released anyway.
      for (const lease of leases)
        yield* Effect.sleep(CLOSED_LEASE_GRACE).pipe(
          Effect.andThen(Effect.sync(() => release(lease))),
          Effect.forkIn(lifetime),
        );
      yield* PubSub.publish(session.modelChanges, undefined);
    });
  const adoptIdentity = Effect.fnUntraced(function* (
    session: NativeSession,
    sessionId: string,
    file: string,
  ) {
    const sessionFile = yield* dependencies.canonicalize(file);
    if (sessionId === session.sessionId && sessionFile === session.ref.sessionFile) return;
    yield* session.native.hostTools?.revoke ?? Effect.void;
    const other = sessions.get(sessionFile);
    if (other && other !== session)
      return yield* fail(
        "The native owner moved to an already connected session. Reopen it explicitly.",
        "identity_conflict",
      );
    if (sessions.get(session.ref.sessionFile) === session) sessions.delete(session.ref.sessionFile);
    session.ref = { providerInstanceId: session.profile.providerInstanceId, sessionFile };
    session.state = { ...session.state, sessionId, sessionFile };
    session.sessionId = sessionId;
    sessions.set(sessionFile, session);
    yield* session.native.hostTools?.bind(session.ref) ?? Effect.void;
    yield* PubSub.publish(session.modelChanges, undefined);
  });
  const describe = (session: NativeSession): NeoPiNativeSessionsOpenResult => ({
    ref: session.ref,
    sessionId: session.sessionId,
    cwd: session.cwd,
    attachment: session.native.attachment,
    capabilities: Array.from(session.native.client.capabilities),
    state: session.state,
  });
  const refreshCwd = Effect.fnUntraced(function* (session: NativeSession) {
    if (session.cwdFile === session.ref.sessionFile) return;
    const rows = yield* dependencies.catalog(session.profile, undefined, session.ref.sessionFile);
    for (const row of rows) {
      if ((yield* dependencies.canonicalize(row.path)) === session.ref.sessionFile) {
        session.cwd = row.cwd;
        break;
      }
    }
    // Native new_session keeps its cwd even while its new file is still lazy.
    session.cwdFile = session.ref.sessionFile;
  });
  /**
   * One `get_state` read (C3.3). It is applied to the projection first under the mark
   * it was requested with; a reply the projection refuses (another incarnation, branch,
   * file, or older than newer state of the same kind) changes nothing else. Without an
   * identity to check against yet, the reply still sets the session's own record, but
   * a busy flag only if no turn started or ended since the request.
   */
  const readState = Effect.fnUntraced(function* (session: NativeSession) {
    const mark = session.projection.mark();
    const busyBefore = session.busyEpoch;
    const state = yield* Schema.decodeUnknownEffect(NeoPiNativeSessionRecord)(
      yield* (
        session.native.readState ??
          session.native.client.request({ type: "get_state", includeDump: false })
      ),
    );
    const identity = yield* Schema.decodeUnknownEffect(StateIdentity)(state);
    const applied = session.projection.applyStateReply(state, mark);
    if (session.projection.identity !== null && !applied) return false;
    if (!session.files.has(identity.sessionFile) || identity.sessionId !== session.sessionId) {
      yield* adoptIdentity(session, identity.sessionId, identity.sessionFile);
      if (!session.files.has(identity.sessionFile))
        session.files.set(identity.sessionFile, session.ref.sessionFile);
    }
    session.state =
      state.sessionFile === session.ref.sessionFile
        ? state
        : { ...state, sessionFile: session.ref.sessionFile };
    if (session.busyEpoch === busyBefore) session.busy = state.isStreaming === true;
    publishStatus(session);
    notifyChanged(session);
    return applied;
  });
  const refresh = Effect.fnUntraced(function* (session: NativeSession) {
    yield* session.profile.validate;
    if (session.closed) return yield* fail("This native connection is closed.", "closed");
    yield* readState(session);
    yield* refreshCwd(session);
    return describe(session);
  });
  const requireSession = Effect.fnUntraced(function* (ref: NeoPiNativeSessionRef) {
    const file = yield* dependencies.canonicalize(ref.sessionFile);
    const session = sessions.get(file);
    if (!session || session.closed)
      return yield* fail("Open this native session before using its connection.", "closed");
    if (session.profile.providerInstanceId !== ref.providerInstanceId)
      return yield* fail(
        "This native file is already connected through a different configured instance. Use that instance or close it explicitly.",
        "profile_conflict",
      );
    yield* session.profile.validate;
    return session;
  });
  const verifyRef = (session: NativeSession, ref: NeoPiNativeSessionRef) =>
    Effect.gen(function* () {
      if (
        session.closed ||
        session.ref.sessionFile !== (yield* dependencies.canonicalize(ref.sessionFile))
      )
        return yield* fail(
          "The native owner changed session. Select its new native file before sending commands.",
          "session_changed",
        );
    });
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  /** Starts `effect` in the session's scope from a synchronous frame callback. */
  const spawnIn = (session: NativeSession, effect: Effect.Effect<void>) => {
    runFork(Effect.forkIn(effect, session.scope));
  };
  /** One native read applied to the projection under the mark it was requested with (C3.3). */
  const readInto = (
    session: NativeSession,
    command: { readonly type: string },
    apply: (reply: Record<string, unknown>, mark: NeoPiNativeRequestMark) => boolean,
  ) =>
    Effect.gen(function* () {
      const mark = session.projection.mark();
      const reply = yield* session.native.client.request(command);
      const applied = apply(isNativeRecord(reply) ? reply : {}, mark);
      notifyChanged(session);
      return applied;
    });
  /** The roster's recovery authority (C1): the live inventory and, where offered, finished children. */
  const readRoster = (session: NativeSession) => {
    const { projection } = session;
    // A NeoPi that cannot list finished children, or a failed history read, leaves
    // the live inventory to carry the roster.
    const history = session.native.client.capabilities.has(SUBAGENT_HISTORY_CAPABILITY)
      ? readInto(session, { type: "get_subagent_history" }, (reply, mark) =>
          projection.applySubagentHistoryReply(reply, mark),
        )
      : Effect.fail(undefined);
    const reads = [
      readInto(session, { type: "get_subagents" }, (reply, mark) =>
        projection.applySubagentsReply(reply, mark),
      ),
      Effect.suspend(() => {
        const mark = projection.mark();
        return history.pipe(
          Effect.orElseSucceed(() => projection.applySubagentHistoryReply(null, mark)),
        );
      }),
    ];
    return Effect.all(reads, { concurrency: "unbounded" }).pipe(
      Effect.map((applied) => applied.every(Boolean)),
    );
  };
  const readJobs = (session: NativeSession) =>
    session.native.client.capabilities.has(JOBS_CAPABILITY)
      ? readInto(session, { type: "get_jobs" }, (reply, mark) =>
          session.projection.applyJobsReply(reply, mark),
        )
      : Effect.succeed(true);
  /** One backward journal page, joined to the held tail by entry id under its own mark (C3.3, C3.4). */
  const readPage = (session: NativeSession) =>
    Effect.gen(function* () {
      const { projection } = session;
      const mark = projection.mark();
      const journal = yield* decodeJournalPage(
        yield* session.native.client.request({
          type: "get_entries_page",
          scope: "branch",
          direction: "backward",
          limit: 128,
        }),
      );
      const applied = projection.applyJournalPage(
        {
          sessionId: journal.sessionId,
          entries: journal.entries,
          ...(journal.nextCursor === undefined ? {} : { nextCursor: journal.nextCursor }),
        },
        mark,
      );
      notifyChanged(session);
      return applied;
    });
  /**
   * One build attempt (C3). The attempt's marker is the last snapshot marker received
   * before its own `snapshot_session_journal` reply on this connection (C3.1); the
   * sink sees every frame written before a reply by the time that reply settles.
   * Every other read carries its own mark, so any reply from an earlier attempt,
   * incarnation or branch is refused by the projection.
   */
  const buildAttempt = Effect.fnUntraced(function* (session: NativeSession) {
    const { projection, markers } = session;
    projection.beginBuildAttempt();
    const before = markers.count;
    const reply = yield* decodeJournalIdentity(
      yield* session.native.client.request({ type: "snapshot_session_journal" }),
    );
    const marker = markers.last;
    if (
      markers.count === before ||
      marker === null ||
      marker.sessionId !== reply.sessionId ||
      marker.sessionFile !== reply.sessionFile
    )
      return false;
    const applied = yield* Effect.all(
      [readState(session), readPage(session), readRoster(session), readJobs(session)],
      { concurrency: "unbounded" },
    );
    return applied.every(Boolean) && projection.published;
  });
  /**
   * Builds the projection while a lease needs it and it is not published: single
   * flight per session, retried at a bounded rate and never terminal (C3.5). A
   * fence or a new owner epoch unpublishes it and calls this again.
   */
  /**
   * A navigation or identity change during a build makes its attempt obsolete (C3.5):
   * it is abandoned at once and the loop starts a fresh one, rather than waiting for
   * stale work to finish and back off.
   */
  const restartBuild = (session: NativeSession) => {
    const obsolete = session.attempt;
    if (obsolete) {
      session.attempt = null;
      spawnIn(session, Fiber.interrupt(obsolete));
    }
    ensureBuild(session);
  };
  const ensureBuild = (session: NativeSession) => {
    if (
      session.building ||
      session.closed ||
      session.observations.size === 0 ||
      session.projection.published
    )
      return;
    session.building = true;
    broadcast(session, lifecycle(session, "building"));
    spawnIn(
      session,
      Effect.gen(function* () {
        let delayMs = BUILD_RETRY_MIN_MS;
        while (!session.closed && !session.projection.published && session.observations.size > 0) {
          const recovery = session.recovery;
          if (recovery) {
            yield* Deferred.await(recovery).pipe(Effect.ignore);
            continue;
          }
          const attempt = yield* Effect.forkChild(buildAttempt(session));
          session.attempt = attempt;
          const exit = yield* Fiber.await(attempt);
          // Abandoned by a new owner epoch: the successor's attempt starts now.
          if (session.attempt !== attempt) continue;
          session.attempt = null;
          if (Exit.isSuccess(exit) && exit.value) break;
          yield* Effect.sleep(Duration.millis(delayMs));
          delayMs = Math.min(delayMs * 2, BUILD_RETRY_MAX_MS);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            session.building = false;
            if (session.closed) return;
            if (!session.projection.published) return ensureBuild(session);
            broadcast(session, lifecycle(session, "observing"));
            // Reads owed while building (a raised subagent level) run now.
            startRefresh(session);
            notifyChanged(session);
          }),
        ),
      ),
    );
  };
  /** Runs owed refreshes one class at a time; triggers meanwhile cost one trailing read. */
  const startRefresh = (session: NativeSession) => {
    if (session.refreshing || session.refreshes.size === 0) return;
    session.refreshing = true;
    spawnIn(
      session,
      Effect.gen(function* () {
        while (session.refreshes.size > 0 && !session.closed) {
          const owed = Array.from(session.refreshes);
          session.refreshes.clear();
          yield* Effect.all(
            owed.map((kind) =>
              (kind === "state"
                ? readState(session)
                : kind === "jobs"
                  ? readJobs(session)
                  : kind === "page"
                    ? readPage(session)
                    : readRoster(session)
              ).pipe(Effect.ignore),
            ),
            { concurrency: "unbounded", discard: true },
          );
          yield* Effect.sleep(REFRESH_MIN_GAP);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            session.refreshing = false;
            if (!session.closed) startRefresh(session);
          }),
        ),
      ),
    );
  };
  /** Owes a read of `get_state`, jobs or the roster; only a published, observed projection needs one. */
  const requestRefresh = (session: NativeSession, kind: NativeRefresh) => {
    if (session.closed || session.observations.size === 0 || !session.projection.published) return;
    session.refreshes.add(kind);
    startRefresh(session);
  };
  /** The child level the leases of a session ask for: the most any one of them wants. */
  const demandedLevel = (session: NativeSession): SubagentLevel => {
    let level: SubagentLevel = "off";
    for (const observation of session.observations) {
      const wanted = observation.demand?.level ?? "off";
      if (SUBAGENT_LEVEL_RANK[wanted] > SUBAGENT_LEVEL_RANK[level]) level = wanted;
    }
    return level;
  };
  /**
   * The demand actor (C4): one serialized applier per session that keeps NeoPi's
   * subagent subscription at the aggregate the leases demand, fenced by owner epoch.
   * A level is settled once per epoch and value: a peer that refuses it is not asked
   * again until the demand or the owner changes. Raising the level re-reads the
   * roster, because children that changed while it was lower sent nothing.
   */
  const applyDemand = (session: NativeSession) => {
    if (session.demanding || session.closed || session.recovery) return;
    const { store } = session.projection;
    const epoch = session.projection.domain.ownerEpoch;
    const demanded = demandedLevel(session);
    // A refusal stands only for the same request to the same owner: a different demand
    // or a new owner clears it, and with it the fault the Agents view shows.
    if (
      session.refusal &&
      (session.refusal.epoch !== epoch || session.refusal.level !== demanded)
    ) {
      session.refusal = null;
      if (store.remove(SUBAGENT_FAULT_KEY)) notifyChanged(session);
    }
    // A fresh connection is at `off`; `subagentLevel` is what the owner actually holds.
    const settled = session.subagentLevel;
    const held = settled?.epoch === epoch ? settled.level : "off";
    if (held === demanded || session.refusal) return;
    session.demanding = true;
    spawnIn(
      session,
      Effect.gen(function* () {
        const level = demanded;
        const native = session.native;
        // A raise is asked once and a refusal is shown. A lowering is the owner's
        // subscription cost with no one watching, so a refused one is retried at a
        // bounded rate until the owner changes or the demand returns.
        const lowering = SUBAGENT_LEVEL_RANK[level] < SUBAGENT_LEVEL_RANK[held];
        let delayMs = BUILD_RETRY_MIN_MS;
        for (let attempt = 0; ; attempt++) {
          const applied = yield* native.client
            .request({ type: "set_subagent_subscription", level })
            .pipe(Effect.result);
          // A reply from a replaced connection or an earlier epoch changes nothing.
          if (session.native !== native || session.projection.domain.ownerEpoch !== epoch) return;
          if (applied._tag === "Success") {
            session.subagentLevel = { epoch, level };
            session.refusal = null;
            store.remove(SUBAGENT_FAULT_KEY);
            notifyChanged(session);
            // A build in progress may have read the roster before the level rose: the
            // re-read is owed and runs once the projection publishes.
            if (SUBAGENT_LEVEL_RANK[level] > SUBAGENT_LEVEL_RANK[held]) {
              session.refreshes.add("roster");
              if (session.projection.published) startRefresh(session);
            }
            return;
          }
          if (lowering && attempt < LEVEL_LOWERING_RETRIES && demandedLevel(session) === level) {
            yield* Effect.sleep(Duration.millis(delayMs));
            delayMs = Math.min(delayMs * 2, BUILD_RETRY_MAX_MS);
            if (session.native !== native || session.projection.domain.ownerEpoch !== epoch) return;
            if (demandedLevel(session) !== level) return;
            continue;
          }
          // The owner keeps the level it had, which is what `subagentLevel` still says;
          // the same request is not repeated until the demand or the owner changes. A
          // refused raise is a visible fault, not silence: the Agents view would
          // otherwise show a build-time roster.
          session.refusal = { epoch, level };
          if (level !== "off") {
            store.put(SUBAGENT_FAULT_KEY, {
              class: "fault",
              value: {
                source: "subagent-subscription",
                level: "error",
                requestedLevel: level,
                message: nativeError(applied.failure).message,
              },
            });
            notifyChanged(session);
          }
          return;
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            session.demanding = false;
            applyDemand(session);
          }),
        ),
      ),
    );
  };
  /**
   * A leaf announced before its entry is settled by that entry. One no entry follows
   * is either a flush whose entries are late or a move to an entry the tail does not
   * hold, and elapsed time cannot tell them apart. After a pause the owner is asked
   * (its leaf and the page leading to it, as the build does, under the same marks) and
   * the projection decides by parent identity: entries extending the held head are
   * appended, anything else is a navigation. A timer belongs to one pending leaf: it is
   * cancelled when that leaf resolves, and acts only if that leaf is still pending.
   */
  const watchLeaf = (session: NativeSession) => {
    const { projection } = session;
    const pending = projection.pendingLeafId;
    const held = session.leafWatch;
    if (held && held.leafId !== pending) {
      held.cancelled = true;
      session.leafWatch = null;
    }
    if (pending === null || session.leafWatch !== null) return;
    const watch = { leafId: pending, cancelled: false };
    session.leafWatch = watch;
    spawnIn(
      session,
      Effect.gen(function* () {
        yield* Effect.sleep(PENDING_LEAF_SETTLE);
        let delayMs = BUILD_RETRY_MIN_MS;
        while (!session.closed && !watch.cancelled && projection.pendingLeafId === pending) {
          if (session.recovery) {
            yield* Deferred.await(session.recovery).pipe(Effect.ignore);
            continue;
          }
          const mark = projection.mark();
          const page = yield* session.native.client
            .request({
              type: "get_entries_page",
              scope: "branch",
              direction: "backward",
              limit: 128,
            })
            .pipe(Effect.flatMap(decodeJournalPage), Effect.result);
          if (page._tag === "Success") {
            projection.reconcilePendingLeaf(
              pending,
              {
                leafId: page.success.leafId,
                sessionId: page.success.sessionId,
                entries: page.success.entries,
                ...(page.success.nextCursor === undefined
                  ? {}
                  : { nextCursor: page.success.nextCursor }),
              },
              mark,
            );
            notifyChanged(session);
            if (projection.pendingLeafId !== pending) break;
          }
          // A failed or stale answer changes nothing: the view keeps its branch and is
          // asked again at a bounded rate.
          yield* Effect.sleep(Duration.millis(delayMs));
          delayMs = Math.min(delayMs * 2, BUILD_RETRY_MAX_MS);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (session.leafWatch === watch) session.leafWatch = null;
          }),
        ),
      ),
    );
  };
  /**
   * A child the view showed must not vanish because nobody watched it finish. On the
   * first lease after an unwatched interval, each held child not known to have
   * finished keeps its row with only `unobserved` (its last live parts and when
   * watching stopped), so a stale "started" never replays over what the owner says
   * now. The rebuild's inventory or history then tells it running or finished; one in
   * neither stays as finished with its outcome unknown until the history lists it.
   */
  const markUnobservedChildren = (session: NativeSession) => {
    const { store } = session.projection;
    const since = session.unwatchedSince ?? clock.currentTimeMillisUnsafe();
    let marked = false;
    for (const record of Array.from(store.values())) {
      if (record.value?.class !== "roster") continue;
      const row = record.value.value;
      if (row.unobserved !== undefined) continue;
      const lifecycle = isNativeRecord(row.lifecycle) ? row.lifecycle : undefined;
      const history = isNativeRecord(row.history) ? row.history : undefined;
      const inventory = isNativeRecord(row.inventory) ? row.inventory : undefined;
      const status = lifecycle?.status ?? history?.status ?? inventory?.status;
      if (typeof status === "string" && SETTLED_CHILD_STATUSES.has(status)) continue;
      const last: Record<string, unknown> = { since };
      for (const field of ["lifecycle", "progress", "history", "inventory"] as const)
        if (isNativeRecord(row[field])) last[field] = row[field];
      store.put(record.key, {
        class: "roster",
        value: {
          id: row.id,
          ...(row.runToken === undefined ? {} : { runToken: row.runToken }),
          ticks: row.ticks ?? 0,
          unobserved: last,
        },
      });
      marked = true;
    }
    if (marked) confirmUnobservedChildren(session);
  };
  /** A held child the owner's latest roster reads list neither as live nor in its history. */
  const hasUnconfirmedChild = (session: NativeSession) => {
    for (const record of session.projection.store.values())
      if (
        record.value?.class === "roster" &&
        record.value.value.unobserved !== undefined &&
        record.value.value.history === undefined &&
        !record.value.value.inventory
      )
        return true;
    return false;
  };
  /**
   * A child that just finished may not be in the owner's history yet: while one is
   * unconfirmed the roster is read again at the build backoff, a bounded number of
   * times. Its row stays either way; absence from one reply proves nothing.
   */
  const confirmUnobservedChildren = (session: NativeSession) =>
    spawnIn(
      session,
      Effect.gen(function* () {
        let delayMs = BUILD_RETRY_MIN_MS;
        for (let attempt = 0; attempt < UNOBSERVED_CHILD_REREADS;) {
          yield* Effect.sleep(Duration.millis(delayMs));
          delayMs = Math.min(delayMs * 2, BUILD_RETRY_MAX_MS);
          if (session.closed || session.observations.size === 0 || !hasUnconfirmedChild(session))
            return;
          if (!session.native.client.capabilities.has(SUBAGENT_HISTORY_CAPABILITY)) return;
          if (!session.projection.published) continue;
          attempt++;
          requestRefresh(session, "roster");
        }
      }),
    );
  const create = Effect.fnUntraced(function* (
    profile: NeoPiNativeProfile,
    input: NeoPiNativeSessionsOpenInput,
    /** `attach` joins a live owner only; automatic recovery never starts one (I4(1)). */
    mode: "auto" | "attach" = "auto",
    /** Discovery connects outside the per-file gate and installs its result under it (C5). */
    installUnder?: Semaphore.Semaphore,
  ) {
    const scope = yield* Scope.fork(lifetime);
    const pendingUi = new Map<string, SessionEventFrame>();
    const modelChanges = yield* Effect.acquireRelease(
      PubSub.unbounded<void>(),
      PubSub.shutdown,
    ).pipe(Effect.provideService(Scope.Scope, scope));
    // Login UI goes only to the flow it belongs to: other dialogs can never displace a prompt.
    const modelUi = makeNeoPiLoginUi();
    let session: NativeSession | undefined;
    const observations = new Set<Observation>();
    const markers: NativeMarkers = { count: 0, last: null };
    const files = new Map<string, string>();
    const projection = new NeoPiNativeProjection({
      domain: {
        // Unique per projection instance, so a cursor from another file's projection, or
        // from this file before it was closed and reopened, never matches (C2).
        serverIncarnation: NodeCrypto.randomUUID(),
        ownerEpoch: 0,
        projectionIncarnation: 0,
        buildAttempt: 0,
        branchGeneration: 0,
      },
      tombstoneCapacity: PROJECTION_TOMBSTONES,
      journalCapacity: PROJECTION_JOURNAL_ENTRIES,
      onEssential: (envelope) => {
        // Observers get the canonical file of the session they follow.
        const current = session;
        if (envelope.type === "identity" && current && envelope.sessionId === current.sessionId)
          envelope = { ...envelope, sessionFile: current.ref.sessionFile };
        for (const observation of observations) enqueue(observation, envelope);
      },
      // A navigation or identity change, from a frame or settled by a read, restarts the build (C3.5).
      onFence: () => {
        if (session) restartBuild(session);
      },
    });
    // Decision 8 (a): no lease yet, so live-only inbox records are not retained.
    projection.setInboxObserved(false);
    /** Adopts a file the owner moved to; a real identity change ends every lease (I3). */
    const followIdentity = (
      current: NativeSession,
      sessionId: string,
      file: string,
      changed: boolean,
    ) =>
      Effect.gen(function* () {
        const adopted = yield* adoptIdentity(current, sessionId, file).pipe(Effect.result);
        if (adopted._tag === "Failure") {
          const error = nativeError(adopted.failure);
          yield* finish(current, error.message, error.code ?? "identity_conflict");
          yield* Scope.close(scope, Exit.void).pipe(Effect.forkIn(lifetime));
          return;
        }
        if (!changed) return;
        broadcast(current, sessionEnvelope(current));
        broadcast(
          current,
          lifecycle(current, "identity-changed", "The native owner moved to another session."),
        );
      });
    /**
     * The synchronous sink (C1): every native frame folds into the projection here,
     * in parser order. Nothing in this path waits; reads it makes owed run elsewhere.
     */
    const observer: NeoPiNativeFrameObserver = {
      frame: (frame) => {
        if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
          if (frame.method === "cancel" && typeof frame.targetId === "string")
            pendingUi.delete(frame.targetId);
          else if (
            frame.method === "select" ||
            frame.method === "confirm" ||
            frame.method === "input" ||
            frame.method === "editor" ||
            frame.method === "ask"
          )
            pendingUi.set(frame.id, frame);
        }
        if (
          (frame.type === "tool_approval_request" || frame.type === "plan_proposal_request") &&
          typeof frame.id === "string"
        )
          pendingUi.set(frame.id, frame);
        if (frame.type === "tool_approval_cancel" && typeof frame.targetId === "string")
          pendingUi.delete(frame.targetId);
        if (frame.type === "plan_proposal_cancel" && typeof frame.id === "string")
          pendingUi.delete(frame.id);
        // Identity in the owner's spelling: the build's marker rule compares it with replies.
        const identityFrame =
          frame.type === "journal_state" &&
          typeof frame.sessionId === "string" &&
          typeof frame.sessionFile === "string"
            ? { sessionId: frame.sessionId, sessionFile: frame.sessionFile }
            : undefined;
        if (identityFrame && frame.reason === "snapshot") {
          markers.count++;
          markers.last = identityFrame;
        }
        // A spelling not seen before belongs to the current session when its id does
        // (NeoPi may name a lazy file differently before its first write); otherwise it
        // is fed as given and the identity change it implies is adopted outside this path.
        let unseenFile = false;
        let folded = frame;
        if (typeof frame.sessionFile === "string" && typeof frame.sessionId === "string") {
          let fed = files.get(frame.sessionFile);
          if (fed === undefined) {
            fed =
              session && frame.sessionId === session.sessionId
                ? session.ref.sessionFile
                : frame.sessionFile;
            files.set(frame.sessionFile, fed);
            unseenFile = true;
          }
          if (fed !== frame.sessionFile) folded = { ...frame, sessionFile: fed };
        }
        // With no lease held only identity, pending interactions and the live-only inbox
        // are kept (C1): everything else is read again by the first build (`bulkStale`).
        const unobserved = session !== undefined && observations.size === 0;
        const skip =
          unobserved &&
          (!UNOBSERVED_FOLDED.has(frame.type) ||
            (frame.type === "tool_stream_update" && frame.toolName === "edit"));
        if (skip && session) session.bulkStale = true;
        const fence = skip ? "none" : projection.fold(folded);
        const current = session;
        if (!current || current.closed) return;
        watchLeaf(current);
        if (frame.type === "agent_start") {
          current.busy = true;
          current.busyEpoch++;
        } else if (frame.type === "agent_end") {
          current.busy = false;
          current.busyEpoch++;
        }
        if (identityFrame && (unseenFile || identityFrame.sessionId !== current.sessionId))
          spawnIn(
            current,
            followIdentity(
              current,
              identityFrame.sessionId,
              identityFrame.sessionFile,
              fence === "identity-changed",
            ),
          );
        if (frame.type === "models_configuration_changed" || frame.type === "model_changed")
          PubSub.publishUnsafe(modelChanges, undefined);
        if (
          frame.type === "extension_ui_request" &&
          typeof frame.id === "string" &&
          typeof frame.method === "string"
        )
          modelUi.publish(frame as UiRequestFrame);
        if (STATE_REFRESH_EVENTS.has(frame.type)) requestRefresh(current, "state");
        if (frame.type === "agent_end") requestRefresh(current, "jobs");
        publishStatus(current);
        notifyChanged(current);
      },
      resulted: (id) => {
        projection.settleObligation(id, "resulted");
        if (session) notifyChanged(session);
      },
    };
    /** One native connection in its own scope, so a successor can retire the dead one. */
    const establish = Effect.fnUntraced(function* (
      connectInput: NeoPiNativeSessionsOpenInput,
      mode: "auto" | "attach",
      /** A candidate successor's frames wait until it is accepted: it holds no authority yet (C2). */
      candidate = false,
    ) {
      const nativeScope = yield* Scope.fork(scope);
      let held: SessionEventFrame[] | null = candidate ? [] : null;
      const candidateObserver: NeoPiNativeFrameObserver = candidate
        ? {
            frame: (frame) => {
              if (held === null) observer.frame(frame);
              else if (held.length < CANDIDATE_FRAME_LIMIT) held.push(frame);
            },
            resulted: (id) => {
              if (held === null) observer.resulted(id);
            },
          }
        : observer;
      /** Accepts the candidate: what it sent meanwhile now reaches the leases, in order. */
      const accept = () => {
        const frames = held;
        held = null;
        if (frames) for (const frame of frames) observer.frame(frame);
      };
      return yield* Effect.gen(function* () {
        const native = yield* dependencies
          .connect(profile, connectInput, candidateObserver, mode)
          .pipe(Effect.provideService(Scope.Scope, nativeScope));
        if (
          !native.client.capabilities.has("session_journal") ||
          !native.client.capabilities.has("session_journal_events")
        )
          return yield* fail(
            "The configured NeoPi must support session_journal and session_journal_events.",
            "unsupported",
          );
        const state = yield* Schema.decodeUnknownEffect(NeoPiNativeSessionRecord)(
          yield* (
            native.readState ?? native.client.request({ type: "get_state", includeDump: false })
          ),
        );
        const identity = yield* Schema.decodeUnknownEffect(StateIdentity)(state);
        const file = yield* dependencies.canonicalize(identity.sessionFile);
        if (
          connectInput.sessionFile &&
          file !== (yield* dependencies.canonicalize(connectInput.sessionFile))
        )
          return yield* fail(
            "NeoPi opened a different native file than requested.",
            "session_changed",
          );
        yield* profile.validate;
        return { native, nativeScope, state, identity, file, accept };
      }).pipe(Effect.onError(() => Scope.close(nativeScope, Exit.void)));
    });
    const abandon = (current: NativeSession, reason: string, code?: string) =>
      finish(current, reason, code).pipe(Effect.andThen(Scope.close(scope, Exit.void)));
    /** Swap a successor owner into a live session, keeping its projection and leases. */
    const adopt = Effect.fnUntraced(function* (current: NativeSession, mode: "auto" | "attach") {
      const next = yield* establish(
        {
          providerInstanceId: profile.providerInstanceId,
          sessionFile: current.ref.sessionFile,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        },
        mode,
        true,
      );
      return yield* Effect.gen(function* () {
        if (current.closed) return yield* fail("This native connection is closed.", "closed");
        if (next.file !== current.ref.sessionFile)
          return yield* fail(
            "The native owner opened a different session file.",
            "session_changed",
          );
        yield* next.native.hostTools?.bind(current.ref) ?? Effect.void;
        current.native = next.native;
        current.nativeScope = next.nativeScope;
        current.sessionId = next.identity.sessionId;
        if (!files.has(next.identity.sessionFile)) files.set(next.identity.sessionFile, next.file);
        current.state =
          next.state.sessionFile === next.file
            ? next.state
            : { ...next.state, sessionFile: next.file };
        current.busy = next.state.isStreaming === true;
        return { native: next.native, accept: next.accept };
      }).pipe(Effect.onError(() => Scope.close(next.nativeScope, Exit.void)));
    });
    /**
     * The terminal that owned this session is gone. A restart brings a successor
     * within seconds, so wait for one and attach to it. When none appears the session
     * closes as `owner_exited`, unless a prompt is waiting: that starts an owner of
     * NeoCode's own, which is safe only because no live owner holds the lease.
     * Leases survive the wait; the successor is a new owner epoch and rebuilds.
     */
    const recover = Effect.fnUntraced(function* (current: NativeSession, reason: string) {
      const recovery = yield* Deferred.make<void, NeoPiNativeSessionsError>();
      current.recovery = recovery;
      current.takeoverRequested = false;
      current.busy = false;
      pendingUi.clear();
      yield* current.native.hostTools?.revoke ?? Effect.void;
      yield* Scope.close(current.nativeScope, Exit.void);
      // The exited owner's dialogs, approvals and tool calls can no longer be answered.
      for (const id of Array.from(projection.obligations.keys()))
        projection.settleObligation(id, "cancelled");
      broadcast(current, lifecycle(current, "reconnecting", reason));
      publishStatus(current);
      // Only an established absence ends the session as owner-stopped; an owner that is
      // alive but cannot be attached, or whose state is unknown, is reported as that and
      // never replaced (I4(1), C5).
      const started = clock.currentTimeMillisUnsafe();
      let announcedUnresolved = false;
      let accepted: Effect.Success<ReturnType<typeof adopt>> | undefined;
      while (!current.closed && accepted === undefined) {
        const next = yield* adopt(current, "attach").pipe(Effect.result);
        if (next._tag === "Success") {
          accepted = next.success;
          break;
        }
        const error = nativeError(next.failure);
        if (error.code === "profile_changed")
          return yield* abandon(current, error.message, error.code);
        const graceOver = clock.currentTimeMillisUnsafe() - started >= OWNER_REATTACH_GRACE_MS;
        if (graceOver) {
          if (error.code === "no_owner") {
            if (!current.takeoverRequested)
              return yield* abandon(
                current,
                "No NeoPi is running this session now.",
                "owner_exited",
              );
            const taken = yield* adopt(current, "auto").pipe(Effect.result);
            if (taken._tag === "Failure") {
              const failed = nativeError(taken.failure);
              return yield* abandon(current, failed.message, failed.code);
            }
            accepted = taken.success;
            break;
          }
          if (INCOMPATIBLE_OWNER_CODES.has(error.code ?? ""))
            return yield* abandon(current, error.message, "owner_incompatible");
          if (!announcedUnresolved) {
            announcedUnresolved = true;
            broadcast(current, lifecycle(current, "authority-unresolved", error.message));
          }
        }
        yield* Effect.sleep(graceOver ? OWNER_UNRESOLVED_RETRY : OWNER_REATTACH_POLL);
      }
      if (current.closed || accepted === undefined) return;
      const successor = accepted.native;
      const abandoned = current.attempt;
      current.attempt = null;
      if (abandoned) yield* Fiber.interrupt(abandoned);
      projection.rebuild(projection.domain.ownerEpoch + 1);
      // A refusal belongs to the owner that gave it; the successor is asked afresh.
      projection.store.remove(SUBAGENT_FAULT_KEY);
      current.refusal = null;
      current.subagentLevel = null;
      current.recovery = null;
      yield* Deferred.succeed(recovery, undefined);
      // What the successor said while it was a candidate reaches the leases now, in order.
      accepted.accept();
      yield* watchExit(current, successor);
      broadcast(current, sessionEnvelope(current));
      ensureBuild(current);
      // The new connection starts at `off`: the aggregate demand is applied to it again (C4).
      applyDemand(current);
      notifyChanged(current);
      yield* PubSub.publish(modelChanges, undefined);
    });
    const watchExit = (
      current: NativeSession,
      native: NeoPiNativeConnection,
    ): Effect.Effect<void> =>
      Deferred.await(native.client.exit).pipe(
        Effect.flatMap((exit) => {
          if (current.closed || current.native !== native) return Effect.void;
          const reason =
            exit.stderrTail ||
            `The native connection exited (${exit.code ?? exit.signal ?? "closed"}).`;
          return native.attachment === "terminal"
            ? recover(current, reason)
            : abandon(current, reason);
        }),
        Effect.forkIn(lifetime),
        Effect.asVoid,
      );
    return yield* Effect.gen(function* () {
      const { native, nativeScope, state, identity, file } = yield* establish(input, mode);
      const install = Effect.gen(function* () {
        // A late discovery never replaces an authority installed meanwhile.
        if (sessions.has(file))
          return yield* fail(
            "The native file already has a canonical connection.",
            "identity_conflict",
          );
        if (!files.has(identity.sessionFile)) files.set(identity.sessionFile, file);
        session = {
          profile,
          native,
          nativeScope,
          scope,
          projection,
          observations,
          changed: new Set(),
          changeCount: 0,
          markers,
          files,
          building: false,
          attempt: null,
          statusKey: "",
          refreshes: new Set(),
          refreshing: false,
          pendingUi,
          modelChanges,
          modelUi,
          state: state.sessionFile === file ? state : { ...state, sessionFile: file },
          openedAt: DateTime.formatIso(yield* DateTime.now),
          ref: { providerInstanceId: profile.providerInstanceId, sessionFile: file },
          sessionId: identity.sessionId,
          cwd: native.cwd,
          cwdFile: file,
          closed: false,
          busy: state.isStreaming === true,
          subagentLevel: null,
          demanding: false,
          refusal: null,
          busyEpoch: 0,
          leafWatch: null,
          bulkStale: false,
          unwatchedSince: null,
          recovery: null,
          takeoverRequested: false,
        };
        const current = session;
        sessions.set(file, current);
        yield* Effect.addFinalizer(() => finish(current, "The native connection was closed.")).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        yield* native.hostTools?.bind(current.ref) ?? Effect.void;
        yield* watchExit(current, native);
        // An observed terminal owner's telemetry changes elsewhere without frames here.
        yield* Effect.sleep(TERMINAL_POLL_INTERVAL).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (current.native.attachment !== "terminal") return;
              requestRefresh(current, "state");
              requestRefresh(current, "jobs");
              requestRefresh(current, "roster");
            }),
          ),
          Effect.forever,
          Effect.forkIn(scope),
        );
        return current;
      });
      return yield* installUnder ? installUnder.withPermits(1)(install) : install;
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  });
  const open = (
    input: NeoPiNativeSessionsOpenInput,
  ): Effect.Effect<NeoPiNativeSessionsOpenResult, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const profile = yield* dependencies.profile(input.providerInstanceId);
      if (!input.sessionFile) {
        const created = describe(yield* create(profile, input));
        yield* invalidateCatalog;
        return created;
      }
      const file = yield* dependencies.canonicalize(input.sessionFile);
      // A reopen while the owner is being replaced waits for the outcome, outside the
      // gate so an explicit close is never queued behind it. A closed outcome falls
      // through to a fresh open below.
      const recovering = sessions.get(file)?.recovery;
      if (recovering) yield* Deferred.await(recovering).pipe(Effect.ignore);
      return yield* (yield* gate(file)).withPermits(1)(
        Effect.gen(function* () {
          const existing = sessions.get(file);
          if (existing) {
            const current = yield* requireSession({
              providerInstanceId: input.providerInstanceId,
              sessionFile: file,
            });
            yield* retain(current);
            yield* refreshCwd(current);
            const result = current.pendingUi.size > 0 ? describe(current) : yield* refresh(current);
            yield* verifyRef(current, {
              providerInstanceId: input.providerInstanceId,
              sessionFile: file,
            });
            return result;
          }
          const created = describe(yield* create(profile, { ...input, sessionFile: file }));
          yield* invalidateCatalog;
          return created;
        }),
      );
    }).pipe(Effect.scoped, Effect.mapError(nativeError));
  /**
   * What a session's owner is doing. NeoCode's own connection is authoritative
   * for sessions it owns; for a terminal-owned session the control snapshot
   * NeoPi reported wins and NeoCode's feed fills in when none answered.
   */
  const liveState = (
    connected: NativeSession | undefined,
    reported: CatalogRow["live"],
  ): NeoPiNativeSessionSummary["live"] => {
    if (!connected || connected.closed) return reported ?? undefined;
    if (connected.native.attachment === "terminal" && reported) return reported;
    const pendingDialogs = connected.pendingUi.size;
    return {
      state: pendingDialogs > 0 ? "waiting" : connected.busy ? "busy" : "idle",
      isStreaming: connected.busy,
      pendingDialogs,
      branch: reported?.branch ?? null,
    };
  };
  const list = (
    input: NeoPiNativeSessionsListInput,
  ): Effect.Effect<NeoPiNativeSessionsListResult, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const ids = input.providerInstanceId
        ? [input.providerInstanceId]
        : yield* dependencies.profileIds;
      const rows: NeoPiNativeSessionSummary[] = [];
      // Position of each catalog row by profile and file, so merging connected sessions is linear.
      const rowIndex = new Map<string, number>();
      const diagnostics: Array<{ providerInstanceId: ProviderInstanceId; message: string }> = [];
      for (const id of ids) {
        const result = yield* Effect.gen(function* () {
          const profile = yield* dependencies.profile(id);
          return yield* dependencies.catalog(profile, input.cwd);
        }).pipe(Effect.result);
        if (result._tag === "Failure") {
          diagnostics.push({
            providerInstanceId: id,
            message: nativeError(result.failure).message,
          });
          continue;
        }
        for (const row of result.success) {
          const canonical = yield* dependencies.canonicalize(row.path).pipe(Effect.result);
          if (canonical._tag === "Failure") {
            diagnostics.push({
              providerInstanceId: id,
              message: nativeError(canonical.failure).message,
            });
            continue;
          }
          const file = canonical.success;
          const connected = sessions.get(file);
          if (connected && connected.profile.providerInstanceId === id) {
            connected.cwd = row.cwd;
            connected.cwdFile = file;
          }
          const live = liveState(
            connected && connected.profile.providerInstanceId === id ? connected : undefined,
            row.live,
          );
          const key = rowKey(id, file);
          // The first row for a profile and file wins, as a linear scan would find it.
          if (!rowIndex.has(key)) rowIndex.set(key, rows.length);
          rows.push({
            ref: { providerInstanceId: id, sessionFile: file },
            sessionId: row.id,
            cwd: row.cwd,
            title: row.title,
            firstMessage: row.firstMessage,
            modifiedAt: row.modified,
            owner:
              connected && !connected.closed && connected.profile.providerInstanceId === id
                ? { kind: "neocode", attachment: connected.native.attachment }
                : row.inUse
                  ? { kind: "process", pid: row.inUse.pid, attachable: row.control !== null }
                  : { kind: "none" },
            ...(live ? { live } : {}),
          });
        }
      }
      // Fresh native files are deliberately lazy; the CLI cannot list their unwritten headers.
      for (const session of sessions.values()) {
        if (
          session.closed ||
          (input.providerInstanceId &&
            session.profile.providerInstanceId !== input.providerInstanceId)
        )
          continue;
        const existing =
          rowIndex.get(rowKey(session.profile.providerInstanceId, session.ref.sessionFile)) ?? -1;
        const cwd = existing >= 0 ? rows[existing]!.cwd : session.cwd;
        if (
          input.cwd &&
          (yield* dependencies.canonicalize(cwd)) !== (yield* dependencies.canonicalize(input.cwd))
        )
          continue;
        const live = existing >= 0 ? rows[existing]!.live : liveState(session, undefined);
        const summary: NeoPiNativeSessionSummary = {
          ref: session.ref,
          sessionId: session.sessionId,
          cwd,
          title:
            existing >= 0
              ? rows[existing]!.title
              : typeof session.state.sessionName === "string"
                ? session.state.sessionName
                : null,
          firstMessage: existing >= 0 ? rows[existing]!.firstMessage : "",
          modifiedAt: existing >= 0 ? rows[existing]!.modifiedAt : session.openedAt,
          owner: { kind: "neocode", attachment: session.native.attachment },
          ...(live ? { live } : {}),
        };
        if (existing >= 0) rows[existing] = summary;
        else rows.push(summary);
      }
      rows.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      const settlement = dependencies.settlement;
      if (settlement) {
        const records = yield* settlement.store.read;
        const autoSettleAfterDays = yield* settlement.autoSettleAfterDays;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const forgotten: Array<readonly [string, null, NeoPiNativeSettledRecord]> = [];
        rows.forEach((row, index) => {
          const record = records.get(row.ref.sessionFile);
          const resolved = resolveNativeSettlement({
            record,
            modifiedAt: row.modifiedAt,
            live: row.live,
            autoSettleAfterDays,
            now,
          });
          if (record && !resolved.retain) forgotten.push([row.ref.sessionFile, null, record]);
          if (resolved.settledAt !== null) rows[index] = { ...row, settledAt: resolved.settledAt };
        });
        // Waking is bookkeeping: a failed write only means it is retried on the next list.
        if (forgotten.length > 0) yield* settlement.store.update(forgotten).pipe(Effect.ignore);
      }
      return { sessions: rows, diagnostics };
    }).pipe(Effect.mapError(nativeError));
  const setSettled = (
    input: NeoPiNativeSessionsSetSettledInput,
  ): Effect.Effect<NeoPiNativeSessionsSetSettledResult, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const settlement = dependencies.settlement;
      if (!settlement) return yield* fail("Settling sessions is unavailable.", "unsupported");
      const profile = yield* dependencies.profile(input.ref.providerInstanceId);
      const file = yield* dependencies.canonicalize(input.ref.sessionFile);
      // The decision holds until the file sees newer activity than this.
      let modifiedAt = sessions.get(file)?.openedAt;
      for (const row of yield* dependencies.catalog(profile, undefined, file)) {
        if ((yield* dependencies.canonicalize(row.path)) === file) modifiedAt = row.modified;
      }
      if (modifiedAt === undefined)
        return yield* fail("This native session is not available in the configured profile.");
      const decidedAt = DateTime.formatIso(yield* DateTime.now);
      yield* settlement.store.update([
        [
          file,
          { state: input.settled ? "settled" : "unsettled", settledAt: decidedAt, modifiedAt },
        ],
      ]);
      return { settled: input.settled };
    }).pipe(Effect.mapError(nativeError));
  /** Resolve file access from native authority without starting a session. */
  const resolveWorkspace = (ref: NeoPiNativeSessionRef) =>
    Effect.gen(function* () {
      const profile = yield* dependencies.profile(ref.providerInstanceId);
      const sessionFile = yield* dependencies.canonicalize(ref.sessionFile);
      const connected = sessions.get(sessionFile);
      if (
        connected &&
        !connected.closed &&
        connected.profile.providerInstanceId === ref.providerInstanceId
      ) {
        yield* connected.profile.validate;
        yield* refreshCwd(connected);
        yield* verifyRef(connected, { ...ref, sessionFile });
        return { ref: connected.ref, cwd: connected.cwd };
      }
      const rows = yield* dependencies.catalog(profile, undefined, sessionFile);
      for (const row of rows) {
        if ((yield* dependencies.canonicalize(row.path)) !== sessionFile) continue;
        yield* profile.validate;
        return {
          ref: { providerInstanceId: ref.providerInstanceId, sessionFile },
          cwd: yield* dependencies.canonicalize(row.cwd),
        };
      }
      return yield* fail(
        "This native session is not available in the configured profile.",
        "session_unavailable",
      );
    }).pipe(Effect.mapError(nativeError));
  const requestNative = (
    input: NeoPiNativeSessionsRequestInput,
    preserveId = false,
  ): Effect.Effect<unknown, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const session = yield* requireSession(input.ref);
      yield* retain(session);
      // A terminal owner is being replaced. A prompt asks for a takeover if none appears;
      // every request waits for the outcome rather than failing on a dead connection.
      if (session.recovery) {
        if (input.command.type === "prompt" || input.command.type === "slash")
          session.takeoverRequested = true;
        yield* Deferred.await(session.recovery);
      }
      const client = session.native.client;
      const command = input.command;
      if (
        command.type === "set_host_tools" ||
        command.type === "serve" ||
        command.type === "unserve" ||
        command.type === "host_tool_result" ||
        command.type === "host_tool_update"
      )
        return yield* fail(
          "Native host tools are server-owned; clients cannot replace registrations or supply results.",
          "host_tools_server_owned",
        );
      // The build is the only sender of `snapshot_session_journal` on this connection
      // (its marker rule, C3.1), and the demand actor the only one of the child level.
      if (
        command.type === "snapshot_session_journal" ||
        command.type === "set_subagent_subscription"
      )
        return yield* fail(
          "This command is issued by the server's observation, not by clients.",
          "observation_server_owned",
        );
      yield* verifyRef(session, input.ref);
      const preparedCommand = yield* dependencies.preparePrompt(input);
      // UI and approval answers are one-way side channels, never correlated RPC requests.
      if (command.type === "extension_ui_response") {
        const response = yield* Schema.decodeUnknownEffect(UiResponse)(command);
        yield* client.respondUi(response);
        session.pendingUi.delete(response.id);
        session.projection.settleObligation(response.id, "answered");
        notifyChanged(session);
        return { accepted: true };
      }
      if (
        command.type === "tool_approval_response" ||
        command.type === "plan_proposal_response" ||
        command.type === "host_uri_result"
      ) {
        yield* client.writeFrame(command);
        if (typeof command.id === "string") {
          if (command.type !== "host_uri_result") session.pendingUi.delete(command.id);
          session.projection.settleObligation(
            command.id,
            command.type === "host_uri_result" ? "resulted" : "answered",
          );
          notifyChanged(session);
        }
        return { accepted: true };
      }
      // Window-local ids must not collide; native Models login uses a server-generated UUID.
      const { id, requestId: _requestId, ...payload } = preparedCommand;
      let nativeCommand: Record<string, unknown> & { readonly type: string } =
        preserveId && typeof id === "string" ? { ...payload, id } : payload;
      // A terminal's prompt path runs only headless commands. Text its TUI would dispatch
      // is typed into the pane's editor instead, exactly as the user would type it there.
      if (
        session.native.attachment === "terminal" &&
        nativeCommand.type === "prompt" &&
        typeof nativeCommand.message === "string" &&
        nativeCommand.images === undefined &&
        !input.attachments?.length &&
        neoPiSlashCommandName(nativeCommand.message)
      ) {
        const listed = yield* client.request({ type: "get_available_commands" });
        const route = neoPiTerminalTextRoute(
          nativeCommand.message,
          neoPiAvailableCommands(
            Schema.is(NeoPiNativeSessionRecord)(listed) ? listed.commands : [],
          ),
          client.capabilities.has(NEOPI_CAPABILITIES.commandCatalog),
        );
        if (route === "tui") {
          const { message, streamingBehavior: _streaming, type: _type, ...rest } = nativeCommand;
          nativeCommand = { ...rest, type: "slash", text: message };
        }
      }
      let guardedCommand = nativeCommand;
      if (session.native.attachment === "terminal") {
        const current = yield* Schema.decodeUnknownEffect(ControlIdentity)(
          yield* client.request({ type: "get_status" }),
        );
        yield* adoptIdentity(session, current.session.sessionId, current.session.sessionFile);
        session.cwd = current.cwd;
        session.cwdFile = session.ref.sessionFile;
        yield* verifyRef(session, input.ref);
        const expected = nativeCommand.if;
        // Native control checks this atomically with dispatch. The terminal may
        // switch files after get_status; a stale graphical prompt must not follow it.
        // Dictation is the machine's microphone, not session state: a stop must
        // always reach NeoPi, or the microphone stays open.
        const sessionBound = !nativeCommand.type.startsWith("dictation_");
        if (sessionBound && expected === undefined)
          guardedCommand = { ...nativeCommand, if: { generation: current.revisions.generation } };
        else if (
          sessionBound &&
          Schema.is(NeoPiNativeSessionRecord)(expected) &&
          expected.generation === undefined
        )
          guardedCommand = {
            ...nativeCommand,
            if: { ...expected, generation: current.revisions.generation },
          };
      }
      const result = observeNeoPiReply(yield* client.request(guardedCommand));
      if (
        Schema.is(NeoPiNativeSessionRecord)(result) &&
        typeof result.sessionFile === "string" &&
        typeof result.sessionId === "string"
      ) {
        const canonical = yield* dependencies.canonicalize(result.sessionFile);
        return canonical === result.sessionFile ? result : { ...result, sessionFile: canonical };
      }
      // Commands such as abort succeed without data; undefined cannot cross the
      // JSON wire and would turn that success into a client-side failure.
      return result ?? null;
    }).pipe(Effect.scoped, Effect.mapError(nativeError));
  const request = (input: NeoPiNativeSessionsRequestInput) => requestNative(input);
  /** Inbox records every live lease of a session has acknowledged are dropped (decision 8 (b)). */
  const pruneAcknowledged = (session: NativeSession) => {
    let through = Number.POSITIVE_INFINITY;
    for (const observation of session.observations)
      through = Math.min(through, observation.inboxSeq);
    if (Number.isFinite(through)) session.projection.pruneInbox(through);
  };
  /**
   * Ends a lease exactly once (C4): its read is cancelled, later calls with its id
   * fail, its share of the demand is withdrawn, and when it was the session's last
   * lease the live-only inbox stops retaining (decision 8 (a)).
   */
  const release = (observation: Observation) => {
    if (observation.released) return;
    observation.released = true;
    observations.delete(observation.leaseId);
    const session = observation.session;
    observation.session = null;
    observation.outbox.length = 0;
    if (session) {
      session.observations.delete(observation);
      session.projection.store.endTransfer(observation.leaseId);
      if (session.observations.size === 0) {
        session.projection.setInboxObserved(false);
        // With the subagent level about to drop, the owner stops reporting children: any
        // that finish unseen would stay "running". The next lease rereads them.
        session.unwatchedSince = clock.currentTimeMillisUnsafe();
        if (session.subagentLevel !== null && session.subagentLevel.level !== "off")
          session.bulkStale = true;
      } else pruneAcknowledged(session);
      applyDemand(session);
    }
    observation.interrupt?.("released");
    observation.wake?.();
  };
  /**
   * The next chunk of a lease's essential stream: as many queued envelopes as its
   * credit allows (C2), waiting while none are queued or the window is full. The
   * stream ends after a terminal lifecycle is sent.
   */
  const pullEnvelopes = (observation: Observation) =>
    Effect.callback<
      NonEmptyReadonlyArray<NeoPiNativeEssentialEnvelope>,
      NeoPiNativeSessionsError | Cause.Done
    >((resume) => {
      let resumed = false;
      const attempt = () => {
        if (resumed) return;
        if (observation.failure) {
          resumed = true;
          return resume(Effect.fail(observation.failure));
        }
        const room = CREDIT_WINDOW - (observation.sent - observation.applied);
        // The terminal lifecycle supersedes everything unsent and needs no credit: the
        // window plus this one envelope stays below the client's queue.
        if (room <= 0 && observation.ending && observation.outbox.length > 0) {
          const terminal = observation.outbox.at(-1)!;
          observation.outbox.length = 0;
          observation.sent += 1;
          resumed = true;
          return resume(Effect.succeed([terminal]));
        }
        const [first, ...rest] = observation.outbox.splice(0, Math.max(0, room));
        if (first) {
          observation.sent += 1 + rest.length;
          resumed = true;
          return resume(Effect.succeed([first, ...rest]));
        }
        if (observation.outbox.length === 0 && (observation.ending || observation.released)) {
          resumed = true;
          return resume(Cause.done());
        }
      };
      attempt();
      if (!resumed) observation.wake = attempt;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          observation.wake = null;
        }),
      ),
    );
  /**
   * Joins a lease to a live session under the per-file gate (C4): the session is
   * re-read and must still be the file's live authority; the lease is counted before
   * the gate opens. Then it receives what `open` would describe, identity, lifecycle,
   * status and every open obligation.
   */
  const join = (observation: Observation, session: NativeSession, file: string) =>
    Effect.gen(function* () {
      return yield* (yield* gate(file)).withPermits(1)(
        Effect.sync(() => {
          if (observation.released) return true;
          if (session.closed || sessions.get(file) !== session) return false;
          const { projection } = session;
          enqueue(observation, sessionEnvelope(session));
          const identity = projection.identity;
          if (identity?.sessionFile)
            enqueue(observation, {
              type: "identity",
              revision: projection.store.bump(),
              domain: projection.domain,
              sessionId: identity.sessionId,
              sessionFile:
                identity.sessionId === session.sessionId
                  ? session.ref.sessionFile
                  : identity.sessionFile,
              leafId: identity.leafId,
            });
          enqueue(
            observation,
            lifecycle(
              session,
              session.recovery ? "reconnecting" : projection.published ? "observing" : "building",
            ),
          );
          const live = liveState(session, undefined);
          if (live)
            enqueue(observation, { type: "status", revision: projection.store.bump(), live });
          for (const [id, { revision, request }] of projection.obligations)
            enqueue(observation, { type: "obligation-opened", revision, id, request });
          observation.session = session;
          session.observations.add(observation);
          if (session.observations.size === 1) {
            projection.setInboxObserved(true);
            // Bulk frames were not folded while no lease was held, so what the projection
            // holds is stale: the first lease starts a new incarnation and builds again.
            if (session.bulkStale) {
              session.bulkStale = false;
              // A message that was open when watching stopped may have gone on streaming,
              // ended or been persisted unseen, so its held body cannot be served. It is
              // dropped; if the owner is still streaming it, the build's snapshot message
              // brings back its current body before the projection publishes. Jobs that
              // finished unseen are the same; the jobs inventory lists recent ones again.
              for (const record of Array.from(projection.store.values()))
                if (
                  (record.value?.class === "message" && record.value.phase === "open") ||
                  record.key.startsWith("job:")
                )
                  projection.store.remove(record.key);
              markUnobservedChildren(session);
              const obsolete = session.attempt;
              session.attempt = null;
              if (obsolete) spawnIn(session, Fiber.interrupt(obsolete));
              projection.rebuild();
            }
            // Query-backed state went unread while no lease was held; the first lease re-reads it.
            requestRefresh(session, "state");
            requestRefresh(session, "jobs");
            requestRefresh(session, "roster");
          }
          ensureBuild(session);
          applyDemand(session);
          observation.interrupt?.("changed");
          return true;
        }),
      );
    });
  type Discovery =
    | { readonly outcome: "found" }
    | {
        readonly outcome: "owner-stopped" | "incompatible" | "authority-unresolved";
        readonly reason: string;
      };
  interface DiscoveryFlight {
    readonly result: Deferred.Deferred<Discovery, NeoPiNativeSessionsError>;
    waiters: number;
    fiber: Fiber.Fiber<void> | null;
  }
  /** Attach-only discovery in flight per file, shared by every lease that waits on it. */
  const discoveries = new Map<string, DiscoveryFlight>();
  /**
   * Attach-only discovery (I4(1), C5): with no session for the file, look for a live
   * owner and attach to it; never start one. It connects outside the per-file gate
   * and installs under it, a late result never replaces an authority installed
   * meanwhile, and when every waiting lease has gone the candidate is closed.
   */
  const discover = (profile: NeoPiNativeProfile, file: string) =>
    Effect.gen(function* () {
      let flight = discoveries.get(file);
      if (!flight) {
        const started: DiscoveryFlight = {
          result: yield* Deferred.make<Discovery, NeoPiNativeSessionsError>(),
          waiters: 0,
          fiber: null,
        };
        flight = started;
        discoveries.set(file, started);
        const installUnder = yield* gate(file);
        started.fiber = yield* create(
          profile,
          { providerInstanceId: profile.providerInstanceId, sessionFile: file },
          "attach",
          installUnder,
        ).pipe(
          Effect.timeoutOption(DISCOVERY_TIMEOUT),
          Effect.map((created): Discovery =>
            created._tag === "Some"
              ? { outcome: "found" }
              : {
                  outcome: "authority-unresolved",
                  reason: "No live owner answered in time; only attaching is retried.",
                },
          ),
          Effect.catch((cause) => {
            const error = nativeError(cause);
            switch (error.code) {
              case "identity_conflict":
                return Effect.succeed<Discovery>({ outcome: "found" });
              case "no_owner":
                return Effect.succeed<Discovery>({
                  outcome: "owner-stopped",
                  reason: "No NeoPi is running this session now.",
                });
              case "owner_outdated":
              case "unsupported":
              case "session_in_use":
                return Effect.succeed<Discovery>({
                  outcome: "incompatible",
                  reason: error.message,
                });
              case "profile_changed":
                return Effect.fail(error);
              default:
                return Effect.succeed<Discovery>({
                  outcome: "authority-unresolved",
                  reason: error.message,
                });
            }
          }),
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(started.result, exit)),
          Effect.ensuring(
            Effect.sync(() => {
              if (discoveries.get(file) === started) discoveries.delete(file);
            }),
          ),
          Effect.asVoid,
          Effect.forkIn(lifetime),
        );
      }
      const joined = flight;
      joined.waiters++;
      return yield* Deferred.await(joined.result).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            joined.waiters--;
            // The last waiting lease leaving cancels the attempt, which closes its candidate.
            return joined.waiters === 0 && joined.fiber
              ? Fiber.interrupt(joined.fiber)
              : Effect.void;
          }),
        ),
      );
    });
  /**
   * The essential stream (C2). It is the lease (C4): `leased` comes first. With a live
   * session the lease joins it at once; with none, attach-only discovery finds its
   * owner, reports that none runs it (owner-stopped) or that it cannot be attached
   * (incompatible), or keeps retrying attach while reporting authority-unresolved.
   * Bulk state is pulled through `read`. Capacity never ends it (I3); only the
   * lifecycle states that I3 names do.
   */
  const watch = (
    input: { ref: NeoPiNativeSessionRef },
    /** The connection opening this watch; the lease belongs to it alone. */
    owner: string,
  ): Stream.Stream<NeoPiNativeEssentialEnvelope, NeoPiNativeSessionsError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const file = yield* dependencies.canonicalize(input.ref.sessionFile);
        const profile = yield* dependencies.profile(input.ref.providerInstanceId);
        const existing = sessions.get(file);
        const observation: Observation = {
          leaseId: NodeCrypto.randomUUID(),
          session: null,
          outbox: [],
          sent: 0,
          applied: 0,
          ending: false,
          failure: null,
          wake: null,
          readId: -1,
          owner,
          inboxSeq: 0,
          sentInboxSeq: 0,
          interrupt: null,
          released: false,
          demand: null,
        };
        enqueue(observation, {
          type: "leased",
          leaseId: observation.leaseId,
          domain: existing?.projection.domain ?? {
            serverIncarnation,
            ownerEpoch: 0,
            projectionIncarnation: 0,
            buildAttempt: 0,
            branchGeneration: 0,
          },
          creditWindow: CREDIT_WINDOW,
          readDeadlineMs: READ_DEADLINE_MS,
        });
        observations.set(observation.leaseId, observation);
        yield* Effect.addFinalizer(() => Effect.sync(() => release(observation)));
        /** A lifecycle before any session exists carries no projection revision. */
        const report = (state: NeoPiNativeObservationLifecycle, reason: string) =>
          enqueue(observation, { type: "lifecycle", revision: 0, state, reason });
        const acquire = Effect.gen(function* () {
          let delayMs = DISCOVERY_RETRY_MIN_MS;
          let unresolved = false;
          while (!observation.released) {
            const session = sessions.get(file);
            if (session && !session.closed) {
              if (session.profile.providerInstanceId !== input.ref.providerInstanceId)
                return yield* fail(
                  "This native file is already connected through a different configured instance. Use that instance or close it explicitly.",
                  "profile_conflict",
                );
              yield* session.profile.validate;
              if (yield* join(observation, session, file)) return;
              continue;
            }
            const found = yield* discover(profile, file);
            if (found.outcome === "found") continue;
            // An outcome that arrives after a session was installed meanwhile (an explicit
            // open) is stale: the live authority wins, never a report of absence.
            const installed = sessions.get(file);
            if (installed && !installed.closed) continue;
            if (found.outcome !== "authority-unresolved")
              return report(found.outcome, found.reason);
            if (!unresolved) report(found.outcome, found.reason);
            unresolved = true;
            yield* Effect.sleep(Duration.millis(delayMs));
            delayMs = Math.min(delayMs * 2, DISCOVERY_RETRY_MAX_MS);
          }
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              observation.failure = nativeError(cause);
              observation.wake?.();
            }),
          ),
        );
        // A live session is joined before the stream is returned; only discovery is deferred.
        const live = existing && !existing.closed ? existing : undefined;
        const joined =
          live && live.profile.providerInstanceId === input.ref.providerInstanceId
            ? yield* join(observation, live, file).pipe(Effect.orElseSucceed(() => false))
            : false;
        if (!joined) yield* Effect.forkScoped(acquire);
        return Stream.fromPull(Effect.succeed(pullEnvelopes(observation)));
      }),
    ).pipe(Stream.mapError(nativeError), Stream.scoped);
  /** A lease is found only by the connection that opened it (C4); anyone else sees it as unknown. */
  const leaseFor = (leaseId: string, caller: string) =>
    Effect.suspend(() => {
      const observation = observations.get(leaseId);
      return observation && observation.owner === caller
        ? Effect.succeed(observation)
        : Effect.fail(
            fail(
              "This observation lease has ended.",
              NEOPI_NATIVE_OBSERVATION_ERROR_CODES.leaseUnknown,
            ),
          );
    });
  /**
   * The bulk long-poll (C2). One active read per lease: a newer `readId` ends the one
   * waiting, an older or repeated one is refused. A read with nothing to send waits
   * for a projection change or its deadline, then answers `unchanged` or `building`.
   * Nothing is kept per lease between reads; the cursor carries the position.
   */
  const read = (
    input: NeoPiNativeSessionsReadInput,
    caller: string,
  ): Effect.Effect<NeoPiNativeSessionsReadResult, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const observation = yield* leaseFor(input.leaseId, caller);
      const superseded = () =>
        fail(
          "A newer read was admitted on this lease.",
          NEOPI_NATIVE_OBSERVATION_ERROR_CODES.staleRead,
        );
      if (input.readId <= observation.readId) return yield* superseded();
      observation.readId = input.readId;
      observation.interrupt?.("superseded");
      const deadline = clock.currentTimeMillisUnsafe() + READ_DEADLINE_MS;
      while (true) {
        // Every pass of the loop is a fresh decision: a newer read or a release may have
        // come in while this one slept, and neither may be answered over.
        if (observation.released)
          return yield* fail(
            "This observation lease has ended.",
            NEOPI_NATIVE_OBSERVATION_ERROR_CODES.leaseUnknown,
          );
        if (observation.readId !== input.readId) return yield* superseded();
        const { session } = observation;
        const scanned = session?.changeCount ?? 0;
        const result = session
          ? readNeoPiNativeObservation(
              session.projection,
              input.cursor,
              READ_LIMITS,
              observation.leaseId,
            )
          : ({ type: "building" } as const);
        // A viewer's cursor position is only a claim. It acknowledges what this server
        // actually sent that lease: records in earlier replies, never the echo of its own
        // input and never a position beyond them (decision 8 (b)).
        if (
          session &&
          input.cursor &&
          sameObservationDomain(input.cursor.epoch, session.projection.domain)
        ) {
          observation.inboxSeq = Math.max(
            observation.inboxSeq,
            Math.min(input.cursor.inboxSeq, observation.sentInboxSeq),
          );
          pruneAcknowledged(session);
        }
        if (session && result.type === "pass") {
          const last = result.inbox.at(-1);
          if (last) observation.sentInboxSeq = Math.max(observation.sentInboxSeq, last.seq);
          // A reader the journal ring overran got what the ring holds, and the placeholder
          // behind it is filled by the client's own paging. The server refreshes its native
          // horizon for readers that start afterwards; it does not push it to this one.
          if (
            result.journal?.continuity === "horizon" &&
            input.cursor?.journalAt != null &&
            sameObservationDomain(input.cursor.epoch, session.projection.domain)
          )
            requestRefresh(session, "page");
        }
        const remaining = deadline - clock.currentTimeMillisUnsafe();
        if (result.type === "pass" || remaining <= 0) return result;
        // Test seam: a change can land exactly here, between the scan and the wait.
        if (dependencies.afterReadScan) yield* dependencies.afterReadScan;
        let wake: (() => void) | undefined;
        const waiting = (why: "changed" | "superseded" | "released") => {
          if (observation.interrupt === waiting) wakeUp(why);
        };
        let wakeUp: (why: "changed" | "superseded" | "released") => void = () => {};
        const woken = yield* Effect.callback<"changed" | "superseded" | "released">((resume) => {
          // Everything captured at the scan is judged again here: a newer read or a
          // release may have come in, the lease may have been attached to a session, and
          // that session may have changed since. Nothing is registered over a newer read.
          if (observation.released) return resume(Effect.succeed("released"));
          if (observation.readId !== input.readId) return resume(Effect.succeed("superseded"));
          const current = observation.session;
          if (current !== session || (current && current.changeCount !== scanned))
            return resume(Effect.succeed("changed"));
          wakeUp = (why) => resume(Effect.succeed(why));
          wake = () => resume(Effect.succeed("changed"));
          session?.changed.add(wake);
          observation.interrupt = waiting;
        }).pipe(
          Effect.timeoutOption(Duration.millis(remaining)),
          Effect.ensuring(
            Effect.sync(() => {
              if (wake) session?.changed.delete(wake);
              // Only this read's own registration is cleared, never a newer read's.
              if (observation.interrupt === waiting) observation.interrupt = null;
            }),
          ),
        );
        if (woken._tag === "Some" && woken.value === "superseded") return yield* superseded();
      }
    }).pipe(Effect.mapError(nativeError));
  /**
   * Returns essential credit. `applied` is cumulative and monotonic: a value at or
   * below what is already acknowledged, or above what was sent, grants nothing.
   */
  const credit = (input: NeoPiNativeSessionsCreditInput, caller: string) =>
    leaseFor(input.leaseId, caller).pipe(
      Effect.map((observation) => {
        if (input.applied > observation.sent || input.applied <= observation.applied) return;
        observation.applied = input.applied;
        observation.wake?.();
      }),
    );
  /**
   * The level of NeoPi's child subscription a demand needs: a roster view wants child
   * lifecycle and progress; a child's own view wants its settled steps too; summary and
   * transcript need no child traffic.
   */
  const levelOf = (demand: NeoPiNativeSessionsSetDemandInput["demand"]): SubagentLevel =>
    demand.some((item) => item.kind === "child")
      ? "events"
      : demand.some((item) => item.kind === "roster")
        ? "progress"
        : "off";
  /**
   * Records a lease's demand under C4's generation rules: lower is stale, the same
   * payload again is unchanged, a different payload at the same generation conflicts.
   * The demand actor then applies the aggregate over every lease of the session.
   */
  const setDemand = (
    input: NeoPiNativeSessionsSetDemandInput,
    caller: string,
  ): Effect.Effect<NeoPiNativeSessionsSetDemandResult, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const observation = yield* leaseFor(input.leaseId, caller);
      // Demand is a set: order does not make it different.
      const payload = input.demand
        .map((item) =>
          item.kind === "child" ? `child\0${item.childId}\0${item.runToken ?? ""}` : item.kind,
        )
        .toSorted()
        .join("\n");
      const held = observation.demand;
      if (held && input.generation < held.generation) return { outcome: "stale" as const };
      if (held && input.generation === held.generation) {
        if (held.payload === payload) return { outcome: "unchanged" as const };
        return yield* fail(
          "This demand generation was already set with a different demand.",
          NEOPI_NATIVE_OBSERVATION_ERROR_CODES.demandConflict,
        );
      }
      observation.demand = { generation: input.generation, payload, level: levelOf(input.demand) };
      if (observation.session) applyDemand(observation.session);
      return { outcome: "applied" as const };
    });
  const close = (input: {
    ref: NeoPiNativeSessionRef;
  }): Effect.Effect<{ closed: boolean }, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const file = yield* dependencies.canonicalize(input.ref.sessionFile);
      return yield* (yield* gate(file)).withPermits(1)(
        Effect.gen(function* () {
          const session = sessions.get(file);
          if (!session) return { closed: false };
          if (session.profile.providerInstanceId !== input.ref.providerInstanceId)
            return yield* fail(
              "This native connection belongs to another configured instance.",
              "profile_conflict",
            );
          yield* finish(session, "The native connection was explicitly closed.", "detached");
          if (session.native.attachment === "owned")
            yield* session.native.client
              .request({ type: "abort" })
              .pipe(Effect.timeoutOption("2 seconds"), Effect.ignore);
          // EOF disposes an owned RPC runtime; ctl pipe EOF detaches only its control socket.
          yield* Scope.close(session.scope, Exit.void);
          yield* invalidateCatalog;
          return { closed: true };
        }),
      );
    }).pipe(Effect.uninterruptible, Effect.mapError(nativeError));
  const modelsConnection = (
    ref: NeoPiNativeSessionRef,
  ): Effect.Effect<NeoPiModelsConnection, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const session = yield* requireSession(ref).pipe(
        Effect.catch((cause) =>
          nativeError(cause).code === "closed"
            ? fail("Native session is not connected. Open it before using Models.", "closed")
            : Effect.fail(cause),
        ),
      );
      const validate = Effect.gen(function* () {
        yield* session.profile.validate;
        yield* verifyRef(session, ref);
      });
      return {
        capabilities: session.native.client.capabilities,
        request: (command) =>
          Effect.gen(function* () {
            yield* validate;
            const nativeCommand =
              yield* Schema.decodeUnknownEffect(NeoPiNativeSessionCommand)(command);
            return yield* requestNative({ ref, command: nativeCommand }, true);
          }).pipe(
            Effect.mapError((cause) => {
              const error = nativeError(cause);
              return new NeoPiRpcError({
                message: error.message,
                ...(error.code ? { code: error.code } : {}),
              });
            }),
          ),
        respondUi: (response) =>
          request({ ref, command: { ...response, type: "extension_ui_response" } }).pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new NeoPiRpcError({ message: cause.message })),
          ),
        loginUi: (loginId) =>
          retain(session).pipe(
            Effect.andThen(session.modelUi.subscribe(loginId)),
            Effect.catch(() => Effect.succeed(Stream.empty)),
          ),
        changes: Stream.unwrap(
          retain(session).pipe(Effect.as(Stream.fromPubSub(session.modelChanges))),
        ).pipe(
          Stream.catch(() => Stream.empty),
          Stream.scoped,
        ),
        validate: validate.pipe(
          Effect.mapError((cause) => new NeoPiModelsError({ message: nativeError(cause).message })),
        ),
      } satisfies NeoPiModelsConnection;
    }).pipe(Effect.mapError(nativeError));
  if (dependencies.profileChanges)
    yield* Stream.runForEach(dependencies.profileChanges, () =>
      Effect.forEach(Array.from(sessions.values()), (session) =>
        session.profile.validate.pipe(
          Effect.catch((cause) =>
            finish(session, nativeError(cause).message, nativeError(cause).code).pipe(
              Effect.andThen(Scope.close(session.scope, Exit.void)),
            ),
          ),
        ),
      ),
    ).pipe(Effect.forkIn(lifetime));
  return {
    list,
    open,
    request,
    watch,
    read,
    credit,
    setDemand,
    close,
    modelsConnection,
    resolveWorkspace,
    setSettled,
  };
});

/** Uses the configured runtime/profile and its existing CLI + RPC/control transports. No SQL bindings. */
export const makeNeoPiNativeSessions = Effect.fn("NeoPiNativeSessions.make")(function* () {
  const instances = yield* ProviderInstanceRegistry;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const canonicalize = Effect.fnUntraced(function* (file: string) {
    if (!NodePath.isAbsolute(file))
      return yield* fail("A native session file must be an absolute path.", "invalid_path");
    return yield* fs.realPath(file).pipe(
      Effect.catch((cause) => {
        // A native-created file may not have durable entries yet; only its leaf may be absent.
        if (cause.reason._tag !== "NotFound") return Effect.fail(cause);
        return fs
          .realPath(NodePath.dirname(file))
          .pipe(Effect.map((parent) => NodePath.join(parent, NodePath.basename(file))));
      }),
    );
  }, Effect.mapError(nativeError));
  const profile = Effect.fnUntraced(function* (id: ProviderInstanceId) {
    const instance = yield* instances.getInstance(id);
    const source = instance && neoPiSessionCatalogSource(instance);
    if (!instance?.enabled || instance.driverKind !== "neopi" || !source)
      return yield* fail("This configured NeoPi instance is unavailable. Check NeoCore settings.");
    return {
      providerInstanceId: id,
      source,
      validate: Effect.gen(function* () {
        if ((yield* instances.getInstance(id)) !== instance)
          return yield* fail(
            "The configured NeoPi instance changed. Close and reopen this native connection.",
            "profile_changed",
          );
      }),
    } satisfies NeoPiNativeProfile;
  });
  // Binaries that rejected `--live` once; older NeoPi keeps listing without it.
  const liveUnsupported = new Set<string>();
  const runCatalog = (profile: NeoPiNativeProfile, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(profile.source.binary, args, {
          cwd: config.cwd,
          env: profile.source.env,
          stdin: "ignore",
        }),
      );
      const [out, err, code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_RPC_REASSEMBLED_BYTES }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: 65536 }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return {
        ok: Number(code) === 0 && !out.truncated && !err.truncated,
        out: out.text,
        err: err.text,
      };
    }).pipe(Effect.scoped, Effect.timeout("30 seconds"));
  /** `npi ctl list --json`; `undefined` when the binary cannot list or answers with something else. */
  const readControlRegistry = (profile: NeoPiNativeProfile) =>
    runCatalog(profile, ["ctl", "list", "--json"]).pipe(
      Effect.map((output) => (output.ok ? decodeNeoPiControlRegistry(output.out) : undefined)),
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => undefined),
    );
  const listArgs = (live: boolean, file?: string) => [
    "sessions",
    "list",
    "--json",
    ...(file ? ["--session-dir", NodePath.dirname(file)] : ["--all"]),
    ...(live ? ["--live"] : []),
  ];
  const scan = Effect.fnUntraced(function* (profile: NeoPiNativeProfile, file?: string) {
    // Only the full listing feeds the sidebar; single-file lookups need no owner probes.
    let live = !file && !liveUnsupported.has(profile.source.binary);
    // The control registry is each running process's own snapshot. A failed read leaves it
    // `undefined`, which `resolveNativeLive` treats as "believe only the streaming flag".
    const [first, registry] = yield* Effect.all(
      [
        runCatalog(profile, listArgs(live, file)),
        live ? readControlRegistry(profile) : Effect.succeed(undefined),
      ],
      { concurrency: 2 },
    );
    let output = first;
    if (!output.ok && live && /--live/.test(`${output.err}\n${output.out}`)) {
      liveUnsupported.add(profile.source.binary);
      live = false;
      output = yield* runCatalog(profile, listArgs(false, file));
    }
    if (!output.ok) return yield* fail(output.err || "Native session discovery failed.");
    const decoded = yield* Schema.decodeUnknownEffect(Catalog)(output.out);
    return live
      ? decoded.sessions.map((row) => ({
          ...row,
          live:
            resolveNativeLive({
              instanceId: row.control?.instanceId ?? null,
              reported: row.live,
              registry,
            }) ?? null,
        }))
      : decoded.sessions;
  }, Effect.mapError(nativeError));
  // One full scan (two CLI processes) serves every client's listing request for a few seconds.
  const sharedListing = yield* makeSharedListing({
    scan: (profile: NeoPiNativeProfile) => scan(profile),
    ttl: CATALOG_SHARE_TTL,
  });
  const invalidateCatalog = sharedListing.invalidate;
  const catalog = Effect.fnUntraced(function* (
    profile: NeoPiNativeProfile,
    cwd?: string,
    file?: string,
  ) {
    yield* profile.validate;
    let sessions: ReadonlyArray<CatalogRow>;
    if (file) sessions = yield* scan(profile, file);
    else {
      sessions = yield* sharedListing.get(
        `${profile.providerInstanceId}\0${profile.source.binary}`,
        profile,
      );
    }
    yield* profile.validate;
    if (!cwd) return sessions;
    const expected = yield* fs.realPath(cwd);
    return yield* Effect.filter(sessions, (row) =>
      fs.realPath(row.cwd).pipe(
        Effect.map((actual) => actual === expected),
        Effect.orElseSucceed(() => false),
      ),
    );
  }, Effect.mapError(nativeError));
  const catalogRow = Effect.fnUntraced(function* (profile: NeoPiNativeProfile, file: string) {
    const rows = yield* catalog(profile, undefined, file);
    for (const row of rows) {
      if ((yield* canonicalize(row.path)) === file) return row;
    }
    return undefined;
  });
  const connect: NeoPiNativeSessionsDependencies["connect"] = (
    profile,
    input,
    observer,
    mode = "auto",
  ) =>
    Effect.gen(function* () {
      const source = profile.source;
      const row = input.sessionFile ? yield* catalogRow(profile, input.sessionFile) : undefined;
      const cwd = row?.cwd ?? input.cwd ?? config.cwd;
      const canonicalCwd = yield* fs.realPath(cwd);
      const extra = yield* parseNeoPiLaunchArguments(source.launchArgs);
      const startupUi = yield* Deferred.make<void>();
      let ownedPid: number | undefined;
      const spawn = Effect.fnUntraced(function* (args: string[], capturePid = false) {
        const transportScope = yield* Effect.scope;
        let hostPump: Effect.Success<ReturnType<typeof makeNeoPiNativeHostToolPump>> | undefined;
        let activeClient: NeoPiRpcClient | undefined;
        // Host-tool calls also reach the pump that executes them. Each call waits for
        // its result, so this flow is bounded by the owner's own tool concurrency.
        const hostToolCalls = yield* Queue.unbounded<
          HostToolCallFrame | HostToolCancelFrame,
          Cause.Done
        >();
        // Every frame family folds into the projection in parser order (B1 sink).
        const frame = (value: { readonly type: string }) =>
          observer.frame(value as SessionEventFrame);
        const sink: NeoPiRpcFrameSink = {
          event: observer.frame,
          uiRequest: (request) => {
            if (
              request.method === "select" ||
              request.method === "confirm" ||
              request.method === "input" ||
              request.method === "editor"
            )
              Deferred.doneUnsafe(startupUi, Effect.void);
            frame(request);
          },
          hostToolCall: (call) => {
            frame(call);
            Queue.offerUnsafe(hostToolCalls, call);
          },
          hostUriRequest: frame,
        };
        const client = yield* makeClient({
          spawn: (command) =>
            spawner.spawn(command).pipe(
              Effect.tap((handle) =>
                Effect.sync(() => {
                  if (capturePid) ownedPid = Number(handle.pid);
                }),
              ),
            ),
          command: source.binary,
          args,
          cwd: canonicalCwd,
          env: source.env,
          sink,
          onTransportReady: (transport) =>
            Effect.gen(function* () {
              hostPump = yield* makeNeoPiNativeHostToolPump(
                {
                  hostToolCalls: Stream.fromQueue(hostToolCalls),
                  hostToolResult: (id, result, isError) =>
                    transport
                      .hostToolResult(id, result, isError)
                      .pipe(Effect.ensuring(Effect.sync(() => observer.resulted(id)))),
                },
                (ref) =>
                  Effect.gen(function* () {
                    yield* profile.validate;
                    if (!activeClient)
                      return yield* fail(
                        "Native host tools are not ready.",
                        "host_tools_unavailable",
                      );
                    const identity = yield* Schema.decodeUnknownEffect(StateIdentity)(
                      yield* activeClient.request({ type: "get_state", includeDump: false }),
                    );
                    if ((yield* canonicalize(identity.sessionFile)) !== ref.sessionFile)
                      return yield* fail("The native owner changed session.", "session_changed");
                  }).pipe(Effect.mapError(nativeError)),
              ).pipe(Effect.provideService(Scope.Scope, transportScope));
            }),
        });
        activeClient = client;
        // An already-running terminal may predate the installed binary. Old control
        // owners replace session-global tools, so only the owner's capability is safe.
        if (!capturePid && !client.capabilities.has("connection_owned_host_tools"))
          return { client, hostTools: undefined };
        if (!hostPump)
          return yield* fail(
            "Native host-tool transport is unavailable.",
            "host_tools_unavailable",
          );
        const pump = hostPump;
        const hostTools: NonNullable<NeoPiNativeConnection["hostTools"]> = {
          revoke: pump.revoke,
          bind: (ref) =>
            Effect.gen(function* () {
              yield* profile.validate;
              const settings = yield* serverSettings.getSettings;
              const overrides = Object.values(settings.projectSettingsOverrides);
              // Without a SQL thread there is no authoritative project binding. An
              // unresolved project override must not become an environment-level bypass.
              const capabilities = new Set<McpCapability>();
              if (
                settings.enableAgentBrowserAccess &&
                !overrides.some((entry) => entry.enableAgentBrowserAccess !== undefined)
              )
                capabilities.add("preview");
              if (
                settings.enableAgentDeviceAccess &&
                !overrides.some((entry) => entry.enableAgentDeviceAccess !== undefined)
              )
                capabilities.add("device");
              const tools = yield* pump.bind(ref, capabilities);
              const registered = yield* client
                .request({ type: "set_host_tools", tools })
                .pipe(Effect.result);
              if (registered._tag === "Success") return;
              // NeoPi keeps host-tool names session-global: a second NeoCode
              // attaching to the same session cannot take them over. Stay
              // attached without them and say so, rather than failing the attach.
              if (!/conflicts with an existing tool/i.test(String(registered.failure.message)))
                return yield* registered.failure;
              yield* pump.revoke;
              frame({
                type: "extension_ui_request",
                id: "neocode-host-tools",
                method: "setStatus",
                statusKey: "hostTools",
                statusText:
                  "Browser preview and device tools stay with the NeoCode window that attached first; this window follows the session without them.",
              } as SessionEventFrame);
            }).pipe(Effect.mapError(nativeError)),
        };
        return { client, hostTools };
      });
      const attach = (owner: CatalogRow | undefined) =>
        Effect.gen(function* () {
          if (!owner?.control)
            return yield* fail(
              "The native session is in use without an attachable control endpoint.",
              "session_in_use",
            );
          const { client, hostTools } = yield* spawn([
            "ctl",
            "pipe",
            owner.control.instanceId,
            "--label",
            "neocode-native",
          ]);
          if (!client.capabilities.has("control_v1"))
            return yield* fail(
              "The native endpoint did not establish a control attachment.",
              "unsupported",
            );
          // A terminal started before session_journal existed cannot be followed here; say which
          // release it runs instead of blaming the configured binary, which is not the owner.
          if (
            !client.capabilities.has("session_journal") ||
            !client.capabilities.has("session_journal_events")
          )
            return yield* fail(
              olderOwnerMessage(
                neoPiOwnerVersion(yield* readControlRegistry(profile), owner.control.instanceId),
              ),
              "owner_outdated",
            );
          return {
            client,
            attachment: "terminal" as const,
            cwd: canonicalCwd,
            ...(hostTools ? { hostTools } : {}),
          };
        });
      if (row?.inUse) return yield* attach(row);
      if (mode === "attach") return yield* fail("No NeoPi owns this session yet.", "no_owner");
      const args = [
        "--mode",
        "rpc-ui",
        "--cwd",
        canonicalCwd,
        "--no-title",
        ...(source.capabilities.has(NEOPI_CAPABILITIES.exitWithParent)
          ? ["--exit-with-parent"]
          : []),
        ...extra,
        ...(input.sessionFile ? ["--session", input.sessionFile] : ["--new-session"]),
      ];
      // A losing ownership attempt has its own scope; release it before attaching the real writer.
      const attemptScope = yield* Scope.fork(yield* Effect.scope);
      const attempt = yield* spawn(args, true).pipe(
        Effect.provideService(Scope.Scope, attemptScope),
        Effect.result,
      );
      if (attempt._tag === "Success") {
        const { client, hostTools } = attempt.success;
        let booting = true;
        const readState = Effect.suspend(() => {
          const ordinary = client.request({ type: "get_state", includeDump: false }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                booting = false;
              }),
            ),
          );
          if (!booting) return ordinary;
          // A native extension can await UI before stdio startup releases get_state.
          // Read the same session through its existing control dispatcher, which is
          // independent of that startup gate. Never synthesize an identity or header.
          const duringDialog = Deferred.await(startupUi).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                if (ownedPid === undefined)
                  return yield* fail(
                    "The native process has no control identity.",
                    "startup_unavailable",
                  );
                return yield* Effect.gen(function* () {
                  const reader = yield* makeClient({
                    spawn: spawner.spawn,
                    command: source.binary,
                    args: ["ctl", "pipe", `pid:${ownedPid}`, "--label", "neocode-native-startup"],
                    cwd: canonicalCwd,
                    env: source.env,
                  });
                  const status = yield* Schema.decodeUnknownEffect(
                    Schema.Struct({ ready: Schema.Boolean }),
                  )(yield* reader.request({ type: "get_status" }));
                  const state = yield* reader.request({ type: "get_state", includeDump: false });
                  if (status.ready) booting = false;
                  return state;
                }).pipe(Effect.scoped);
              }),
            ),
          );
          return Effect.raceFirst(ordinary, duringDialog);
        }).pipe(Effect.mapError(nativeError));
        return {
          client,
          attachment: "owned" as const,
          cwd: canonicalCwd,
          readState,
          ...(hostTools ? { hostTools } : {}),
        };
      }
      yield* Scope.close(attemptScope, Exit.void);
      if (
        !(attempt.failure instanceof NeoPiRpcError) ||
        attempt.failure.code !== "session_in_use" ||
        !input.sessionFile
      )
        return yield* Effect.fail(attempt.failure);
      return yield* attach(yield* catalogRow(profile, input.sessionFile));
    }).pipe(Effect.mapError(nativeError));
  const profileChanges = yield* instances.subscribeChanges;
  return yield* makeNeoPiNativeSessionsWith({
    profileChanges: Stream.fromSubscription(profileChanges),
    profileIds: Effect.gen(function* () {
      const all = yield* instances.listInstances;
      const unavailable = yield* instances.listUnavailable;
      return Array.from(
        new Set([
          ...all
            .filter((instance) => instance.enabled && instance.driverKind === "neopi")
            .map((instance) => instance.instanceId),
          ...unavailable
            .filter((instance) => instance.driver === "neopi")
            .map((instance) => instance.instanceId),
        ]),
      );
    }),
    profile,
    canonicalize,
    preparePrompt: (input) =>
      prepareNeoPiNativePrompt(input, config.attachmentsDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    catalog,
    invalidateCatalog,
    connect,
    settlement: {
      store: yield* makeNeoPiNativeSettledStore(
        NodePath.join(config.stateDir, "neopi-native-settled.json"),
      ),
      autoSettleAfterDays: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.sidebarAutoSettleAfterDays),
        Effect.orElseSucceed(() => null),
      ),
    },
  });
});

export class NeoPiNativeSessions extends Context.Service<
  NeoPiNativeSessions,
  Effect.Success<ReturnType<typeof makeNeoPiNativeSessions>>
>()("t3/provider/neopi/NeoPiNativeSessions") {
  static readonly layer = Layer.effect(NeoPiNativeSessions, makeNeoPiNativeSessions());
}
