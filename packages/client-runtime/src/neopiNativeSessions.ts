import {
  NeoPiNativeEntity,
  type EnvironmentId,
  type NeoPiJournalEntry,
  type NeoPiJournalPage,
  type NeoPiNativeCursor,
  type NeoPiNativeEntityValue,
  type NeoPiNativeEssentialEnvelope,
  type NeoPiNativeInboxRecord,
  type NeoPiNativeObservationDomain,
  type NeoPiNativeObservationLifecycle,
  type NeoPiNativeSessionRef,
  type NeoPiNativeSessionsReadResult,
  type NeoPiNativeSessionsStreamEvent,
  type ServerProviderSlashCommand,
  type WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { EnvironmentRpcSuccess } from "./rpc/client.ts";
import {
  emptyNativeConversation,
  nativeConversationGaps,
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
export type NativeSessionUpdate =
  /**
   * The old raw watch events, which the watch no longer sends. They stay until
   * the parity sign-off removes them with their reducer branches.
   */
  | NeoPiNativeSessionsStreamEvent
  /** One envelope of the essential `watch` stream (the lease). */
  | NeoPiNativeEssentialEnvelope
  /** The observation controller's own state; see `NativeObserver`. */
  | { type: "observer"; phase: NativeObserverPhase; reason?: string }
  | { type: "disconnected" }
  /**
   * Starts the one read a feed may have outstanding: send
   * `observation.outstanding` (`readId`, `cursor`) to `neopiNativeSessionsRead`.
   */
  | { type: "read-issued" }
  /** The reply to read `readId`, applied by `applyNativeRead`. */
  | { type: "read"; readId: number; result: NeoPiNativeSessionsReadResult }
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
/** An applied inbox record or gap, reduced to what gap arithmetic needs. */
export interface NativeInboxLedgerItem {
  readonly fromSeq: number;
  readonly notices: number;
  readonly toolStreams: ReadonlyArray<{ readonly toolCallId: string; readonly updates: number }>;
  /** Set for a gap: the receive time of its last record. */
  readonly lastReceivedAt: number | null;
}
/** Applied inbox items remembered for gap arithmetic; a gap reaching further back is counted as given. */
const INBOX_LEDGER_LIMIT = 4096;
export interface NativeObservation {
  readonly domain: NeoPiNativeObservationDomain | null;
  /** Send with the next read; null before the first. A `full` pass in it means catching up. */
  readonly cursor: NeoPiNativeCursor | null;
  /** By opaque key. Messages also feed the conversation; other classes are read by key. */
  readonly entities: ReadonlyMap<string, NativeObservedEntity>;
  /** The pass whose returned keys are being accumulated, until it completes. */
  readonly passId: string | null;
  readonly returned: ReadonlySet<string>;
  /** Revision at which each removed key was removed; an older value never brings it back. */
  readonly removed: ReadonlyMap<string, number>;
  /**
   * Live rows whose durable entry was known but not loaded when a navigation
   * changed the branch. The next completed full pass decides them: entry
   * loaded, they retire; otherwise they are continuity losses.
   */
  readonly unproven: ReadonlySet<string>;
  /**
   * Live rows waiting for an unloaded entry across a rebuild or owner change,
   * which cannot know the branch. They wait until the entry loads, or until a
   * completed full pass finds the branch loaded to its root without it.
   */
  readonly carried: ReadonlySet<string>;
  /** Oversized values in transit, by key, at one revision. */
  readonly segments: ReadonlyMap<
    string,
    { readonly revision: number; readonly parts: ReadonlyArray<string | undefined> }
  >;
  /**
   * Live-only records without a reducer, in order, and `gap` records for what
   * this view missed: a gap never repeats records already applied here, and
   * nothing is invented for it. A consumer may remove what it has mapped.
   */
  readonly inbox: readonly NeoPiNativeInboxRecord[];
  /** The projection the inbox sequence numbers belong to, and the last one applied. */
  readonly inboxKey: string | null;
  readonly inboxSeq: number;
  /** What was applied, by sequence and counts only, so a grown gap subtracts what this view holds. */
  readonly inboxLedger: readonly NativeInboxLedgerItem[];
  /** Last read id issued; only grows, so it rises on every lease. */
  readonly readSeq: number;
  /** The one read whose reply may apply; cleared by its reply or by `invalidateNativeReads`. */
  readonly outstanding: {
    readonly readId: number;
    readonly cursor: NeoPiNativeCursor | null;
  } | null;
}
export const emptyNativeObservation = (): NativeObservation => ({
  domain: null,
  cursor: null,
  entities: new Map(),
  passId: null,
  returned: new Set(),
  removed: new Map(),
  unproven: new Set(),
  carried: new Set(),
  segments: new Map(),
  inbox: [],
  inboxKey: null,
  inboxSeq: -1,
  inboxLedger: [],
  readSeq: 0,
  outstanding: null,
});
export type NativeOwnerLoss = "reconnecting" | "orphaned" | "detached";
/**
 * Where the view's observation stands (r12 C5). `attaching` until the server
 * reports a lifecycle; `transport-lost` while the socket or watch is being
 * re-attached; `unauthorized` after an authorization or profile change ended
 * the watch. The rest are the server's lifecycle facts.
 */
export type NativeObserverPhase =
  | "attaching"
  | NeoPiNativeObservationLifecycle
  | "transport-lost"
  | "unauthorized";
export interface NativeObserver {
  readonly phase: NativeObserverPhase;
  readonly reason: string | null;
}
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
  /** The observation controller's state; `nativeObservationStatus` derives catching-up from it. */
  readonly observer: NativeObserver;
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
  observer: { phase: "attaching", reason: null },
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

/**
 * Ends the outstanding read, so its reply changes nothing. Called whenever the
 * owner, the identity domain or the lease the read was sent under ends.
 */
export const invalidateNativeReads = (feed: NativeSessionFeed): NativeSessionFeed =>
  feed.observation.outstanding === null
    ? feed
    : { ...feed, observation: { ...feed.observation, outstanding: null } };

const decodeSegmentedEntity = Schema.decodeUnknownOption(Schema.fromJsonString(NeoPiNativeEntity));
/**
 * Applies one cursor-read reply in place; a rebase is a full pass in a new
 * domain or after falling behind, never a reset. Only the reply to the one
 * outstanding read applies; any other reply changes nothing. Until a full pass
 * completes, held entities stay visible and absence means nothing; at
 * completion, held keys it did not return at or below its watermark are
 * removed. Live rows retire only once their identified durable entry is
 * present; a row the authority no longer holds and cannot identify becomes a
 * continuity loss.
 */
export function applyNativeRead(
  feed: NativeSessionFeed,
  readId: number,
  result: NeoPiNativeSessionsReadResult,
): NativeSessionFeed {
  const answered = feed.observation;
  if (answered.outstanding?.readId !== readId) return feed;
  const held = { ...answered, outstanding: null };
  if (result.type !== "pass") return { ...feed, observation: held };
  const domain = result.continuation.epoch;
  const was = held.domain;
  const ownerChanged =
    was !== null &&
    (was.serverIncarnation !== domain.serverIncarnation || was.ownerEpoch !== domain.ownerEpoch);
  // Only appended to since the loaded history was read; a rebuild that cannot
  // know that changes the branch generation.
  const continuous =
    was !== null && !ownerChanged && was.branchGeneration === domain.branchGeneration;
  const sameProjection = continuous && was.projectionIncarnation === domain.projectionIncarnation;
  // Revisions of another domain are incomparable with held ones.
  const replaced = was !== null && !(sameProjection && was.buildAttempt === domain.buildAttempt);
  const entities = new Map(held.entities);
  if (replaced)
    for (const [key, entity] of entities) entities.set(key, { ...entity, revision: -1 });
  const returned = new Set(
    replaced || result.promoted || result.passId !== held.passId ? [] : held.returned,
  );
  const removed = new Map(replaced ? [] : held.removed);
  // A transfer belongs to its pass: a new, promoted or completed pass drops it.
  const segments = new Map(
    replaced || result.promoted || result.passId !== held.passId ? [] : held.segments,
  );
  const unresolved = new Set<string>();
  let conversation = feed.conversation;
  let commandOutputs = feed.commandOutputs;
  /** Output on a row that just became a loss stays after the entry its content now reads from. */
  const relocateLostOutputs = (before: NativeConversation["losses"]) => {
    const fresh = conversation.losses.filter((loss) => !before.includes(loss));
    if (fresh.length === 0) return;
    const anchors = new Map(fresh.map((loss) => [loss.messageId, loss.afterEntryId] as const));
    commandOutputs = commandOutputs.map((output) =>
      output.afterMessageId !== null && anchors.has(output.afterMessageId)
        ? {
            ...output,
            afterEntryId: anchors.get(output.afterMessageId) ?? null,
            afterMessageId: null,
          }
        : output,
    );
  };
  if (!conversation.identity && feed.session)
    conversation = reduceNativeConversation(conversation, {
      type: "identity",
      identity: {
        sessionId: feed.session.sessionId,
        sessionFile: feed.session.ref.sessionFile,
        leafId: null,
      },
    });
  // History first, so the previous owner's identified rows retire on entries
  // this reply brings before their ids are retired.
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
  let unproven = held.unproven;
  let carried = held.carried;
  if (ownerChanged) {
    const persisted = conversation.persisted;
    const losses = conversation.losses;
    conversation = reduceNativeConversation(conversation, { type: "owner_changed" });
    // Before any successor row can take the same id.
    relocateLostOutputs(losses);
    // Output on an identified row follows it under its new key, or onto its entry once retired.
    const waiting = conversation.persisted;
    commandOutputs = commandOutputs.map((output) => {
      const entryId = output.afterMessageId ? persisted.get(output.afterMessageId) : undefined;
      if (entryId === undefined) return output;
      const key = `durable:${entryId}`;
      return waiting.has(key)
        ? { ...output, afterMessageId: key }
        : { ...output, afterEntryId: entryId, afterMessageId: null };
    });
    const rename = (ids: ReadonlySet<string>) =>
      new Set(
        [...ids].flatMap((messageId) => {
          const entryId = persisted.get(messageId);
          return entryId === undefined ? [] : [`durable:${entryId}`];
        }),
      );
    unproven = rename(held.unproven);
    carried = rename(held.carried);
  }
  // Rows waiting for an unloaded entry when continuity breaks. A navigation the
  // server detected (same projection, new branch generation) leaves them
  // unproven: the entry may be on the abandoned branch. A rebuild or owner
  // change cannot know; their rows are carried and keep waiting until the
  // entry loads or the branch is loaded to its root without it.
  if (was !== null && !continuous) {
    const loadedNow = new Set(conversation.entries.map((entry) => entry.id));
    const waiting = conversation.pending.flatMap((row) => {
      const entryId = conversation.persisted.get(row.messageId);
      return entryId !== undefined && !loadedNow.has(entryId) ? [row.messageId] : [];
    });
    if (!ownerChanged && was.projectionIncarnation === domain.projectionIncarnation)
      unproven = new Set([...unproven, ...waiting]);
    else carried = new Set([...carried, ...waiting]);
  }
  const accept = (entity: NeoPiNativeEntity) => {
    returned.add(entity.key);
    const previous = entities.get(entity.key);
    if (previous && previous.revision >= entity.revision) return;
    if ((removed.get(entity.key) ?? -1) >= entity.revision) return;
    entities.set(entity.key, entity);
    removed.delete(entity.key);
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
  const remove = (key: string, revision: number, joinEntryId?: string) => {
    const previous = entities.get(key);
    // Equal revisions: completion removes a key held at exactly the watermark.
    if (previous && previous.revision > revision) return;
    removed.set(key, Math.max(revision, removed.get(key) ?? -1));
    if (!previous) return;
    entities.delete(key);
    const value = previous.value;
    if (value.class !== "message") return;
    // Retired by its durable entry: the row stays until that entry is held.
    if (joinEntryId !== undefined && conversation.identity)
      conversation = reduceNativeConversation(conversation, {
        type: "persisted",
        identity: conversation.identity,
        messageId: value.messageId,
        entryId: joinEntryId,
      });
    else unresolved.add(value.messageId);
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
    // A tombstone is the pass's answer for its key, never absence.
    returned.add(tombstone.key);
    remove(tombstone.key, tombstone.revision, tombstone.joinEntryId);
  }
  const completed = result.continuation.pass === null;
  const fullCompleted = completed && result.kind === "full";
  if (fullCompleted) {
    for (const [key, entity] of entities)
      if (!returned.has(key) && entity.revision <= result.coveredThrough)
        remove(key, result.coveredThrough);
    // A completed full pass holds every live message the authority knows.
    const live = new Set<string>();
    for (const { value } of entities.values())
      if (value.class === "message") live.add(value.messageId);
    for (const row of conversation.pending)
      if (!live.has(row.messageId)) unresolved.add(row.messageId);
  }
  // An identified row waits for its entry. A completed full pass ends that wait
  // only with proof the entry is not on this branch: a navigation left it
  // unproven, or the branch is loaded back to its root without it.
  const loaded = new Set(conversation.entries.map((entry) => entry.id));
  const wholeBranch =
    conversation.entries[0]?.parentId === null && nativeConversationGaps(conversation).size === 0;
  for (const messageId of unresolved) {
    const entryId = conversation.persisted.get(messageId);
    if (
      entryId !== undefined &&
      !(
        fullCompleted &&
        !loaded.has(entryId) &&
        (unproven.has(messageId) || (carried.has(messageId) && wholeBranch))
      )
    )
      unresolved.delete(messageId);
  }
  if (unresolved.size > 0) {
    const losses = conversation.losses;
    conversation = reduceNativeConversation(conversation, {
      type: "unresolved",
      messageIds: unresolved,
    });
    relocateLostOutputs(losses);
  }
  // A completed pass moved `base` past every fence at or below it.
  if (completed)
    for (const [key, revision] of removed)
      if (revision <= result.continuation.base) removed.delete(key);
  // Inbox sequence numbers belong to one projection; a navigation keeps them.
  const inboxKey = JSON.stringify([
    domain.serverIncarnation,
    domain.ownerEpoch,
    domain.projectionIncarnation,
  ]);
  const sameInbox = held.inboxKey === inboxKey;
  let inboxSeq = sameInbox ? held.inboxSeq : -1;
  const kept = sameInbox ? held.inboxLedger : [];
  const ledger = result.inbox.length === 0 ? [] : [...kept];
  const arrived: NeoPiNativeInboxRecord[] = [];
  for (const record of result.inbox) {
    if (record.seq <= inboxSeq) continue;
    if (record.type !== "gap") {
      arrived.push(record);
      ledger.push({
        fromSeq: record.seq,
        notices: record.type === "notice" ? 1 : 0,
        toolStreams:
          record.type === "tool_stream_update"
            ? [{ toolCallId: record.toolCallId, updates: 1 }]
            : [],
        lastReceivedAt: null,
      });
    } else {
      // A gap the server grew can cover records and gaps this view already
      // applied: only what follows them was missed, counted once.
      let notices = record.notices;
      const updates = new Map(
        record.toolStreams.map((stream) => [stream.toolCallId, stream.updates]),
      );
      let firstReceivedAt = record.firstReceivedAt;
      for (const item of ledger) {
        if (item.fromSeq < record.fromSeq) continue;
        notices -= item.notices;
        for (const stream of item.toolStreams)
          updates.set(stream.toolCallId, (updates.get(stream.toolCallId) ?? 0) - stream.updates);
        if (item.lastReceivedAt !== null)
          firstReceivedAt = Math.max(firstReceivedAt, item.lastReceivedAt);
      }
      const gap = {
        ...record,
        fromSeq: Math.max(record.fromSeq, inboxSeq + 1),
        firstReceivedAt,
        notices: Math.max(0, notices),
        toolStreams: record.toolStreams.flatMap((stream) => {
          const left = updates.get(stream.toolCallId) ?? 0;
          return left > 0 ? [{ ...stream, updates: left }] : [];
        }),
      };
      arrived.push(gap);
      ledger.push({
        fromSeq: gap.fromSeq,
        notices: gap.notices,
        toolStreams: gap.toolStreams,
        lastReceivedAt: gap.lastReceivedAt,
      });
    }
    inboxSeq = record.seq;
  }
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
      removed,
      unproven: fullCompleted ? new Set() : unproven,
      carried: new Set(
        conversation.pending.flatMap((row) => (carried.has(row.messageId) ? [row.messageId] : [])),
      ),
      segments: completed ? new Map() : segments,
      inbox: arrived.length === 0 ? held.inbox : [...held.inbox, ...arrived],
      inboxKey,
      inboxSeq,
      inboxLedger: result.inbox.length === 0 ? kept : ledger.slice(-INBOX_LEDGER_LIMIT),
      readSeq: held.readSeq,
      outstanding: null,
    },
  };
}

/**
 * Inbox records a feed keeps (gaps included). Older ones fold into one leading
 * `evicted` gap per projection, so a tool that streams forever cannot grow the
 * cache. Nothing in the client reads inbox records beyond this window.
 */
export const NATIVE_INBOX_LIMIT = 512;
/** Command output rows a feed keeps: the projection retains the newest 256 receipts. */
export const NATIVE_COMMAND_OUTPUT_LIMIT = 256;
/** Per-call detail one folded gap lists before it reports `toolStreamsTruncated`. */
const NATIVE_GAP_TOOL_STREAMS = 64;
type NativeInboxGap = Extract<NeoPiNativeInboxRecord, { type: "gap" }>;

/** Folds a run of inbox records of one projection into the gap the server would have sent. */
function foldNativeInbox(records: readonly NeoPiNativeInboxRecord[], at: number): NativeInboxGap {
  const streams = new Map<string, NativeInboxGap["toolStreams"][number]>();
  let truncated = false;
  let notices = 0;
  let notObserved = false;
  // Records carry no server receive time, so a client fold ends at the time it
  // happened; a folded gap keeps its own earlier start.
  let firstReceivedAt = at;
  const count = (stream: NativeInboxGap["toolStreams"][number]) => {
    const prior = streams.get(stream.toolCallId);
    if (prior)
      streams.set(stream.toolCallId, { ...prior, updates: prior.updates + stream.updates });
    else if (streams.size < NATIVE_GAP_TOOL_STREAMS) streams.set(stream.toolCallId, stream);
    else truncated = true;
  };
  for (const record of records) {
    if (record.type === "notice") notices++;
    else if (record.type === "tool_stream_update")
      count({ toolCallId: record.toolCallId, toolName: record.toolName, updates: 1 });
    else {
      notices += record.notices;
      for (const stream of record.toolStreams) count(stream);
      truncated ||= record.toolStreamsTruncated;
      notObserved ||= record.reason === "not-observed";
      firstReceivedAt = Math.min(firstReceivedAt, record.firstReceivedAt);
    }
  }
  const first = records[0]!;
  const last = records.at(-1)!;
  return {
    type: "gap",
    seq: last.seq,
    reason: notObserved ? "not-observed" : "evicted",
    fromSeq: first.type === "gap" ? first.fromSeq : first.seq,
    toSeq: last.seq,
    firstReceivedAt,
    lastReceivedAt: at,
    notices,
    toolStreams: [...streams.values()],
    toolStreamsTruncated: truncated,
  };
}

/**
 * Keeps the inbox within `NATIVE_INBOX_LIMIT` by cutting from the front; the
 * cut records become one leading `evicted` gap, so nothing is dropped silently.
 * Dedupe and gap arithmetic live in `inboxSeq`/`inboxLedger`, which this never touches.
 */
export function boundNativeInbox(observation: NativeObservation, at: number): NativeObservation {
  const { inbox } = observation;
  if (inbox.length <= NATIVE_INBOX_LIMIT) return observation;
  const cut = inbox.length - NATIVE_INBOX_LIMIT + 1;
  return {
    ...observation,
    inbox: [foldNativeInbox(inbox.slice(0, cut), at), ...inbox.slice(cut)],
  };
}

/** Catching up (r12 C5, D-19): attaching, building, or a full pass in progress. */
export function nativeObservationStatus(feed: NativeSessionFeed): {
  readonly phase: NativeObserverPhase | "rebasing";
  readonly catchingUp: boolean;
} {
  const { phase } = feed.observer;
  if (phase === "attaching" || phase === "building") return { phase, catchingUp: true };
  const cursor = feed.observation.cursor;
  if (phase === "observing" && (cursor === null || cursor.pass?.kind === "full"))
    return { phase: "rebasing", catchingUp: true };
  return { phase, catchingUp: false };
}

/** One child's roster key (`roster:<id>`) replayed in its authority order: history, live inventory, lifecycle, progress. */
function projectNativeChild(
  agents: readonly NativeSubagent[],
  row: Readonly<Record<string, unknown>>,
  revision: number,
  at: string,
): readonly NativeSubagent[] {
  const id = row.id;
  const index = agents.findIndex((agent) => agent.id === id);
  let child: readonly NativeSubagent[] = index < 0 ? [] : [agents[index]!];
  if (row.history !== undefined)
    child = mergeNativeSubagentHistory(child, [row.history], revision, at);
  // `null`: held but missing from the live inventory at its last read.
  if (row.inventory !== undefined)
    child = snapshotNativeSubagents(
      child,
      row.inventory === null ? [] : [row.inventory],
      revision,
      revision,
      at,
    );
  if (row.lifecycle !== undefined)
    child = reduceNativeSubagents(
      child,
      { type: "subagent_lifecycle", payload: row.lifecycle },
      revision,
      at,
    );
  if (row.progress !== undefined)
    child = reduceNativeSubagents(
      child,
      { type: "subagent_progress", payload: row.progress },
      revision,
      at,
    );
  const next = child[0];
  if (!next) return agents;
  return index < 0
    ? [...agents, next]
    : agents.map((agent, position) => (position === index ? next : agent));
}

/**
 * Maps projection keys into the feed fields web and mobile read. Keys are
 * replaced by key: a rebase never flashes agents as disconnected. Command
 * output stays once shown, as it did across reconnects before.
 */
function projectNativeEntities(
  before: NativeSessionFeed,
  feed: NativeSessionFeed,
): NativeSessionFeed {
  const previous = before.observation.entities;
  const entities = feed.observation.entities;
  if (previous === entities) return feed;
  const at = DateTime.formatIso(DateTime.nowUnsafe());
  const revision = feed.agentsRevision + 1;
  const domain = feed.observation.domain;
  const scope = domain
    ? `${domain.serverIncarnation}:${domain.ownerEpoch}:${domain.projectionIncarnation}`
    : "";
  let agents = feed.agents;
  let state: Record<string, unknown> | null = null;
  let queue = feed.queue;
  let activity = feed.activity;
  let error = feed.error;
  let commandsRevision = feed.commandsRevision;
  let dictation = feed.dictation;
  let editor = feed.editor;
  let jobs = feed.jobs;
  let jobsChanged = false;
  // Copied on first write, then written in place.
  let agentTicks: Record<string, number> | null = null;
  let notices: Record<string, string> | null = null;
  const outputs = new Set(feed.commandOutputs.map((output) => output.id));
  const added: NativeCommandOutput[] = [];
  for (const [key, entity] of entities) {
    if (previous.get(key)?.value === entity.value) continue;
    const value = entity.value;
    if (value.class === "roster") {
      const row = value.value;
      agents = projectNativeChild(agents, row, revision, at);
      if (typeof row.id === "string" && typeof row.ticks === "number") {
        agentTicks ??= { ...feed.agentTicks };
        agentTicks[row.id] = row.ticks;
      }
    } else if (value.class === "receipt") {
      const receipt = value.value;
      const id = `${scope}:${key}`;
      if (receipt.kind === "command_output" && typeof receipt.text === "string" && !outputs.has(id))
        added.push({
          id,
          text: receipt.text,
          afterEntryId: typeof receipt.afterEntryId === "string" ? receipt.afterEntryId : null,
          afterMessageId:
            typeof receipt.afterMessageId === "string" ? receipt.afterMessageId : null,
        });
    } else if (value.class === "setting" && value.value.property === "state") {
      if (feed.session) {
        state = nativeRecord(value.value.value);
        queue = nativePromptQueue(state.queuedMessages) ?? queue;
        activity = observeNativeActivity(activity, state, feed.busy, nowMs());
      }
    } else if (value.class === "setting" && value.value.property === "queue")
      queue = nativePromptQueue(value.value.value) ?? queue;
    else if (value.class === "fault" && typeof value.value.message === "string")
      error = value.value.message;
    else if (value.class === "presentation") {
      const record = value.value;
      if (key.startsWith("job:") || key === "presentation:jobs") jobsChanged = true;
      else if (key === "presentation:available_commands_update") commandsRevision++;
      else if (key === "presentation:dictation" && typeof record.captureId === "string")
        dictation = {
          captureId: record.captureId,
          phase: DICTATION_PHASES.has(record.phase)
            ? (record.phase as NativeDictation["phase"])
            : "ended",
          text: typeof record.text === "string" ? record.text : "",
          error: typeof record.error === "string" && record.error ? record.error : null,
        };
      else if (
        key === "presentation:editorText" &&
        typeof record.id === "string" &&
        typeof record.text === "string"
      )
        editor = { id: record.id, text: record.text };
      else if (key === "presentation:promptResult") {
        if (record.status === "error")
          error = typeof record.error === "string" ? record.error : "Native command failed.";
        else if (!feed.reconciliationError) error = null;
      } else {
        const notice =
          key === "presentation:notify" && typeof record.message === "string"
            ? (["notification", record.message] as const)
            : record.method === "setStatus" && typeof record.statusKey === "string"
              ? ([
                  record.statusKey,
                  typeof record.statusText === "string" ? record.statusText : "",
                ] as const)
              : record.method === "setWidget" && typeof record.widgetKey === "string"
                ? ([
                    record.widgetKey,
                    Array.isArray(record.widgetLines) ? record.widgetLines.join("\n") : "",
                  ] as const)
                : null;
        if (notice) {
          notices ??= { ...feed.notices };
          notices[notice[0]] = notice[1];
        }
      }
    }
  }
  for (const [key, entity] of previous) {
    if (entities.has(key)) continue;
    if (entity.value.class === "roster") {
      const id = entity.value.value.id;
      agents = agents.filter((agent) => agent.id !== id);
    } else if (key.startsWith("job:")) jobsChanged = true;
  }
  if (jobsChanged) {
    const running: unknown[] = [];
    let runningCount: unknown;
    for (const [key, { value }] of entities)
      if (value.class !== "presentation") continue;
      else if (key.startsWith("job:")) running.push(value.value.job);
      else if (key === "presentation:jobs") runningCount = value.value.runningCount;
    jobs = snapshotNativeJobs(jobs, { running, runningCount }, jobs.revision);
  }
  return {
    ...feed,
    session: state && feed.session ? { ...feed.session, state } : feed.session,
    queue,
    activity,
    error,
    commandsRevision,
    dictation,
    editor,
    jobs,
    notices: notices ?? feed.notices,
    agents,
    agentsRevision: agents === feed.agents ? feed.agentsRevision : revision,
    // A completed pass holds every roster key the authority knows.
    agentsKnown: feed.agentsKnown || feed.observation.passId === null,
    agentTicks: agentTicks ?? feed.agentTicks,
    // The projection keeps the newest NATIVE_COMMAND_OUTPUT_LIMIT receipts; so does the feed.
    commandOutputs:
      added.length > 0
        ? [...feed.commandOutputs, ...added].slice(-NATIVE_COMMAND_OUTPUT_LIMIT)
        : feed.commandOutputs,
  };
}

function endNativeOwner(
  feed: NativeSessionFeed,
  ownerLoss: NativeOwnerLoss | null,
  reason: string,
): NativeSessionFeed {
  return {
    ...feed,
    connected: false,
    ownerLoss,
    dialogs: [],
    agentsEpoch: feed.agentsEpoch + 1,
    activity: closeNativeActivity(feed.activity, nowMs()),
    busy: false,
    // Only a stopped owner stops its agents.
    agents: disconnectNativeSubagents(
      feed.agents,
      feed.agentsRevision + 1,
      DateTime.formatIso(DateTime.nowUnsafe()),
    ),
    agentsRevision: feed.agentsRevision + 1,
    agentsKnown: false,
    queue: EMPTY_NATIVE_QUEUE,
    error: ownerLoss === null ? reason : null,
    // The owner is gone, so no end frame is coming for a live capture.
    dictation:
      feed.dictation && feed.dictation.phase !== "ended"
        ? { ...feed.dictation, phase: "ended" as const, error: reason }
        : feed.dictation,
  };
}

const DIALOG_REQUESTS: ReadonlySet<unknown> = new Set([
  "tool_approval_request",
  "plan_proposal_request",
  "extension_ui_request",
]);

/** Applies one essential `watch` envelope. */
function reduceNativeEssential(
  feed: NativeSessionFeed,
  envelope: NeoPiNativeEssentialEnvelope,
): NativeSessionFeed {
  switch (envelope.type) {
    case "leased":
      return feed;
    case "session": {
      const session = envelope.session;
      const sameSession =
        feed.session?.ref.sessionFile === session.ref.sessionFile &&
        feed.session.ref.providerInstanceId === session.ref.providerInstanceId &&
        feed.session.sessionId === session.sessionId;
      const busy = session.state.isStreaming === true;
      return {
        ...feed,
        session,
        ...(sameSession
          ? {}
          : {
              conversation: emptyNativeConversation(),
              observation: emptyNativeObservation(),
              commandOutputs: [],
              agents: [],
              agentsRevision: feed.agentsRevision + 1,
              agentsKnown: false,
              jobs: EMPTY_NATIVE_JOBS,
            }),
        activity: observeNativeActivity(
          sameSession ? feed.activity : EMPTY_NATIVE_ACTIVITY,
          session.state,
          busy,
          nowMs(),
        ),
        connected: true,
        movedTo: null,
        busy,
        queue: nativePromptQueue(session.state.queuedMessages) ?? feed.queue,
        error: null,
        ownerLoss: null,
        reconciliationError: null,
      };
    }
    case "identity": {
      const session = feed.session;
      // The same session relocated to another file (`/wt`, `/move`): the web
      // layer repoints to it. The watch then ends as `identity-changed`.
      if (
        !session ||
        envelope.sessionFile === session.ref.sessionFile ||
        envelope.sessionId !== session.sessionId
      )
        return feed;
      const ref = { ...session.ref, sessionFile: envelope.sessionFile };
      const identity = feed.conversation.identity;
      return {
        ...feed,
        session: { ...session, ref },
        conversation: identity
          ? { ...feed.conversation, identity: { ...identity, sessionFile: envelope.sessionFile } }
          : feed.conversation,
        movedTo: ref,
      };
    }
    case "lifecycle": {
      const observer: NativeObserver = { phase: envelope.state, reason: envelope.reason ?? null };
      const reason = envelope.reason ?? "The native session ended.";
      switch (envelope.state) {
        case "building":
        case "observing":
          return {
            ...feed,
            observer,
            ownerLoss: feed.ownerLoss === "reconnecting" ? null : feed.ownerLoss,
          };
        case "reconnecting":
          // The server waits for the owner's successor and holds sends. Nothing
          // the old owner was doing continues.
          return {
            ...feed,
            observer,
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
                ? { ...feed.dictation, phase: "ended" as const, error: reason }
                : feed.dictation,
          };
        case "owner-stopped":
          return { ...endNativeOwner(feed, "orphaned", reason), observer };
        case "detached":
          return { ...endNativeOwner(feed, "detached", reason), observer };
        case "incompatible":
          return { ...endNativeOwner(feed, null, reason), observer };
        case "identity-changed":
          return {
            ...endNativeOwner(
              feed,
              null,
              "The native owner changed session. Select its new native file before sending commands.",
            ),
            observer,
            editor: null,
            jobs: EMPTY_NATIVE_JOBS,
          };
        case "authority-unresolved":
          // Cached state stays; the controller retries attach only.
          return { ...feed, observer, connected: false, dialogs: [] };
      }
    }
    case "status": {
      const busy = envelope.live.state !== "idle";
      if (busy === feed.busy) return feed;
      const at = nowMs();
      return {
        ...feed,
        busy,
        activity: busy
          ? openNativeActivity(feed.activity, at)
          : closeNativeActivity(feed.activity, at),
      };
    }
    case "obligation-opened": {
      const request = envelope.request;
      if (!DIALOG_REQUESTS.has(request.type)) return feed;
      return {
        ...feed,
        dialogs: [...feed.dialogs.filter((dialog) => dialog.id !== envelope.id), request],
      };
    }
    case "obligation-settled":
      return { ...feed, dialogs: feed.dialogs.filter((dialog) => dialog.id !== envelope.id) };
  }
}

/** Cache is a projection of the canonical native file, never a second session journal. */
export function reduceNativeSessionFeed(
  feed: NativeSessionFeed,
  event: NativeSessionUpdate,
): NativeSessionFeed {
  if (event.type === "read-issued") {
    const { observation } = feed;
    const readId = observation.readSeq + 1;
    return {
      ...feed,
      observation: {
        ...observation,
        readSeq: readId,
        outstanding: { readId, cursor: observation.cursor },
      },
    };
  }
  if (event.type === "read") {
    const next = applyNativeRead(feed, event.readId, event.result);
    if (next === feed) return feed;
    // `building` answers while the projection rebuilds (first build, navigation);
    // the first pass after it means the rebuild published.
    const phase = feed.observer.phase;
    const observer: NativeObserver | null =
      event.result.type === "building" && phase === "observing"
        ? { phase: "building", reason: null }
        : event.result.type === "pass" && phase === "building"
          ? { phase: "observing", reason: null }
          : null;
    const projected = projectNativeEntities(feed, observer ? { ...next, observer } : next);
    const observation = boundNativeInbox(projected.observation, nowMs());
    return observation === projected.observation ? projected : { ...projected, observation };
  }
  if (event.type === "observer")
    return { ...feed, observer: { phase: event.phase, reason: event.reason ?? null } };
  if (
    event.type === "leased" ||
    event.type === "session" ||
    event.type === "identity" ||
    event.type === "lifecycle" ||
    event.type === "status" ||
    event.type === "obligation-opened" ||
    event.type === "obligation-settled"
  )
    return reduceNativeEssential(
      // A new lease, or an owner, domain or lease ending, retires the outstanding read.
      event.type === "leased" ||
        (event.type === "lifecycle" && event.state !== "building" && event.state !== "observing")
        ? invalidateNativeReads(feed)
        : feed,
      event,
    );
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
      // The old owner's outstanding read must not apply to its successor.
      ...invalidateNativeReads(feed),
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
      ...invalidateNativeReads(feed),
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
  // Output follows its live row until that row retires onto its durable entry.
  const live = new Set(feed.conversation.pending.map((message) => message.messageId));
  for (const output of feed.commandOutputs) {
    const messageId = output.afterMessageId;
    const anchor =
      messageId === null
        ? output.afterEntryId
        : live.has(messageId)
          ? `live:${messageId}`
          : (feed.conversation.persisted.get(messageId) ?? `live:${messageId}`);
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
