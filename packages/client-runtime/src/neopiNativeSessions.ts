import {
  NeoPiNativeEntity,
  type EnvironmentId,
  type NeoPiJournalEntry,
  type NeoPiJournalPage,
  type NeoPiNativeCursor,
  type NeoPiNativeEntityValue,
  type NeoPiNativeInboxRecord,
  type NeoPiNativeObservationDomain,
  type NeoPiNativeSessionRef,
  type NeoPiNativeSessionsReadResult,
  type ServerProviderSlashCommand,
  type WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { EnvironmentRpcSuccess, EnvironmentRpcStreamValue } from "./rpc/client.ts";
import {
  emptyNativeConversation,
  reduceNativeConversation,
  sameNativeSession,
  type NativeConversation,
  type NativeIdentity,
} from "./neopiConversation.ts";
import { applyNativeConversationEvent } from "./state/neopiConversation.ts";
import {
  disconnectNativeSubagents,
  mergeNativeSubagentHistory,
  reduceNativeSubagents,
  snapshotNativeSubagents,
  type NativeSubagent,
} from "./neopiNativeSubagents.ts";
import {
  EMPTY_NATIVE_JOBS,
  reduceNativeJobs,
  snapshotNativeJobs,
  type NativeJobs,
} from "./neopiNativeJobs.ts";
import {
  EMPTY_NATIVE_ACTIVITY,
  closeNativeActivity,
  observeNativeActivity,
  openNativeActivity,
  type NativeActivity,
} from "./neopiNativeStatus.ts";

const nowMs = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

export type NativeSession = EnvironmentRpcSuccess<typeof WS_METHODS.neopiNativeSessionsOpen>;
export type NativeSessionList = EnvironmentRpcSuccess<typeof WS_METHODS.neopiNativeSessionsList>;
export type NativeSessionEvent = EnvironmentRpcStreamValue<
  typeof WS_METHODS.neopiNativeSessionsWatch
>;
export type NativeSessionUpdate =
  | NativeSessionEvent
  | { type: "disconnected" }
  /** One reply of the observation cursor read, applied by `applyNativeRead`. */
  | { type: "read"; result: NeoPiNativeSessionsReadResult }
  | { type: "state"; state: Record<string, unknown> }
  | {
      type: "page";
      page: NeoPiJournalPage;
      revision: number;
      older: boolean;
      identity?: NativeIdentity;
    }
  | {
      type: "subagents";
      sessionId: string;
      ref: NeoPiNativeSessionRef;
      revision: number;
      epoch: number;
      /**
       * `get_subagent_history` rows read with the inventory: the whole roster, finished
       * children included. Absent when NeoPi cannot list them.
       */
      history?: readonly unknown[];
      agents: readonly unknown[];
    }
  | {
      type: "jobs";
      sessionId: string;
      ref: NeoPiNativeSessionRef;
      /** Feed jobs revision when the read began. */
      revision: number;
      response: unknown;
    }
  | {
      type: "reconciliation";
      operation: "state" | "branch" | "subagents" | "jobs";
      error: string | null;
    };
export interface NativeSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly ref: NeoPiNativeSessionRef;
}
export const nativeSessionKey = ({ environmentId, ref }: NativeSessionTarget) =>
  JSON.stringify([environmentId, ref.providerInstanceId, ref.sessionFile]);
export const nativeRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Keep an editor handoff pending until it can be applied without replacing a draft. */
export function deferNativeEditorText(input: {
  readonly hasDraft: () => boolean;
  readonly apply: () => void;
  readonly subscribe: (changed: () => void) => () => void;
  readonly onDeferred: () => void;
}): () => void {
  let pending = true;
  let unsubscribe: (() => void) | undefined;
  const stopWatching = () => {
    const stop = unsubscribe;
    unsubscribe = undefined;
    stop?.();
  };
  const attempt = () => {
    if (!pending || input.hasDraft()) return;
    pending = false;
    stopWatching();
    input.apply();
  };
  attempt();
  if (pending) {
    input.onDeferred();
    unsubscribe = input.subscribe(attempt);
    // Account for a store that changes or notifies synchronously on subscribe.
    if (pending) attempt();
    else stopWatching();
  }
  return () => {
    pending = false;
    stopWatching();
  };
}

/** A follow-up read must not turn an accepted mutation into a failed command. */
export async function executeNativeSessionCommand<Result>(input: {
  readonly command: { readonly type: string };
  readonly submit: () => Promise<Result>;
  readonly readState: () => Promise<unknown>;
  readonly onState: (state: Record<string, unknown>) => void;
  readonly onRefreshError: (message: string) => void;
}): Promise<Result> {
  const result = await input.submit();
  if (input.command.type === "prompt" || input.command.type === "extension_ui_response") {
    return result;
  }
  let state: unknown;
  try {
    state = await input.readState();
  } catch {
    input.onRefreshError(
      "Command accepted, but the state refresh failed. Reconnect to refresh session details.",
    );
    return result;
  }
  input.onState(nativeRecord(state));
  return result;
}
interface NativeCommandOutput {
  readonly id: string;
  readonly text: string;
  readonly afterEntryId: string | null;
  readonly afterMessageId: string | null;
}
/** NeoPi's authoritative prompt queue (`queuedMessages` / `queue_update`). */
export interface NativePromptQueue {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
  /** Leading `steering` entries already sent into the streaming response. */
  readonly liveSteered: number;
}
const EMPTY_NATIVE_QUEUE: NativePromptQueue = { steering: [], followUp: [], liveSteered: 0 };
function nativePromptQueue(value: unknown): NativePromptQueue | null {
  const record = nativeRecord(value);
  const texts = (items: unknown) =>
    Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
  if (!Array.isArray(record.steering) && !Array.isArray(record.followUp)) return null;
  return {
    steering: texts(record.steering),
    followUp: texts(record.followUp),
    liveSteered: typeof record.liveSteered === "number" ? record.liveSteered : 0,
  };
}
/** One native microphone capture, as NeoPi's `dictation_*` frames report it. */
export interface NativeDictation {
  readonly captureId: string;
  readonly phase: "starting" | "recording" | "transcribing" | "ended";
  /** The full preview while capturing; the final text once `ended`. */
  readonly text: string;
  readonly error: string | null;
}
const DICTATION_PHASES: ReadonlySet<unknown> = new Set(["starting", "recording", "transcribing"]);
const SETTLED_CHILD_EVENTS: ReadonlySet<unknown> = new Set([
  "message_end",
  "tool_execution_end",
  "agent_end",
]);
/**
 * NeoPi runs one capture at a time and always opens it with a state frame, so a
 * new capture id replaces the old one there. Any other frame for a different id,
 * or for a capture that already ended, is a straggler.
 */
function reduceNativeDictation(
  current: NativeDictation | null,
  frame: Readonly<Record<string, unknown>>,
): NativeDictation | null {
  const captureId = frame.captureId;
  if (typeof captureId !== "string") return current;
  const same = current?.captureId === captureId;
  if (same && current.phase === "ended") return current;
  if (frame.type === "dictation_state" && DICTATION_PHASES.has(frame.state))
    return {
      captureId,
      phase: frame.state as NativeDictation["phase"],
      text: same ? current.text : "",
      error: null,
    };
  if (current !== null && !same) return current;
  if (frame.type === "dictation_transcript" && typeof frame.text === "string")
    return { captureId, phase: current?.phase ?? "recording", text: frame.text, error: null };
  if (frame.type === "dictation_end")
    return {
      captureId,
      phase: "ended",
      text: typeof frame.text === "string" ? frame.text : "",
      error: typeof frame.error === "string" && frame.error ? frame.error : null,
    };
  return current;
}
/** One projection key as the client holds it. */
export interface NativeObservedEntity {
  readonly ordinal: number;
  /** -1 once its identity domain was replaced: older than anything the new domain sends. */
  readonly revision: number;
  readonly value: NeoPiNativeEntityValue;
}
export interface NativeObservation {
  readonly domain: NeoPiNativeObservationDomain | null;
  /** Send with the next read; null before the first. A `full` pass in it means catching up. */
  readonly cursor: NeoPiNativeCursor | null;
  /** By opaque key. Messages also feed the conversation; other classes are read by key. */
  readonly entities: ReadonlyMap<string, NativeObservedEntity>;
  /** The pass whose returned keys are being accumulated, until it completes. */
  readonly passId: string | null;
  readonly returned: ReadonlySet<string>;
  /** Oversized values in transit, by key, at one revision. */
  readonly segments: ReadonlyMap<
    string,
    { readonly revision: number; readonly parts: ReadonlyArray<string | undefined> }
  >;
  /** Live-only records without a reducer, in order. */
  readonly inbox: readonly NeoPiNativeInboxRecord[];
}
export const emptyNativeObservation = (): NativeObservation => ({
  domain: null,
  cursor: null,
  entities: new Map(),
  passId: null,
  returned: new Set(),
  segments: new Map(),
  inbox: [],
});
export type NativeOwnerLoss = "reconnecting" | "orphaned" | "detached";
export interface NativeSessionFeed {
  readonly session: NativeSession | null;
  readonly conversation: NativeConversation;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly queue: NativePromptQueue;
  readonly dialogs: readonly Record<string, unknown>[];
  readonly notices: Readonly<Record<string, string>>;
  readonly commandOutputs: readonly NativeCommandOutput[];
  /** Bumped when NeoPi announces a changed command list; readers re-request it. */
  readonly commandsRevision: number;
  readonly agents: readonly NativeSubagent[];
  readonly agentsRevision: number;
  readonly agentsEpoch: number;
  /** The live inventory has been read since the roster last reset; until then an empty roster means unknown, not none. */
  readonly agentsKnown: boolean;
  /** Settled-step counter per child (`subagent_event` at the `events` level); a re-read trigger, not content. */
  readonly agentTicks: Readonly<Record<string, number>>;
  /** Background jobs; maintained only for a NeoPi that advertises `background_jobs`. */
  readonly jobs: NativeJobs;
  /** Accumulated agent working time for this session while this client watched it. */
  readonly activity: NativeActivity;
  /** Keyed projection state from cursor reads (`applyNativeRead`). */
  readonly observation: NativeObservation;
  readonly editor: { readonly id: string; readonly text: string } | null;
  readonly dictation: NativeDictation | null;
  /**
   * NeoPi relocated this same session to another file (`/wt`, `/move`). The
   * observation of the old ref ends here; the web layer repoints to this ref.
   */
  readonly movedTo: NeoPiNativeSessionRef | null;
  /**
   * Why the session has no live owner, when that is expected rather than a failure.
   * `reconnecting`: the terminal that owned it exited and a successor is awaited (the
   * session still accepts sends, which wait). `orphaned`: it exited and nothing
   * replaced it. `detached`: NeoCode let go on request. The last two end with
   * `connected: false`; any snapshot clears them.
   */
  readonly ownerLoss: NativeOwnerLoss | null;
  readonly error: string | null;
  readonly reconciliationError: {
    readonly operation: "state" | "branch" | "subagents" | "jobs";
    readonly message: string;
  } | null;
}
export const emptyNativeSessionFeed = (): NativeSessionFeed => ({
  session: null,
  conversation: emptyNativeConversation(),
  connected: false,
  busy: false,
  queue: EMPTY_NATIVE_QUEUE,
  dialogs: [],
  notices: {},
  commandOutputs: [],
  commandsRevision: 0,
  agents: [],
  agentsRevision: 0,
  agentsEpoch: 0,
  agentsKnown: false,
  agentTicks: {},
  jobs: EMPTY_NATIVE_JOBS,
  activity: EMPTY_NATIVE_ACTIVITY,
  observation: emptyNativeObservation(),
  editor: null,
  dictation: null,
  movedTo: null,
  error: null,
  ownerLoss: null,
  reconciliationError: null,
});

export function nativeJournalPage(value: unknown): NeoPiJournalPage | null {
  const page = nativeRecord(value);
  if (
    typeof page.sessionId !== "string" ||
    typeof page.sessionFile !== "string" ||
    !(page.leafId === null || typeof page.leafId === "string") ||
    !Array.isArray(page.entries) ||
    typeof page.totalEntries !== "number"
  )
    return null;
  return page as unknown as NeoPiJournalPage;
}

function retainNativePending(
  previous: NativeConversation,
  next: NativeConversation,
): NativeConversation {
  if (!next.identity || !sameNativeSession(previous.identity, next.identity)) return next;
  // State/page reads can predate a turn. Only native persistence IDs retire
  // cached live messages; stream snapshots upsert their own stable message ID.
  const entries = new Set(next.entries.map((entry) => entry.id));
  return {
    ...next,
    persisted: previous.persisted,
    pending: previous.pending.filter(
      (message) => !entries.has(previous.persisted.get(message.messageId) ?? ""),
    ),
  };
}

const decodeSegmentedEntity = Schema.decodeUnknownOption(Schema.fromJsonString(NeoPiNativeEntity));
/**
 * Applies one cursor-read reply in place; a rebase is a full pass in a new
 * domain or after falling behind, never a reset. Until a full pass completes,
 * held entities stay visible and absence means nothing; at completion, held
 * keys it did not return at or below its watermark are removed. Live rows
 * retire only once their identified durable entry is present; a row the
 * authority no longer holds and cannot identify becomes a continuity loss.
 */
export function applyNativeRead(
  feed: NativeSessionFeed,
  result: NeoPiNativeSessionsReadResult,
): NativeSessionFeed {
  if (result.type !== "pass") return feed;
  const held = feed.observation;
  const domain = result.continuation.epoch;
  const was = held.domain;
  const ownerChanged =
    was !== null &&
    (was.serverIncarnation !== domain.serverIncarnation || was.ownerEpoch !== domain.ownerEpoch);
  const sameProjection =
    was !== null && !ownerChanged && was.projectionIncarnation === domain.projectionIncarnation;
  // Only appended to since the loaded history was read.
  const continuous = sameProjection && was.branchGeneration === domain.branchGeneration;
  const replaced = was !== null && !(continuous && was.buildAttempt === domain.buildAttempt);
  const entities = new Map(held.entities);
  if (replaced)
    for (const [key, entity] of entities) entities.set(key, { ...entity, revision: -1 });
  const returned = new Set(
    replaced || result.promoted || result.passId !== held.passId ? [] : held.returned,
  );
  const segments = new Map(replaced ? [] : held.segments);
  const removed: NeoPiNativeEntityValue[] = [];
  let conversation = feed.conversation;
  let commandOutputs = feed.commandOutputs;
  if (!conversation.identity && feed.session)
    conversation = reduceNativeConversation(conversation, {
      type: "identity",
      identity: {
        sessionId: feed.session.sessionId,
        sessionFile: feed.session.ref.sessionFile,
        leafId: null,
      },
    });
  // History first: a navigation drops the abandoned branch's rows, never the new
  // branch's live messages from this same reply, and the previous owner's
  // identified rows retire on entries this reply brings.
  const journal = result.journal;
  if (journal && conversation.identity) {
    const identity = { ...conversation.identity, leafId: journal.leafId };
    if (journal.continuity === "horizon")
      conversation = reduceNativeConversation(conversation, {
        type: "horizon",
        identity,
        entries: journal.entries,
        nextCursor: journal.nextCursor,
        continuous,
      });
    else
      for (const entry of journal.entries)
        conversation = reduceNativeConversation(conversation, { type: "entry", identity, entry });
  }
  if (ownerChanged) {
    // Output anchored to a retired live row keeps its place on that row's entry.
    const persisted = conversation.persisted;
    commandOutputs = commandOutputs.map((output) => {
      const entryId = output.afterMessageId ? persisted.get(output.afterMessageId) : undefined;
      return entryId ? { ...output, afterEntryId: entryId, afterMessageId: null } : output;
    });
    conversation = reduceNativeConversation(conversation, { type: "owner_changed" });
  }
  const accept = (entity: NeoPiNativeEntity) => {
    returned.add(entity.key);
    const previous = entities.get(entity.key);
    if (previous && previous.revision >= entity.revision) return;
    entities.set(entity.key, entity);
    const value = entity.value;
    if (value.class !== "message") return;
    conversation = reduceNativeConversation(conversation, {
      type: "message",
      messageId: value.messageId,
      message: value.message,
      ...(value.stopOutcome ? { stopOutcome: value.stopOutcome } : {}),
    });
    if (value.entryId !== null && conversation.identity)
      conversation = reduceNativeConversation(conversation, {
        type: "persisted",
        identity: conversation.identity,
        messageId: value.messageId,
        entryId: value.entryId,
      });
  };
  for (const entity of result.entities) accept(entity);
  for (const segment of result.segments) {
    const prior = segments.get(segment.key);
    if (prior && prior.revision > segment.revision) continue;
    const parts =
      prior?.revision === segment.revision
        ? [...prior.parts]
        : Array.from<string | undefined>({ length: segment.count });
    parts[segment.index] = segment.data;
    if (parts.some((part) => part === undefined)) {
      segments.set(segment.key, { revision: segment.revision, parts });
      continue;
    }
    segments.delete(segment.key);
    Option.map(decodeSegmentedEntity(parts.join("")), accept);
  }
  for (const tombstone of result.tombstones) {
    const previous = entities.get(tombstone.key);
    if (!previous || previous.revision >= tombstone.revision) continue;
    entities.delete(tombstone.key);
    removed.push(previous.value);
  }
  const completed = result.continuation.pass === null;
  if (completed && result.kind === "full")
    for (const [key, entity] of entities)
      if (!returned.has(key) && entity.revision <= result.coveredThrough) {
        entities.delete(key);
        removed.push(entity.value);
      }
  const unresolved = new Set(
    removed.flatMap((value) => (value.class === "message" ? [value.messageId] : [])),
  );
  if (completed && result.kind === "full") {
    // A completed full pass holds every live message the authority knows.
    const live = new Set<string>();
    for (const { value } of entities.values())
      if (value.class === "message") live.add(value.messageId);
    for (const row of conversation.pending)
      if (!live.has(row.messageId)) unresolved.add(row.messageId);
  }
  if (unresolved.size > 0)
    conversation = reduceNativeConversation(conversation, {
      type: "unresolved",
      messageIds: unresolved,
    });
  // Inbox sequence numbers belong to one projection.
  const lastSeq = sameProjection ? (held.inbox.at(-1)?.seq ?? -1) : -1;
  const inbox = result.inbox.filter((record) => record.seq > lastSeq);
  return {
    ...feed,
    conversation,
    commandOutputs,
    observation: {
      domain,
      cursor: result.continuation,
      entities,
      passId: completed ? null : result.passId,
      returned: completed ? new Set() : returned,
      segments,
      inbox: inbox.length > 0 ? [...held.inbox, ...inbox] : held.inbox,
    },
  };
}

/** Cache is a projection of the canonical native file, never a second session journal. */
export function reduceNativeSessionFeed(
  feed: NativeSessionFeed,
  event: NativeSessionUpdate,
): NativeSessionFeed {
  if (event.type === "read") return applyNativeRead(feed, event.result);
  if (event.type === "reconciliation") {
    if (event.error !== null)
      return {
        ...feed,
        error: event.error,
        reconciliationError: { operation: event.operation, message: event.error },
      };
    return feed.reconciliationError?.operation === event.operation
      ? {
          ...feed,
          error: feed.error === feed.reconciliationError.message ? null : feed.error,
          reconciliationError: null,
        }
      : feed;
  }
  if (event.type === "subagents") {
    if (
      !feed.connected ||
      event.epoch !== feed.agentsEpoch ||
      feed.session?.sessionId !== event.sessionId ||
      feed.session.ref.sessionFile !== event.ref.sessionFile ||
      feed.session.ref.providerInstanceId !== event.ref.providerInstanceId
    )
      return feed;
    const at = DateTime.formatIso(DateTime.nowUnsafe());
    // History first, stamped with the read revision, so the live inventory read in
    // the same pass still refines what it lists and nothing a frame touched since.
    const roster = event.history
      ? mergeNativeSubagentHistory(feed.agents, event.history, event.revision, at)
      : feed.agents;
    return {
      ...feed,
      agents: snapshotNativeSubagents(
        roster,
        event.agents,
        event.revision,
        feed.agentsRevision + 1,
        at,
      ),
      agentsRevision: feed.agentsRevision + 1,
      agentsKnown: true,
    };
  }
  if (event.type === "jobs") {
    if (
      !feed.connected ||
      feed.session?.sessionId !== event.sessionId ||
      feed.session.ref.sessionFile !== event.ref.sessionFile ||
      feed.session.ref.providerInstanceId !== event.ref.providerInstanceId
    )
      return feed;
    const jobs = snapshotNativeJobs(feed.jobs, event.response, event.revision);
    return jobs === feed.jobs ? feed : { ...feed, jobs };
  }
  if (event.type === "state")
    return feed.session &&
      (typeof event.state.sessionFile !== "string" ||
        event.state.sessionFile === feed.session.ref.sessionFile) &&
      (typeof event.state.sessionId !== "string" ||
        event.state.sessionId === feed.session.sessionId)
      ? {
          ...feed,
          session: { ...feed.session, state: event.state },
          queue: nativePromptQueue(event.state.queuedMessages) ?? feed.queue,
          activity: observeNativeActivity(feed.activity, event.state, feed.busy, nowMs()),
        }
      : feed;
  if (event.type === "answered")
    return { ...feed, dialogs: feed.dialogs.filter((dialog) => dialog.id !== event.id) };
  if (event.type === "page") {
    if (
      !event.older &&
      (event.revision !== feed.conversation.revision ||
        !sameNativeSession(feed.conversation.identity, event.page) ||
        (event.identity &&
          (!sameNativeSession(event.identity, event.page) ||
            event.identity.leafId !== feed.conversation.identity?.leafId ||
            event.page.leafId !== event.identity.leafId)))
    )
      return feed;
    const conversation = reduceNativeConversation(
      feed.conversation,
      event.older
        ? { type: "older", page: event.page, revision: event.revision }
        : { type: "snapshot", page: event.page },
    );
    const next = {
      ...feed,
      conversation: event.older
        ? conversation
        : retainNativePending(feed.conversation, conversation),
    };
    return !event.older && next.reconciliationError?.operation === "branch"
      ? {
          ...next,
          error: next.error === next.reconciliationError.message ? null : next.error,
          reconciliationError: null,
        }
      : next;
  }
  if (event.type === "reconnecting")
    // The session stays connected to the server, which is waiting for the owner's
    // successor: sends are held there. Nothing the old owner was doing continues.
    return {
      ...feed,
      ownerLoss: "reconnecting",
      busy: false,
      queue: EMPTY_NATIVE_QUEUE,
      dialogs: [],
      agents: disconnectNativeSubagents(
        feed.agents,
        feed.agentsRevision + 1,
        DateTime.formatIso(DateTime.nowUnsafe()),
      ),
      agentsRevision: feed.agentsRevision + 1,
      agentsEpoch: feed.agentsEpoch + 1,
      activity: closeNativeActivity(feed.activity, nowMs()),
      error: null,
      dictation:
        feed.dictation && feed.dictation.phase !== "ended"
          ? { ...feed.dictation, phase: "ended" as const, error: event.reason }
          : feed.dictation,
    };
  if (event.type === "disconnected" || event.type === "closed") {
    // A detach and an exited terminal are states of their own, not failures: the
    // composer offers the way back instead of an error.
    const ownerLoss: NativeOwnerLoss | null =
      event.type === "closed"
        ? event.code === "detached"
          ? "detached"
          : event.code === "owner_exited"
            ? "orphaned"
            : null
        : feed.ownerLoss === "reconnecting"
          ? null
          : feed.ownerLoss;
    return {
      ...feed,
      connected: false,
      ownerLoss,
      // Pending UI replays independently and may precede the next snapshot.
      // Retire stale requests here so that snapshot cannot erase a live replay.
      dialogs: [],
      agentsEpoch: feed.agentsEpoch + 1,
      activity: closeNativeActivity(feed.activity, nowMs()),
      ...(event.type === "closed"
        ? {
            busy: false,
            // Losing the stream is not losing the owner: only a close stops its agents.
            agents: disconnectNativeSubagents(
              feed.agents,
              feed.agentsRevision + 1,
              DateTime.formatIso(DateTime.nowUnsafe()),
            ),
            agentsRevision: feed.agentsRevision + 1,
            agentsKnown: false,
            queue: EMPTY_NATIVE_QUEUE,
            error: ownerLoss === null ? event.reason : null,
            // The owner is gone, so no end frame is coming for a live capture.
            dictation:
              feed.dictation && feed.dictation.phase !== "ended"
                ? { ...feed.dictation, phase: "ended" as const, error: event.reason }
                : feed.dictation,
          }
        : {}),
    };
  }
  if (event.type === "snapshot") {
    const page = nativeJournalPage(event.journal);
    const previous = feed.conversation;
    const sameFile =
      feed.session?.ref.sessionFile === event.session.ref.sessionFile &&
      feed.session.ref.providerInstanceId === event.session.ref.providerInstanceId &&
      feed.session.sessionId === event.session.sessionId;
    const conversation = page
      ? retainNativePending(
          previous,
          reduceNativeConversation(previous, { type: "snapshot", page }),
        )
      : sameFile
        ? previous
        : emptyNativeConversation();
    return {
      ...feed,
      session: event.session,
      conversation,
      commandOutputs: sameFile ? feed.commandOutputs : [],
      // The roster is replaced by key when the inventory is read again; a
      // rebuild implies no interruption.
      agents: sameFile ? feed.agents : [],
      agentsRevision: feed.agentsRevision + 1,
      agentsEpoch: feed.agentsEpoch + 1,
      agentsKnown: sameFile && feed.agentsKnown,
      jobs: sameFile ? feed.jobs : EMPTY_NATIVE_JOBS,
      activity: observeNativeActivity(
        sameFile ? closeNativeActivity(feed.activity, nowMs()) : EMPTY_NATIVE_ACTIVITY,
        event.session.state,
        event.session.state.isStreaming === true,
        nowMs(),
      ),
      connected: true,
      movedTo: null,
      busy: event.session.state.isStreaming === true,
      queue: nativePromptQueue(event.session.state.queuedMessages) ?? EMPTY_NATIVE_QUEUE,
      error: null,
      ownerLoss: null,
      reconciliationError: null,
    };
  }
  const frame = event.frame;
  if (
    frame.type === "journal_state" &&
    typeof frame.sessionFile === "string" &&
    feed.session &&
    frame.sessionFile !== feed.session.ref.sessionFile
  ) {
    if (frame.reason === "identity" && frame.sessionId === feed.session.sessionId) {
      // The same session moved to a new file: the transcript, queue and dialogs
      // still belong to it, so follow the move instead of treating it as a new owner.
      const ref = { ...feed.session.ref, sessionFile: frame.sessionFile };
      const identity = feed.conversation.identity;
      return {
        ...feed,
        session: { ...feed.session, ref },
        conversation: identity
          ? { ...feed.conversation, identity: { ...identity, sessionFile: frame.sessionFile } }
          : feed.conversation,
        movedTo: ref,
      };
    }
    // This cache and its command target belong to the old file. Do not relabel
    // its transcript or silently follow a terminal owner's file switch.
    return {
      ...feed,
      connected: false,
      busy: false,
      queue: EMPTY_NATIVE_QUEUE,
      dialogs: [],
      editor: null,
      agents: [],
      jobs: EMPTY_NATIVE_JOBS,
      activity: EMPTY_NATIVE_ACTIVITY,
      agentsRevision: feed.agentsRevision + 1,
      agentsEpoch: feed.agentsEpoch + 1,
      agentsKnown: false,
      error:
        "The native owner changed session. Select its new native file before sending commands.",
    };
  }
  const projected = applyNativeConversationEvent(
    { conversation: feed.conversation, busy: feed.busy, connection: null },
    { type: "native", event: frame },
  );
  const busy = projected.busy ?? feed.busy;
  let next: NativeSessionFeed =
    projected.conversation === feed.conversation && busy === feed.busy
      ? feed
      : { ...feed, conversation: projected.conversation, busy };
  if (frame.type === "subagent_lifecycle" || frame.type === "subagent_progress") {
    const agents = reduceNativeSubagents(
      next.agents,
      frame,
      next.agentsRevision + 1,
      DateTime.formatIso(DateTime.nowUnsafe()),
    );
    if (agents !== next.agents) next = { ...next, agents, agentsRevision: next.agentsRevision + 1 };
  }
  if (frame.type === "subagent_event") {
    const payload = nativeRecord(frame.payload);
    const id = payload.id;
    // Streaming deltas would repaint the whole workspace; only settled steps are worth a re-read.
    if (typeof id === "string" && SETTLED_CHILD_EVENTS.has(nativeRecord(payload.event).type))
      next = { ...next, agentTicks: { ...next.agentTicks, [id]: (next.agentTicks[id] ?? 0) + 1 } };
  }
  if (frame.type === "job_lifecycle") {
    const jobs = reduceNativeJobs(next.jobs, frame);
    if (jobs !== next.jobs) next = { ...next, jobs };
  }
  if (frame.type === "agent_start" || frame.type === "agent_end") {
    const at = nowMs();
    next = {
      ...next,
      // A new turn starts clean: the last prompt's failure does not outlive it.
      // A failed state or branch read stays until that read recovers.
      ...(frame.type === "agent_start" && !next.reconciliationError ? { error: null } : {}),
      activity:
        frame.type === "agent_start"
          ? openNativeActivity(next.activity, at)
          : closeNativeActivity(next.activity, at),
    };
  }
  if (
    frame.type === "journal_state" &&
    typeof frame.sessionId === "string" &&
    next.session &&
    frame.sessionFile === next.session.ref.sessionFile
  )
    next = {
      ...next,
      session: { ...next.session, sessionId: frame.sessionId },
      ...(frame.sessionId !== next.session.sessionId
        ? {
            busy: false,
            queue: EMPTY_NATIVE_QUEUE,
            dialogs: [],
            editor: null,
            commandOutputs: [],
            agents: [],
            agentsRevision: next.agentsRevision + 1,
            jobs: EMPTY_NATIVE_JOBS,
            activity: EMPTY_NATIVE_ACTIVITY,
            agentsEpoch: next.agentsEpoch + 1,
            agentsKnown: false,
          }
        : {}),
    };
  if (frame.type === "command_output" && typeof frame.text === "string" && frame.text)
    next = {
      ...next,
      commandOutputs: [
        ...next.commandOutputs,
        {
          id: `command:${next.commandOutputs.length}`,
          text: frame.text,
          // The announced leaf may precede its page. Anchor to loaded history so
          // the result is visible now and keeps its position through reconnects.
          afterEntryId: next.conversation.entries.at(-1)?.id ?? null,
          afterMessageId: next.conversation.pending.at(-1)?.messageId ?? null,
        },
      ],
    };
  if (frame.type === "available_commands_update")
    next = { ...next, commandsRevision: next.commandsRevision + 1 };
  if (
    (frame.type === "tool_approval_request" || frame.type === "plan_proposal_request") &&
    typeof frame.id === "string"
  )
    next = {
      ...next,
      dialogs: [...next.dialogs.filter((dialog) => dialog.id !== frame.id), frame],
    };
  if (frame.type === "tool_approval_cancel" && typeof frame.targetId === "string")
    next = { ...next, dialogs: next.dialogs.filter((dialog) => dialog.id !== frame.targetId) };
  if (frame.type === "plan_proposal_cancel" && typeof frame.id === "string")
    next = { ...next, dialogs: next.dialogs.filter((dialog) => dialog.id !== frame.id) };
  if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
    const method = frame.method;
    if (["select", "confirm", "input", "editor", "ask"].includes(String(method)))
      next = {
        ...next,
        dialogs: [...next.dialogs.filter((dialog) => dialog.id !== frame.id), frame],
      };
    else if (method === "cancel")
      next = { ...next, dialogs: next.dialogs.filter((dialog) => dialog.id !== frame.targetId) };
    else if (method === "set_editor_text" && typeof frame.text === "string")
      next = { ...next, editor: { id: frame.id, text: frame.text } };
    else if (method === "notify" && typeof frame.message === "string")
      next = { ...next, notices: { ...next.notices, notification: frame.message } };
    else if (method === "setStatus" && typeof frame.statusKey === "string")
      next = {
        ...next,
        notices: {
          ...next.notices,
          [frame.statusKey]: typeof frame.statusText === "string" ? frame.statusText : "",
        },
      };
    else if (method === "setWidget" && typeof frame.widgetKey === "string")
      next = {
        ...next,
        notices: {
          ...next.notices,
          [frame.widgetKey]: Array.isArray(frame.widgetLines) ? frame.widgetLines.join("\n") : "",
        },
      };
  }
  if (frame.type.startsWith("dictation_")) {
    const dictation = reduceNativeDictation(next.dictation, frame);
    if (dictation !== next.dictation) next = { ...next, dictation };
  }
  if (frame.type === "queue_update")
    next = { ...next, queue: nativePromptQueue(frame) ?? next.queue };
  if (frame.type === "prompt_result" && frame.status === "error")
    next = {
      ...next,
      error: String(nativeRecord(frame.error).message ?? "Native command failed."),
    };
  if (frame.type === "prompt_result" && frame.status !== "error" && !next.reconciliationError)
    next = { ...next, error: null };
  return next;
}

export function nativeTranscriptEntries(
  conversation: NativeConversation,
  debug: boolean,
): readonly NeoPiJournalEntry[] {
  const entries = debug
    ? conversation.entries
    : conversation.entries.filter(
        (entry) =>
          entry.type === "message" || (entry.type === "custom_message" && entry.display !== false),
      );
  return [
    ...entries,
    ...conversation.pending.map(({ messageId, message }) => ({
      id: `live:${messageId}`,
      parentId: conversation.identity?.leafId ?? null,
      type: "message",
      timestamp: "",
      message,
    })),
  ];
}

export type NativeTranscriptRow =
  | { readonly kind: "entry"; readonly id: string; readonly entry: NeoPiJournalEntry }
  | { readonly kind: "command"; readonly id: string; readonly text: string };

/** Command results are local display history, not entries in the native journal. */
export function nativeTranscriptRows(
  feed: Pick<NativeSessionFeed, "conversation" | "commandOutputs">,
  debug: boolean,
): readonly NativeTranscriptRow[] {
  const outputs = new Map<string | null, NativeCommandOutput[]>();
  // Output follows its live row until that row retires onto its durable entry;
  // a lost row's output stays after the entry its content now reads from.
  const live = new Set(feed.conversation.pending.map((message) => message.messageId));
  const lost = new Map(
    feed.conversation.losses.map((loss) => [loss.messageId, loss.afterEntryId] as const),
  );
  for (const output of feed.commandOutputs) {
    const messageId = output.afterMessageId;
    const anchor =
      messageId === null
        ? output.afterEntryId
        : live.has(messageId)
          ? `live:${messageId}`
          : (feed.conversation.persisted.get(messageId) ??
            (lost.has(messageId) ? (lost.get(messageId) ?? null) : `live:${messageId}`));
    const group = outputs.get(anchor);
    if (group) group.push(output);
    else outputs.set(anchor, [output]);
  }
  const rows: NativeTranscriptRow[] = [];
  const appendOutputs = (anchor: string | null) => {
    for (const output of outputs.get(anchor) ?? [])
      rows.push({ kind: "command", id: output.id, text: output.text });
  };
  appendOutputs(null);
  for (const entry of nativeTranscriptEntries(feed.conversation, true)) {
    if (
      debug ||
      entry.type === "message" ||
      (entry.type === "custom_message" && entry.display !== false)
    )
      rows.push({ kind: "entry", id: `entry:${entry.id}`, entry });
    // A command after hidden bookkeeping still appears in the right place.
    // Results on another branch stay hidden until its anchor is visible again.
    appendOutputs(entry.id);
  }
  return rows;
}

export interface NativeCatalogModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly raw: Record<string, unknown>;
}
export function nativeCatalogModels(value: unknown): readonly NativeCatalogModel[] {
  const source = nativeRecord(value).models;
  if (!Array.isArray(source)) return [];
  return source.flatMap((item) => {
    const model = nativeRecord(item);
    return typeof model.provider === "string" && typeof model.id === "string"
      ? [
          {
            provider: model.provider,
            id: model.id,
            name: typeof model.name === "string" ? model.name : model.id,
            raw: model,
          },
        ]
      : [];
  });
}

/** NeoPi serves `get_command_completions` when it advertises this. */
export const NATIVE_COMMAND_COMPLETIONS_CAPABILITY = "command_completions";

export type NativeSlashCommand = ServerProviderSlashCommand & {
  readonly aliases?: readonly string[];
};

const SLASH_COMMAND_SOURCES = new Set(["builtin", "extension", "custom", "mcp_prompt", "file"]);
const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** NeoPi's own command list (`get_available_commands`), as the composer menu offers it. */
export function nativeSlashCommands(value: unknown): readonly NativeSlashCommand[] {
  const source = nativeRecord(value).commands;
  if (!Array.isArray(source)) return [];
  return source.flatMap((item) => {
    const command = nativeRecord(item);
    const name = nonEmpty(command.name);
    if (!name) return [];
    const description = nonEmpty(command.description);
    const hint = nonEmpty(nativeRecord(command.input).hint);
    const aliases = Array.isArray(command.aliases)
      ? command.aliases.filter((alias): alias is string => typeof alias === "string" && !!alias)
      : [];
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
        ...(typeof command.source === "string" && SLASH_COMMAND_SOURCES.has(command.source)
          ? { source: command.source as NonNullable<ServerProviderSlashCommand["source"]> }
          : {}),
        ...(command.availability === "tui" ? { availability: "tui" as const } : {}),
        ...(aliases.length ? { aliases } : {}),
      },
    ];
  });
}

/** A terminal-only command cannot run in a session NeoCode owns; NeoPi refuses it there. */
export function nativeCommandNeedsTerminal(
  command: Pick<ServerProviderSlashCommand, "availability">,
  attachment: "owned" | "terminal" | undefined,
): boolean {
  return command.availability === "tui" && attachment !== "terminal";
}

/** `/name <argument>` at the start of the draft, with the caret inside the argument text. */
export function nativeSlashArgument(
  text: string,
  cursor = text.length,
): { readonly command: string; readonly prefix: string; readonly start: number } | null {
  const match = /^\/([A-Za-z][\w.-]*(?::[\w.-]+)?) /.exec(text);
  if (!match?.[1] || cursor < match[0].length) return null;
  const prefix = text.slice(match[0].length, cursor);
  return prefix.includes("\n") ? null : { command: match[1], prefix, start: match[0].length };
}

export interface NativeCommandCompletion {
  /** Replaces the whole argument text. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly hint?: string;
  /** Choosing it runs the command at once. */
  readonly submitsCommand: boolean;
}

/** `get_command_completions` items, without the one the argument already spells. */
export function nativeCommandCompletions(
  value: unknown,
  prefix: string,
): readonly NativeCommandCompletion[] {
  const items = nativeRecord(value).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    const completion = nativeRecord(item);
    if (typeof completion.value !== "string" || completion.value === prefix) return [];
    const description = nonEmpty(completion.description);
    const hint = nonEmpty(completion.hint);
    return [
      {
        value: completion.value,
        label: nonEmpty(completion.label) ?? completion.value,
        ...(description ? { description } : {}),
        ...(hint ? { hint } : {}),
        submitsCommand: completion.submitsCommand === true,
      },
    ];
  });
}

export interface NativeOwnerNotice {
  readonly text: string;
  /** The button that gets the session back; absent while the server is already doing it. */
  readonly action: string | null;
}

/** What a client tells the user while a session has no live owner. */
export function nativeOwnerNotice(
  ownerLoss: NativeOwnerLoss | null,
  attachment: "owned" | "terminal" | undefined,
): NativeOwnerNotice | null {
  switch (ownerLoss) {
    case null:
      return null;
    case "reconnecting":
      return {
        text: "The terminal running this session exited. Waiting for it to come back; a message you send now is held until it does, or NeoCode takes the session over.",
        action: null,
      };
    case "orphaned":
      return {
        text: "No terminal is running this session now. Send a message to continue it in NeoCode.",
        action: "Continue in NeoCode",
      };
    case "detached":
      return {
        text:
          attachment === "terminal"
            ? "Detached from the terminal session. The terminal still owns it."
            : "Disconnected from this session.",
        action: "Reconnect",
      };
  }
}

/** Disconnect on a terminal session only lets go of the control socket; the terminal keeps the session. */
export function nativeDisconnectLabel(attachment: "owned" | "terminal" | undefined): string {
  return attachment === "terminal"
    ? "Detach from terminal session (the terminal keeps it)"
    : "Disconnect session";
}
