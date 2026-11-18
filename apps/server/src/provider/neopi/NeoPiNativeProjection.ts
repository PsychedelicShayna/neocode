import type {
  NeoPiEditFilePreview,
  NeoPiNativeEntityValue,
  NeoPiNativeEssentialEnvelope,
  NeoPiNativeInboxRecord,
  NeoPiNativeObservationDomain,
  NeoPiNativeObservedJournalEntry,
  NeoPiNativeSessionCommand,
} from "@t3tools/contracts";

import { observeNeoPiJournalEntry, observeNeoPiMessage } from "./NeoPiStopOutcome.ts";

/**
 * The owner projection (r12 §2.3 C1): one per native session, fed by a
 * synchronous sink. `fold` is pure, synchronous and does work proportional to
 * the frame and the keys it changes; there is no queue and no asynchronous step
 * in it. Bulk state lives in a keyed store read by cursor
 * (`NeoPiNativeCursor.ts`); obligations and identity are essential state and
 * reach observers through `onEssential` envelopes that share the store's
 * revision space.
 */

type NativeRecord = Record<string, unknown>;

const asRecord = (value: unknown): NativeRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as NativeRecord)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A frozen encoding of one revision of an oversized value, cut into segments. */
export interface NeoPiNativeFrozenEncoding {
  readonly key: string;
  readonly revision: number;
  readonly json: string;
  readonly bounds: readonly number[];
}

/** One projection key. `value === null` is a tombstone; `removed` once its tombstone expired. */
export interface NeoPiNativeStoreRecord {
  readonly key: string;
  readonly ordinal: number;
  revision: number;
  value: NeoPiNativeEntityValue | null;
  /**
   * For a retired message or tool: the durable entry that replaced it. The
   * tombstone is sent only together with, or after, that entry.
   */
  joinEntryId: string | null;
  /** Which tombstone bound holds this record while it is a tombstone. */
  retention: "plain" | "message" | "other";
  removed: boolean;
}

/**
 * Keyed state with a unique revision per mutation, a stable order by creation
 * ordinal, and tombstones (r12 C1: "Every key mutation gets its own unique
 * revision, keys have a stable order, and a removed key leaves a tombstone").
 * Tombstones are retained up to a bound; the highest expired tombstone revision
 * is the horizon below which an incremental pass cannot be served (C2).
 */
export class NeoPiNativeKeyedStore {
  #revision = 0;
  #nextOrdinal = 1;
  #horizon = 0;
  readonly #byKey = new Map<string, NeoPiNativeStoreRecord>();
  /** Ordinal order; expired records stay until compaction and are skipped. */
  #order: NeoPiNativeStoreRecord[] = [];
  #removedInOrder = 0;
  /**
   * Plain tombstones, message join tombstones and other (tool, edit preview)
   * join tombstones, each in revision order with its own bound, so tool churn
   * never expires a message's association.
   */
  readonly #queues = {
    plain: new TombstoneQueue(),
    message: new TombstoneQueue(),
    other: new TombstoneQueue(),
  };
  /** Durable entry id → the retired records it joined, while their tombstones are retained. */
  readonly #joins = new Map<string, Set<NeoPiNativeStoreRecord>>();
  /** Reader → the oversized value it is in the middle of receiving (C2 progress). */
  readonly #transfers = new Map<string, NeoPiNativeFrozenEncoding>();

  readonly tombstoneCapacity: number;
  /**
   * Join tombstones tell a reader that has not received the durable entry to
   * keep the live row until it does (C2 invariant 2), so they are kept apart
   * from plain churn. The message bound matches the 256 live→durable
   * associations a NeoPi snapshot carries; beyond it the C5 typed continuity
   * loss applies. Tool and edit-preview joins have the same bound of their own.
   */
  readonly joinTombstoneCapacity: number;

  constructor(tombstoneCapacity: number, joinTombstoneCapacity = 256) {
    this.tombstoneCapacity = tombstoneCapacity;
    this.joinTombstoneCapacity = joinTombstoneCapacity;
  }

  get revision(): number {
    return this.#revision;
  }

  /** Every tombstone above this revision is still retained. */
  get horizon(): number {
    return this.#horizon;
  }

  /** The highest ordinal issued so far; 0 when none. */
  get lastOrdinal(): number {
    return this.#nextOrdinal - 1;
  }

  get(key: string): NeoPiNativeStoreRecord | undefined {
    return this.#byKey.get(key);
  }

  /** A revision for essential state kept outside the keyed order (obligations, identity). */
  bump(): number {
    return ++this.#revision;
  }

  /** The retired records whose durable entry is `entryId`, while their tombstones are retained. */
  retiredBy(entryId: string): ReadonlySet<NeoPiNativeStoreRecord> | undefined {
    return this.#joins.get(entryId);
  }

  /**
   * The encoding `reader` is in the middle of receiving. It is the reader's
   * own: no other reader's activity replaces it, so a transfer ends only when
   * this reader finishes or leaves it. At most one per reader.
   */
  transferOf(reader: string): NeoPiNativeFrozenEncoding | undefined {
    return this.#transfers.get(reader);
  }

  /** Starts `reader`'s transfer of `record`'s current value, sharing an identical encoding. */
  beginTransfer(
    reader: string,
    record: NeoPiNativeStoreRecord,
    json: string,
    bounds: () => readonly number[],
  ): NeoPiNativeFrozenEncoding {
    let encoding: NeoPiNativeFrozenEncoding | undefined;
    for (const held of this.#transfers.values())
      if (held.key === record.key && held.revision === record.revision) encoding = held;
    encoding ??= { key: record.key, revision: record.revision, json, bounds: bounds() };
    this.#transfers.set(reader, encoding);
    return encoding;
  }

  /** Ends `reader`'s transfer: finished, abandoned, or its lease released (B5 calls this). */
  endTransfer(reader: string): void {
    this.#transfers.delete(reader);
  }

  put(key: string, value: NeoPiNativeEntityValue): number {
    const revision = ++this.#revision;
    const existing = this.#byKey.get(key);
    if (existing) {
      if (existing.value === null) this.#queues[existing.retention].count--;
      this.#unjoin(existing);
      existing.value = value;
      existing.revision = revision;
      return revision;
    }
    const record: NeoPiNativeStoreRecord = {
      key,
      ordinal: this.#nextOrdinal++,
      revision,
      value,
      joinEntryId: null,
      retention: "plain",
      removed: false,
    };
    this.#byKey.set(key, record);
    this.#order.push(record);
    return revision;
  }

  remove(key: string, joinEntryId: string | null = null): boolean {
    const record = this.#byKey.get(key);
    if (!record || record.value === null) return false;
    record.retention =
      joinEntryId === null ? "plain" : record.value.class === "message" ? "message" : "other";
    record.value = null;
    record.revision = ++this.#revision;
    record.joinEntryId = joinEntryId;
    if (joinEntryId !== null) {
      const joined = this.#joins.get(joinEntryId) ?? new Set();
      joined.add(record);
      this.#joins.set(joinEntryId, joined);
    }
    this.#queues[record.retention].push(record);
    this.#expire();
    return true;
  }

  #unjoin(record: NeoPiNativeStoreRecord): void {
    const joined = record.joinEntryId === null ? undefined : this.#joins.get(record.joinEntryId);
    if (joined) {
      joined.delete(record);
      if (joined.size === 0) this.#joins.delete(record.joinEntryId!);
    }
    record.joinEntryId = null;
    record.retention = "plain";
  }

  /** Drops every key; the caller changes the identity domain, so no tombstone is owed. */
  clear(): void {
    this.#byKey.clear();
    this.#joins.clear();
    this.#transfers.clear();
    this.#order = [];
    this.#removedInOrder = 0;
    for (const queue of Object.values(this.#queues)) queue.reset();
    this.#retired.clear();
    this.#retiredOrder = [];
    this.#horizon = this.#revision;
  }

  /** Tombstone queue entries held, stale ones included (a bound check). */
  get tombstoneEntries(): number {
    return Object.values(this.#queues).reduce((total, queue) => total + queue.size, 0);
  }

  /** Index into `recordAt` of the first record whose ordinal exceeds `ordinal`. */
  indexAfter(ordinal: number | null): number {
    if (ordinal === null) return 0;
    let low = 0;
    let high = this.#order.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#order[middle]!.ordinal <= ordinal) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** Records in ordinal order, including expired ones (`removed`), which a reader skips. */
  recordAt(index: number): NeoPiNativeStoreRecord | undefined {
    return this.#order[index];
  }

  *values(): IterableIterator<NeoPiNativeStoreRecord> {
    yield* this.#byKey.values();
  }

  #expire(): void {
    for (const [retention, queue] of Object.entries(this.#queues)) {
      const capacity = retention === "plain" ? this.tombstoneCapacity : this.joinTombstoneCapacity;
      for (let record = queue.over(capacity); record; record = queue.over(capacity)) {
        if (record.joinEntryId !== null) this.#rememberRetired(record.key);
        record.removed = true;
        this.#unjoin(record);
        this.#byKey.delete(record.key);
        this.#removedInOrder++;
        if (record.revision > this.#horizon) this.#horizon = record.revision;
      }
    }
    if (this.#removedInOrder > 64 && this.#removedInOrder * 2 > this.#order.length) {
      this.#order = this.#order.filter((record) => !record.removed);
      this.#removedInOrder = 0;
    }
  }

  /**
   * Keys retired by a durable join whose tombstone has expired, so a late or
   * replayed frame cannot recreate them as live (C1: an ended message never
   * regresses; a joined tool outcome stays retired). A bounded ring.
   */
  wasRetired(key: string): boolean {
    return this.#retired.has(key);
  }

  readonly #retired = new Set<string>();
  #retiredOrder: string[] = [];

  #rememberRetired(key: string): void {
    if (this.#retired.has(key)) return;
    this.#retired.add(key);
    this.#retiredOrder.push(key);
    if (this.#retiredOrder.length > RETIRED_KEY_RING) {
      const dropped = this.#retiredOrder.length - RETIRED_KEY_RING;
      for (const old of this.#retiredOrder.slice(0, dropped)) this.#retired.delete(old);
      this.#retiredOrder = this.#retiredOrder.slice(dropped);
    }
  }
}

/**
 * Retired keys remembered after their tombstones expire. Late frames for a
 * retired call arrive within one run; 4096 covers far more than one run's
 * messages and tool calls.
 */
const RETIRED_KEY_RING = 4096;

/** Finished children kept when the owner has no history to say which are gone. */
const FINISHED_CHILDREN = 256;
/** Settled jobs kept; NeoPi's own `recent` list is shorter. */
const SETTLED_JOBS = 64;
/**
 * Command outputs kept. They are receipts with no acknowledgement path before
 * N11a, so the newest are kept and the oldest leave by tombstone.
 */
const COMMAND_OUTPUTS = 256;

/** Tombstones in revision order; an entry is stale once its record changed. */
class TombstoneQueue {
  #entries: Array<{ readonly record: NeoPiNativeStoreRecord; readonly revision: number }> = [];
  #head = 0;
  count = 0;

  push(record: NeoPiNativeStoreRecord): void {
    this.#entries.push({ record, revision: record.revision });
    this.count++;
    // A tombstone overwritten by a later put leaves a stale entry; drop them
    // so one key put and removed forever cannot grow the queue (I2).
    if (this.#entries.length - this.#head > 2 * this.count + 64) {
      this.#entries = this.#entries
        .slice(this.#head)
        .filter(
          ({ record: held, revision }) =>
            !held.removed && held.value === null && held.revision === revision,
        );
      this.#head = 0;
    }
  }

  get size(): number {
    return this.#entries.length - this.#head;
  }

  /** The oldest live tombstone to expire while more than `capacity` are held, removed from the count. */
  over(capacity: number): NeoPiNativeStoreRecord | undefined {
    while (this.count > capacity) {
      const entry = this.#entries[this.#head++];
      if (!entry) break;
      const { record, revision } = entry;
      if (record.removed || record.value !== null || record.revision !== revision) continue;
      this.count--;
      this.#compact();
      return record;
    }
    this.#compact();
    return undefined;
  }

  reset(): void {
    this.#entries = [];
    this.#head = 0;
    this.count = 0;
  }

  #compact(): void {
    if (this.#head > 64 && this.#head * 2 > this.#entries.length) {
      this.#entries = this.#entries.slice(this.#head);
      this.#head = 0;
    }
  }
}

/** Recent journal entries by absolute position, joined by entry identity (C3.4). */
export class NeoPiNativeJournalTail {
  #entries: NeoPiNativeObservedJournalEntry[] = [];
  #offset = 0;
  #start = 0;
  #origin = 0;
  readonly #positions = new Map<string, number>();

  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** Absolute position of the oldest retained entry. */
  get start(): number {
    return this.#start;
  }

  /** Absolute position where the tail last restarted; equal to `start` while nothing was evicted. */
  get origin(): number {
    return this.#origin;
  }

  /** One past the absolute position of the newest entry. */
  get end(): number {
    return this.#start + this.#entries.length - this.#offset;
  }

  get head(): NeoPiNativeObservedJournalEntry | undefined {
    return this.#entries[this.#entries.length - 1];
  }

  at(position: number): NeoPiNativeObservedJournalEntry | undefined {
    return position < this.#start
      ? undefined
      : this.#entries[position - this.#start + this.#offset];
  }

  /** -1 when the entry is not retained. */
  positionOf(id: string): number {
    return this.#positions.get(id) ?? -1;
  }

  append(entry: NeoPiNativeObservedJournalEntry): void {
    this.#positions.set(entry.id, this.end);
    this.#entries.push(entry);
    while (this.end - this.#start > this.capacity) {
      const dropped = this.#entries[this.#offset++]!;
      this.#positions.delete(dropped.id);
      this.#start++;
    }
    if (this.#offset > 64 && this.#offset * 2 > this.#entries.length) {
      this.#entries = this.#entries.slice(this.#offset);
      this.#offset = 0;
    }
  }

  /** Keeps the entries up to and including `position`; positions stay absolute. */
  truncateAfter(position: number): void {
    while (this.end - 1 > position) {
      const dropped = this.#entries.pop()!;
      this.#positions.delete(dropped.id);
    }
  }

  /** Empties the tail; later entries continue the absolute positions. */
  reset(): void {
    const end = this.end;
    this.#entries = [];
    this.#offset = 0;
    this.#positions.clear();
    this.#start = end;
    this.#origin = end;
  }
}

export interface NeoPiNativeIdentity {
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly leafId: string | null;
}

/**
 * What a reply must have been requested under to be applied (C3.3): replies
 * from another projection incarnation, build attempt or branch are rejected,
 * a key changed after `revision` is not overwritten, and of two replies of one
 * kind the one requested later (`request`, unique per mark) wins, even when no
 * store write separates the requests.
 */
export interface NeoPiNativeRequestMark {
  readonly revision: number;
  readonly request: number;
  readonly projectionIncarnation: number;
  readonly buildAttempt: number;
  readonly branchGeneration: number;
}

/** Fences a fold can raise. `identity-changed` and `navigated` both restart a build (C3.5). */
export type NeoPiNativeFence = "none" | "identity-changed" | "navigated";

export interface NeoPiNativeProjectionOptions {
  readonly domain: NeoPiNativeObservationDomain;
  readonly tombstoneCapacity: number;
  readonly journalCapacity: number;
  /** Hard inbox bound (decision 8); the oldest records are evicted into one gap record. */
  readonly inboxLimits?: NeoPiNativeInboxLimits;
  /** Receive time for inbox records; synchronous. */
  readonly now?: () => number;
  /** Essential facts, synchronously, in revision order. */
  readonly onEssential?: (envelope: NeoPiNativeProjectionEnvelope) => void;
  /**
   * Every fence, wherever it is raised: a fold, or a read settling a quiet
   * navigation. The build owner restarts its build on it (C3.5).
   */
  readonly onFence?: (fence: Exclude<NeoPiNativeFence, "none">) => void;
}

export interface NeoPiNativeInboxLimits {
  readonly records: number;
  readonly bytes: number;
}

/**
 * Inbox bound per owner. r12 gives no inbox figure; its bounded event stream
 * precedent is 256 items / 512 KiB (§2.7 R4). The inbox holds only one primary
 * session's live-only records (child streams are not in it in stage one), so
 * 64 children add nothing here. 512 records / 512 KiB per owner: with 1,000
 * executing agents spread as 16 owners × 64 children, every owner at its bound
 * is 16 × 512 KiB = 8 MiB, the shared-budget precedent (1000 / 8 MiB); a
 * single-agent-per-owner spread (1,000 owners) is not a supported shape for
 * this bound and would be 500 MiB worst case, which is why rule (a) — nothing
 * retained without a lease — matters (B5).
 */
export const NEOPI_NATIVE_INBOX_LIMITS: NeoPiNativeInboxLimits = {
  records: 512,
  bytes: 512 * 1024,
};

/** Per-call detail a gap keeps; beyond it the gap says the detail is truncated. */
const GAP_TOOL_CALLS = 16;

/** The essential envelopes a projection produces; lease, lifecycle and status belong to the connection. */
export type NeoPiNativeProjectionEnvelope = Extract<
  NeoPiNativeEssentialEnvelope,
  { type: "identity" | "obligation-opened" | "obligation-settled" }
>;

const DIALOG_METHODS: ReadonlySet<string> = new Set([
  "select",
  "confirm",
  "input",
  "editor",
  "ask",
]);

/** `get_state` fields and the event that changes each, folded into one `setting:<property>` key. */
const STATE_SETTINGS = {
  chatMode: "chatMode",
  approvalMode: "approvalMode",
  thinkingLevel: "thinkingLevel",
  model: "model",
  goal: "goal",
  queuedMessages: "queue",
  todoPhases: "todos",
} as const;

/** Settings whose change event carries no value; the key records only that it is stale. */
const INVALIDATOR_SETTINGS: Readonly<Record<string, string>> = {
  approval_mode_changed: "approvalMode",
  model_changed: "model",
  models_configuration_changed: "modelsConfiguration",
  themes_configuration_changed: "themesConfiguration",
  config_warnings_changed: "configWarnings",
  advisor_cost_changed: "advisorCost",
  todo_reminder: "todos",
  todo_auto_clear: "todos",
};

const OPERATION_STARTS: Readonly<Record<string, string>> = {
  auto_compaction_start: "compaction",
  auto_retry_start: "retry",
  cache_warming_start: "cacheWarming",
  retry_fallback_applied: "fallback",
};

const OPERATION_ENDS: Readonly<Record<string, string>> = {
  auto_compaction_end: "compaction",
  auto_retry_end: "retry",
  cache_warming_end: "cacheWarming",
  retry_fallback_succeeded: "fallback",
};

const TERMINAL_CHILD_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "aborted"]);
const SETTLED_CHILD_EVENTS: ReadonlySet<string> = new Set([
  "message_end",
  "tool_execution_end",
  "agent_end",
]);
const DICTATION_PHASES: ReadonlySet<string> = new Set(["starting", "recording", "transcribing"]);

const messageKey = (messageId: string) => `message:${messageId}`;
const toolKey = (toolCallId: string) => `tool:${toolCallId}`;
const editPreviewKey = (toolCallId: string) => `editPreview:${toolCallId}`;
const RUN_KEY = "run";

type MessageValue = Extract<NeoPiNativeEntityValue, { class: "message" }>;
type ToolValue = Extract<NeoPiNativeEntityValue, { class: "tool" }>;
type EditPreviewValue = Extract<NeoPiNativeEntityValue, { class: "editPreview" }>;
type InboxGap = Extract<NeoPiNativeInboxRecord, { type: "gap" }>;
type InboxItem = Exclude<NeoPiNativeInboxRecord, InboxGap>;

export class NeoPiNativeProjection {
  readonly store: NeoPiNativeKeyedStore;
  readonly journal: NeoPiNativeJournalTail;
  #domain: NeoPiNativeObservationDomain;
  #identity: NeoPiNativeIdentity | null = null;
  #inbox: NeoPiNativeInboxRecord[] = [];
  #inboxSeq = 0;
  #inboxBytes = 0;
  /** Encoded bytes and receive time of each retained inbox record, parallel to `#inbox`. */
  #inboxMeta: Array<{ readonly bytes: number; readonly receivedAt: number }> = [];
  #inboxObserved = true;
  readonly #inboxLimits: NeoPiNativeInboxLimits;
  readonly #now: () => number;
  readonly #obligations = new Map<
    string,
    { readonly revision: number; readonly request: NeoPiNativeSessionCommand }
  >();
  /** Durable entry id → message id, for messages whose entry has not joined yet. */
  readonly #pendingJoins = new Map<string, string>();
  #stateApplied = false;
  #pageApplied = false;
  #rosterApplied = false;
  #historyApplied = false;
  /** Child id → revision of the last live lifecycle/progress frame; replies never overwrite it. */
  readonly #rosterLive = new Map<string, number>();
  /** Request marks of the newest applied replies; an older reply arriving later is refused (C3.3). */
  #replyMarks = { state: -1, inventory: -1, history: -1, jobs: -1 };
  #requests = 0;
  #commandOutputs = 0;
  /** The newest live message, the anchor of a command output. */
  #lastMessageId: string | null = null;
  /** Settled job keys, oldest first. */
  #settledJobs: string[] = [];
  #horizonCursor: { readonly firstEntryId: string; readonly cursor: string } | null = null;
  /** A leaf announced before its entry; decided by the next frame (see `#journalState`). */
  #pendingLeaf: NeoPiNativeIdentity | null = null;
  /**
   * Message entries whose live copy is not known yet: NeoPi sends a
   * `journal_entry` before its `message_persisted`. Entry id → the live
   * messages that had ended unassociated when it arrived.
   */
  readonly #heldEntries = new Map<string, Set<string>>();
  readonly #onEssential: ((envelope: NeoPiNativeProjectionEnvelope) => void) | undefined;
  readonly #onFence: ((fence: Exclude<NeoPiNativeFence, "none">) => void) | undefined;
  /** Messages that had ended unassociated when observation was lost (see `applyJournalPage`). */
  #endedBeforeGap = new Set<string>();
  /** A rebuild's gap is not yet reconciled by a page of an attempt whose snapshot was folded. */
  #rebuilt = false;
  /** The incarnation and attempt whose snapshot marker has been folded. */
  #snapshotOf: { readonly incarnation: number; readonly attempt: number } | null = null;

  constructor(options: NeoPiNativeProjectionOptions) {
    this.store = new NeoPiNativeKeyedStore(options.tombstoneCapacity);
    this.journal = new NeoPiNativeJournalTail(options.journalCapacity);
    this.#domain = options.domain;
    this.#inboxLimits = options.inboxLimits ?? NEOPI_NATIVE_INBOX_LIMITS;
    this.#now = options.now ?? Date.now;
    this.#onEssential = options.onEssential;
    this.#onFence = options.onFence;
  }

  get domain(): NeoPiNativeObservationDomain {
    return this.#domain;
  }

  get identity(): NeoPiNativeIdentity | null {
    return this.#identity;
  }

  /**
   * C3.4: published once live state and one validated horizon page exist; both
   * roster sources (the live inventory and, where the owner has it, the
   * history) are part of live state, so the Agents view is complete when the
   * first build publishes.
   */
  get published(): boolean {
    return this.#stateApplied && this.#pageApplied && this.#rosterApplied && this.#historyApplied;
  }

  /** Live-only records without a reducer, in `seq` order; at most one `gap`, first. */
  get inbox(): readonly NeoPiNativeInboxRecord[] {
    return this.#inbox;
  }

  get inboxBytes(): number {
    return this.#inboxBytes;
  }

  /**
   * Absolute journal position of the first entry a reader may not receive yet
   * (C2 invariant 2: an entry whose live copy is unknown is held); `journal.end`
   * when none is held.
   */
  get deliverableJournalEnd(): number {
    let end = this.journal.end;
    for (const entryId of this.#heldEntries.keys()) {
      const position = this.journal.positionOf(entryId);
      if (position >= 0 && position < end) end = position;
    }
    return end;
  }

  get obligations(): ReadonlyMap<
    string,
    { readonly revision: number; readonly request: NeoPiNativeSessionCommand }
  > {
    return this.#obligations;
  }

  /** The native page cursor before the current horizon page, while its first entry is still the tail's first. */
  get horizonCursor(): string | undefined {
    const first = this.journal.at(this.journal.start);
    return first && this.#horizonCursor?.firstEntryId === first.id
      ? this.#horizonCursor.cursor
      : undefined;
  }

  mark(): NeoPiNativeRequestMark {
    return {
      revision: this.store.revision,
      request: ++this.#requests,
      projectionIncarnation: this.#domain.projectionIncarnation,
      buildAttempt: this.#domain.buildAttempt,
      branchGeneration: this.#domain.branchGeneration,
    };
  }

  /**
   * A rebuild (new owner epoch or a replaced observation connection) starts a
   * new projection incarnation and keeps what is already held (C3.6: "A rebuild
   * inside one owner epoch keeps state the projection already holds and the
   * snapshot does not replace, in particular ended-but-not-durable messages and
   * tool outcomes"). A tool still running may have ended unseen, so its
   * coverage becomes unknown. A navigation while observation was lost cannot
   * be detected, so a rebuild also starts a new branch generation.
   */
  rebuild(ownerEpoch: number = this.#domain.ownerEpoch): void {
    this.#domain = {
      ...this.#domain,
      ownerEpoch,
      projectionIncarnation: this.#domain.projectionIncarnation + 1,
      buildAttempt: 0,
      branchGeneration: this.#domain.branchGeneration + 1,
    };
    this.#stateApplied = false;
    this.#pageApplied = false;
    this.#rosterApplied = false;
    this.#historyApplied = false;
    this.#pendingLeaf = null;
    this.#endedBeforeGap = new Set();
    this.#rebuilt = true;
    for (const record of this.store.values())
      if (record.value?.class === "message" && record.value.phase === "ended")
        this.#endedBeforeGap.add(record.value.messageId);
    const running: Array<[string, ToolValue]> = [];
    for (const record of this.store.values())
      if (
        record.value?.class === "tool" &&
        record.value.state.status !== "ended" &&
        record.value.coverage !== "unknown"
      )
        running.push([record.key, record.value]);
    for (const [key, value] of running) this.store.put(key, { ...value, coverage: "unknown" });
  }

  /**
   * C3.1: attempts are numbered within one projection incarnation. A new
   * attempt publishes on its own replies, never on an earlier attempt's (C3.5:
   * reads meanwhile return `building`).
   */
  beginBuildAttempt(): NeoPiNativeObservationDomain {
    this.#domain = { ...this.#domain, buildAttempt: this.#domain.buildAttempt + 1 };
    this.#stateApplied = false;
    this.#pageApplied = false;
    this.#rosterApplied = false;
    this.#historyApplied = false;
    return this.#domain;
  }

  fold(frame: NativeRecord): NeoPiNativeFence {
    const pending = this.#pendingLeaf;
    if (pending && frame.type === "journal_entry") {
      const entry = asRecord(frame.entry);
      // NeoPi flushes pending entries as: leaf = the LAST entry, then each
      // entry in order, each followed by its `message_persisted`
      // (`session-journal-events.ts` `committed`; `rpc-session-events.ts`
      // `#journalEvent`). Entries that extend the head keep the leaf pending;
      // its own entry resolves it; any other entry is a navigation that
      // `#journalEntry` decides by its parent. No other frame resolves it.
      if (entry?.id === pending.leafId || entry?.parentId !== (this.journal.head?.id ?? null))
        this.#pendingLeaf = null;
    }
    const fence = this.#fold(frame);
    if (fence !== "none") this.#onFence?.(fence);
    return fence;
  }

  /** A leaf was announced and neither its entry nor a navigation has arrived yet. */
  get pendingLeaf(): boolean {
    return this.#pendingLeaf !== null;
  }

  /**
   * A leaf announced with no entry after it is a move to an entry the tail no
   * longer holds: history is replaced (C3.4 navigation). Neither frames nor
   * reads can tell that from a flush still in flight, so the owner side calls
   * this once a leaf has stayed pending past its own timeout.
   */
  settlePendingLeaf(): NeoPiNativeFence {
    const fence = this.#settle();
    if (fence !== "none") this.#onFence?.(fence);
    return fence;
  }

  #settle(): NeoPiNativeFence {
    const pending = this.#pendingLeaf;
    if (!pending) return "none";
    this.#pendingLeaf = null;
    this.journal.reset();
    this.#heldEntries.clear();
    this.#navigate(pending);
    return "navigated";
  }

  #fold(frame: NativeRecord): NeoPiNativeFence {
    const type = frame.type;
    switch (type) {
      case "journal_state":
        return this.#journalState(frame);
      case "journal_entry":
        return this.#journalEntry(frame);
      case "message_persisted":
        if (
          this.#sameSession(frame) &&
          typeof frame.messageId === "string" &&
          typeof frame.entryId === "string"
        )
          this.#alias(frame.messageId, frame.entryId);
        return "none";
      case "message_start":
      case "message_update":
      case "message_end":
        this.#message(type, frame);
        return "none";
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.#tool(type, frame);
        return "none";
      case "tool_stream_update":
        this.#toolStream(frame);
        return "none";
      case "notice":
        this.#notice(frame);
        return "none";
      case "session_settled":
        this.#runEnded();
        return "none";
      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "run_owners_joined":
      case "run_owners_skipped":
        this.#run(type, frame);
        if (type === "agent_end") this.#runEnded();
        return "none";
      case "subagent_lifecycle":
      case "subagent_progress":
        this.#roster(type, frame);
        return "none";
      case "subagent_event":
        this.#rosterTick(frame);
        return "none";
      case "job_lifecycle":
        this.#job(frame);
        return "none";
      case "command_output":
        this.#commandOutput(frame);
        return "none";
      case "dictation_state":
      case "dictation_transcript":
      case "dictation_end":
        this.#dictation(frame);
        return "none";
      case "prompt_result": {
        const error = asRecord(frame.error);
        this.store.put("presentation:promptResult", {
          class: "presentation",
          value: {
            status: frame.status ?? null,
            error:
              frame.status === "error" ? String(error?.message ?? "Native command failed.") : null,
          },
        });
        return "none";
      }
      case "extension_ui_request":
        this.#uiRequest(frame);
        return "none";
      case "tool_approval_request":
      case "plan_proposal_request":
      case "host_tool_call":
      case "host_uri_request":
        if (typeof frame.id === "string")
          this.openObligation(frame.id, frame as NeoPiNativeSessionCommand);
        return "none";
      case "tool_approval_cancel":
      case "host_tool_cancel":
      case "host_uri_cancel":
        if (typeof frame.targetId === "string") this.settleObligation(frame.targetId, "cancelled");
        return "none";
      case "plan_proposal_cancel":
        if (typeof frame.id === "string") this.settleObligation(frame.id, "cancelled");
        return "none";
      case "chat_mode_changed":
        this.#setting("chatMode", { value: frame.mode });
        return "none";
      case "thinking_level_changed":
        // The `get_state` field's shape: the effective level.
        this.#setting("thinkingLevel", { value: frame.thinkingLevel ?? null });
        return "none";
      case "goal_updated":
        this.#setting("goal", { value: frame.goal ?? null });
        return "none";
      case "queue_update": {
        const { type: _type, ...value } = frame;
        this.#setting("queue", { value });
        return "none";
      }
      case "session_info_update":
      case "available_commands_update":
      case "live_phase": {
        const { type: _type, ...value } = frame;
        this.store.put(`presentation:${type}`, { class: "presentation", value });
        return "none";
      }
      default:
        if (typeof type !== "string") return "none";
        if (type in INVALIDATOR_SETTINGS)
          this.#setting(INVALIDATOR_SETTINGS[type]!, { stale: true });
        else if (type in OPERATION_STARTS) this.#operation(OPERATION_STARTS[type]!, frame, "start");
        else if (type in OPERATION_ENDS) this.#operation(OPERATION_ENDS[type]!, frame, "end");
        return "none";
    }
  }

  openObligation(id: string, request: NeoPiNativeSessionCommand): void {
    const revision = this.store.bump();
    this.#obligations.set(id, { revision, request });
    this.#onEssential?.({ type: "obligation-opened", revision, id, request });
  }

  /** Answers and results are reported by whoever sent them; cancels arrive as frames. */
  settleObligation(id: string, outcome: "answered" | "cancelled" | "resulted"): void {
    if (!this.#obligations.delete(id)) return;
    this.#onEssential?.({ type: "obligation-settled", revision: this.store.bump(), id, outcome });
  }

  /**
   * C3.3: a `get_state` reply is validated against the identity and applied
   * only to keys not changed since the request was issued.
   */
  applyStateReply(state: NativeRecord, mark: NeoPiNativeRequestMark): boolean {
    if (!this.#acceptsReply(mark) || state.sessionId !== this.#identity?.sessionId) return false;
    if (mark.request < this.#replyMarks.state) return false;
    this.#replyMarks.state = mark.request;
    for (const [field, property] of Object.entries(STATE_SETTINGS)) {
      const key = `setting:${property}`;
      if (!(field in state) || (this.store.get(key)?.revision ?? 0) > mark.revision) continue;
      this.store.put(key, { class: "setting", value: { property, value: state[field] ?? null } });
    }
    const run = this.store.get(RUN_KEY);
    if (typeof state.isStreaming === "boolean" && (run?.revision ?? 0) <= mark.revision) {
      const held = run?.value?.class === "run" ? run.value.value : {};
      this.store.put(RUN_KEY, { class: "run", value: { ...held, active: state.isStreaming } });
    }
    // The whole record (less the session-dump fields), as the client reads it
    // today, with every field a newer live frame changed taken from that frame.
    const { systemPrompt: _prompt, dumpTools: _tools, ...value } = state;
    for (const [field, property] of Object.entries(STATE_SETTINGS)) {
      const setting = this.store.get(`setting:${property}`);
      const newer = setting?.value?.class === "setting" ? setting.value.value : undefined;
      if (setting && setting.revision > mark.revision && newer && "value" in newer)
        value[field] = newer.value;
    }
    const live = this.store.get(RUN_KEY);
    if (live?.value?.class === "run" && live.revision > mark.revision)
      value.isStreaming = live.value.value.active === true;
    this.store.put("setting:state", { class: "setting", value: { property: "state", value } });
    this.#stateApplied = true;
    return true;
  }

  /**
   * The live child inventory (`get_subagents`), C1 roster recovery authority.
   * Each listed child's row is kept as `inventory`; a child held here but not
   * listed gets `inventory: null` (not active as of the read). Children a
   * frame touched after the request keep their newer state, and an older
   * reply never replaces a newer one.
   */
  applySubagentsReply(reply: NativeRecord, mark: NeoPiNativeRequestMark): boolean {
    if (!this.#acceptsReply(mark) || !Array.isArray(reply.subagents)) return false;
    if (mark.request < this.#replyMarks.inventory) return false;
    this.#replyMarks.inventory = mark.request;
    const listed = new Set<string>();
    for (const raw of reply.subagents) {
      const row = asRecord(raw);
      const id = text(row?.id);
      if (!row || id === undefined) continue;
      listed.add(id);
      this.#rosterRow(id, mark, (entry) => {
        entry.inventory = row;
        delete entry.unobserved;
      });
    }
    for (const record of this.store.values())
      if (record.value?.class === "roster") {
        const id = text(record.value.value.id);
        if (id !== undefined && !listed.has(id) && record.value.value.inventory !== null)
          this.#rosterRow(id, mark, (entry) => {
            entry.inventory = null;
          });
      }
    this.#boundRoster();
    this.#rosterApplied = true;
    return true;
  }

  /**
   * The session's whole roster, finished and persisted children included
   * (`get_subagent_history`); `null` when the owner cannot list it. A child in
   * neither this history nor the live inventory, with no newer live frame, is
   * gone from the session and leaves the store by tombstone.
   */
  applySubagentHistoryReply(reply: NativeRecord | null, mark: NeoPiNativeRequestMark): boolean {
    if (!this.#acceptsReply(mark) || (reply !== null && !Array.isArray(reply.subagents)))
      return false;
    if (mark.request < this.#replyMarks.history) return false;
    this.#replyMarks.history = mark.request;
    if (reply !== null && Array.isArray(reply.subagents)) {
      const listed = new Set<string>();
      for (const raw of reply.subagents) {
        const row = asRecord(raw);
        const id = text(row?.id);
        if (!row || id === undefined) continue;
        listed.add(id);
        this.#rosterRow(id, mark, (entry) => {
          entry.history = row;
          delete entry.unobserved;
        });
      }
      const gone: string[] = [];
      for (const record of this.store.values())
        if (record.value?.class === "roster") {
          const id = text(record.value.value.id);
          if (
            id !== undefined &&
            !listed.has(id) &&
            !record.value.value.inventory &&
            // A child marked unobserved stays until a source lists it.
            record.value.value.unobserved === undefined &&
            (this.#rosterLive.get(id) ?? 0) <= mark.revision
          )
            gone.push(id);
        }
      for (const id of gone) {
        this.store.remove(`roster:${id}`);
        this.#rosterLive.delete(id);
      }
    }
    this.#historyApplied = true;
    return true;
  }

  /**
   * Without a history to say which children are gone, finished children (not
   * in the live inventory) are kept up to a bound, oldest leaving first.
   */
  #boundRoster(): void {
    const finished: NeoPiNativeStoreRecord[] = [];
    for (const record of this.store.values())
      if (record.value?.class === "roster" && record.value.value.inventory === null)
        finished.push(record);
    finished.sort((left, right) => left.ordinal - right.ordinal);
    for (const record of finished.slice(0, Math.max(0, finished.length - FINISHED_CHILDREN))) {
      this.store.remove(record.key);
      this.#rosterLive.delete(record.key.slice("roster:".length));
    }
  }

  /**
   * The background-job inventory (`get_jobs` `{running, recent, runningCount}`):
   * listed jobs replace older state; a held job absent from both lists aged
   * out and is removed, unless a frame touched it after the request.
   */
  applyJobsReply(reply: NativeRecord, mark: NeoPiNativeRequestMark): boolean {
    if (
      !this.#acceptsReply(mark) ||
      (!Array.isArray(reply.running) && !Array.isArray(reply.recent))
    )
      return false;
    if (mark.request < this.#replyMarks.jobs) return false;
    this.#replyMarks.jobs = mark.request;
    const listed = new Set<string>();
    for (const raw of [
      ...(Array.isArray(reply.running) ? reply.running : []),
      ...(Array.isArray(reply.recent) ? reply.recent : []),
    ]) {
      const job = asRecord(raw);
      const id = text(job?.id);
      if (!job || id === undefined) continue;
      listed.add(id);
      if ((this.store.get(`job:${id}`)?.revision ?? 0) <= mark.revision) this.#putJob(id, job);
    }
    for (const record of this.store.values())
      if (
        record.key.startsWith("job:") &&
        record.value !== null &&
        record.revision <= mark.revision &&
        !listed.has(record.key.slice(4))
      )
        this.store.remove(record.key);
    const count = this.store.get("presentation:jobs");
    if (typeof reply.runningCount === "number" && (count?.revision ?? 0) <= mark.revision)
      this.store.put("presentation:jobs", {
        class: "presentation",
        value: { runningCount: reply.runningCount },
      });
    return true;
  }

  /**
   * C3.3/C3.4: a backward journal page, validated against the identity and the
   * branch it was requested on, joined to the held tail by entry id. Entries
   * that arrived as appends after the page's horizon stay after it.
   */
  applyJournalPage(
    page: {
      readonly sessionId: string;
      readonly entries: readonly unknown[];
      readonly nextCursor?: string;
    },
    mark: NeoPiNativeRequestMark,
  ): boolean {
    if (!this.#acceptsReply(mark) || page.sessionId !== this.#identity?.sessionId) return false;
    const entries = page.entries.flatMap((raw) => {
      const entry = observeNeoPiJournalEntry(raw);
      return entry ? [entry] : [];
    });
    const oldHead = this.journal.head?.id;
    const pageIds = new Set(entries.map((entry) => entry.id));
    const later: NeoPiNativeObservedJournalEntry[] = [];
    let joined = entries.length === 0;
    for (let position = this.journal.start; position < this.journal.end; position++) {
      const entry = this.journal.at(position)!;
      if (pageIds.has(entry.id)) {
        joined = true;
        later.length = 0;
      } else later.push(entry);
    }
    const pageLast = entries[entries.length - 1];
    // History follows parent identity (C3.4): held entries after the page
    // continue it only if they descend from its last entry.
    const continues = later.length > 0 && later[0]!.parentId === pageLast?.id;
    const heldIsCurrent = oldHead === this.#identity?.leafId;
    // An empty page was read before the held entries existed: it joins them.
    if (later.length > 0 && !continues && heldIsCurrent && (!joined || entries.length === 0)) {
      // The page ends before the held, current tail and does not reach it (the
      // ring turned over while the page was in flight, or the page was read
      // before these entries were committed). Newer state is kept; the range
      // between stays a placeholder (C3.3, C3.4).
      this.#horizonCursor = null;
      for (const entry of entries) this.#joinEntry(entry);
      this.#pageApplied = true;
      return true;
    }
    this.journal.reset();
    for (const entry of entries) this.journal.append(entry);
    if (continues) for (const entry of later) this.journal.append(entry);
    this.#horizonCursor =
      page.nextCursor !== undefined && entries[0]
        ? { firstEntryId: entries[0].id, cursor: page.nextCursor }
        : null;
    for (const entry of entries) this.#joinEntry(entry);
    // After a rebuild, entries newer than the head held before the gap (all of
    // them when none was held) were committed while observation was lost.
    if (this.#rebuilt)
      this.#joinAcrossGap(
        entries.slice(
          oldHead === undefined ? 0 : entries.findIndex((entry) => entry.id === oldHead) + 1,
        ),
      );
    this.#pageApplied = true;
    return true;
  }

  /** The leaf a pending announcement named, while it waits for its entry. */
  get pendingLeafId(): string | null {
    return this.#pendingLeaf?.leafId ?? null;
  }

  /**
   * Decides a leaf that stayed pending by parent identity, from the owner's
   * leaf and a backward page fetched after the owner side's timeout (C3.4).
   * `append`: the page's entries extend the held head; they are appended
   * (entries already held are joined by id) and the leaf is resolved with no
   * fence. `navigated`: they do not; history is rebased on the page and one
   * fence is raised. `stale`: the mark is no longer current, or the pending
   * leaf is no longer `leafId`.
   */
  reconcilePendingLeaf(
    leafId: string,
    page: {
      readonly sessionId: string;
      readonly entries: readonly unknown[];
      readonly nextCursor?: string;
      /** The owner's leaf the page ends at. */
      readonly leafId?: string | null;
    },
    mark: NeoPiNativeRequestMark,
  ): "append" | "navigated" | "stale" {
    const pending = this.#pendingLeaf;
    if (
      !this.#acceptsReply(mark) ||
      pending?.leafId !== leafId ||
      page.sessionId !== this.#identity?.sessionId
    )
      return "stale";
    const entries = page.entries.flatMap((raw) => {
      const entry = observeNeoPiJournalEntry(raw);
      return entry ? [entry] : [];
    });
    // An owner whose page neither ends at nor contains the pending leaf has
    // moved again since; the caller retries.
    if (
      page.leafId !== undefined &&
      page.leafId !== leafId &&
      !entries.some((entry) => entry.id === leafId)
    )
      return "stale";
    const pageHead = page.leafId !== undefined ? page.leafId : (entries.at(-1)?.id ?? null);
    const head = this.journal.head?.id;
    const at = head === undefined ? -1 : entries.findIndex((entry) => entry.id === head);
    // By ancestry: the page's head held in the tail means the held head
    // descends from it (entries folded live while the page was in flight are
    // kept); the held head inside the page means the page extends it.
    const pageHeadHeld = pageHead !== null && this.journal.positionOf(pageHead) >= 0;
    if (head === undefined || at >= 0 || pageHeadHeld) {
      this.#pendingLeaf = null;
      if (head === undefined || at >= 0)
        for (const entry of entries.slice(at + 1))
          this.#fold({ type: "journal_entry", sessionId: page.sessionId, entry });
      return "append";
    }
    this.#pendingLeaf = null;
    this.journal.reset();
    this.#heldEntries.clear();
    for (const entry of entries) this.journal.append(entry);
    this.#horizonCursor =
      page.nextCursor !== undefined && entries[0]
        ? { firstEntryId: entries[0].id, cursor: page.nextCursor }
        : null;
    this.#navigate(pending);
    for (const entry of entries) this.#joinEntry(entry);
    // The fetched page is the new branch's horizon page.
    this.#pageApplied = true;
    this.#onFence?.("navigated");
    return "navigated";
  }

  /**
   * C2 invariant 2 across an observation gap, for `gapEntries`: page entries
   * newer than the head held before the gap. A message that had ended
   * unassociated before the gap, that this attempt's snapshot does not
   * associate (it carries only the newest 256), and for which the gap holds an
   * unassociated entry of its role, can never be joined: it becomes a typed
   * continuity loss (C5, a tombstone without a join) rather than showing beside
   * that entry or holding history back. One with no such entry is still
   * waiting for durability and is kept. Gap entries that a live message ended
   * since the gap could still claim are held as on the live path.
   */
  #joinAcrossGap(gapEntries: readonly NeoPiNativeObservedJournalEntry[]): void {
    const snapshot = this.#snapshotOf;
    if (
      snapshot?.incarnation === this.#domain.projectionIncarnation &&
      snapshot.attempt === this.#domain.buildAttempt
    ) {
      const unassociatedRoles = new Set(
        gapEntries
          .filter((entry) => !this.store.retiredBy(entry.id))
          .map((entry) => entry.message?.role),
      );
      for (const messageId of this.#endedBeforeGap) {
        const value = this.store.get(messageKey(messageId))?.value;
        if (value?.class !== "message" || value.phase !== "ended") continue;
        if (!unassociatedRoles.has(value.message.role)) continue;
        this.store.remove(messageKey(messageId));
        this.#resolveCandidate(messageId);
      }
      this.#endedBeforeGap = new Set();
      this.#rebuilt = false;
    }
    for (const entry of gapEntries) this.#holdIfUnassociated(entry);
  }

  #acceptsReply(mark: NeoPiNativeRequestMark): boolean {
    return (
      mark.projectionIncarnation === this.#domain.projectionIncarnation &&
      mark.buildAttempt === this.#domain.buildAttempt &&
      mark.branchGeneration === this.#domain.branchGeneration
    );
  }

  #sameSession(frame: NativeRecord): boolean {
    return (
      this.#identity === null ||
      frame.sessionId === undefined ||
      frame.sessionId === this.#identity.sessionId
    );
  }

  #journalState(frame: NativeRecord): NeoPiNativeFence {
    const sessionId = text(frame.sessionId);
    const sessionFile = typeof frame.sessionFile === "string" ? frame.sessionFile : null;
    const leafId = typeof frame.leafId === "string" ? frame.leafId : null;
    if (sessionId === undefined) return "none";
    const held = this.#identity;
    if (held && (held.sessionId !== sessionId || held.sessionFile !== sessionFile)) {
      // C1 identity row: "a change fences all older state".
      this.store.clear();
      this.journal.reset();
      this.#inbox = [];
      this.#inboxMeta = [];
      this.#inboxBytes = 0;
      this.#pendingJoins.clear();
      this.#rosterLive.clear();
      this.#heldEntries.clear();
      this.#settledJobs = [];
      this.#lastMessageId = null;
      this.#replyMarks = { state: -1, inventory: -1, history: -1, jobs: -1 };
      // The previous session's pending interactions are fenced with it.
      for (const id of this.#obligations.keys()) this.settleObligation(id, "cancelled");
      this.#pendingLeaf = null;
      this.#horizonCursor = null;
      this.#stateApplied = false;
      this.#pageApplied = false;
      this.#rosterApplied = false;
      this.#historyApplied = false;
      this.#domain = {
        ...this.#domain,
        projectionIncarnation: this.#domain.projectionIncarnation + 1,
        buildAttempt: 0,
        branchGeneration: 0,
      };
      this.#setIdentity({ sessionId, sessionFile, leafId });
      return "identity-changed";
    }
    if (frame.reason === "snapshot") {
      this.#snapshotOf = {
        incarnation: this.#domain.projectionIncarnation,
        attempt: this.#domain.buildAttempt,
      };
      if (Array.isArray(frame.messageEntryIds))
        for (const pair of frame.messageEntryIds) {
          const association = asRecord(pair);
          if (typeof association?.messageId === "string" && typeof association.entryId === "string")
            this.#alias(association.messageId, association.entryId);
        }
      // The current leaf; the page that follows is joined against it.
      if (held && held.leafId !== leafId) this.#identity = { ...held, leafId };
    }
    if (!held) {
      this.#setIdentity({ sessionId, sessionFile, leafId });
      return "none";
    }
    // NeoPi announces the new leaf before the `journal_entry` that appends it
    // (`session-journal-events.ts` `committed`: `state()` then the entry), so
    // a leaf the tail does not hold is decided by the next frame. A leaf in
    // the tail other than the head, or no leaf, is navigation.
    if (frame.reason !== "leaf") return "none";
    const head = this.journal.head?.id ?? held.leafId;
    if (leafId === head) return "none";
    const position = leafId === null ? -1 : this.journal.positionOf(leafId);
    if (position >= 0) this.journal.truncateAfter(position);
    else if (leafId !== null) {
      this.#pendingLeaf = { sessionId, sessionFile, leafId };
      return "none";
    } else this.journal.reset();
    this.#releaseHeldFrom(position + 1);
    this.#navigate({ sessionId, sessionFile, leafId });
    return "navigated";
  }

  #journalEntry(frame: NativeRecord): NeoPiNativeFence {
    if (!this.#sameSession(frame)) return "none";
    const entry = observeNeoPiJournalEntry(frame.entry);
    if (!entry || this.journal.positionOf(entry.id) >= 0) return "none";
    const head = this.journal.head?.id;
    // C3.4: "Append = a journal_entry whose parent is the current head";
    // anything else is a navigation and rebases history.
    const navigated = head !== undefined && entry.parentId !== head;
    if (navigated) {
      const parent = entry.parentId === null ? -1 : this.journal.positionOf(entry.parentId);
      if (parent >= 0) this.journal.truncateAfter(parent);
      else this.journal.reset();
    }
    this.journal.append(entry);
    // A hold never outlives its entry's place in the ring.
    this.#releaseHeldFrom(this.journal.end);
    if (navigated && this.#identity) this.#navigate({ ...this.#identity, leafId: entry.id });
    else if (this.#identity) this.#identity = { ...this.#identity, leafId: entry.id };
    this.#joinEntry(entry);
    this.#holdIfUnassociated(entry);
    return navigated ? "navigated" : "none";
  }

  /**
   * C2 invariant 2: a message entry and its live copy join only once
   * `message_persisted` names them, which NeoPi sends after the entry. Until
   * then the entry is held from readers if a live message of its role has
   * ended without one. Every hold ends, at the latest when the run ends: on the
   * entry's own association (to any message, held or not); when every
   * candidate is associated elsewhere or retired; when this or a later entry
   * is associated or joined (NeoPi persists in order, so this entry's alias
   * would have come first); when persistence fails; when the entry leaves the
   * ring; on navigation or identity change; or at `agent_end` /
   * `session_settled`, after which a late alias still retires the live row.
   */
  #holdIfUnassociated(entry: NeoPiNativeObservedJournalEntry): void {
    const role = entry.message?.role;
    if (role === undefined || this.store.retiredBy(entry.id)) return;
    const candidates = new Set<string>();
    for (const record of this.store.values()) {
      const value = record.value;
      if (value?.class === "message" && value.phase === "ended" && value.message.role === role)
        candidates.add(value.messageId);
    }
    if (candidates.size > 0) this.#heldEntries.set(entry.id, candidates);
  }

  /** Releases held entries at journal positions ≥ `position` or no longer in the tail. */
  #releaseHeldFrom(position: number): void {
    for (const entryId of this.#heldEntries.keys()) {
      const at = this.journal.positionOf(entryId);
      if (at < 0 || at >= position) this.#heldEntries.delete(entryId);
    }
  }

  #releaseHeldBefore(position: number): void {
    for (const entryId of this.#heldEntries.keys()) {
      const at = this.journal.positionOf(entryId);
      if (at < position) this.#heldEntries.delete(entryId);
    }
  }

  /** A live message is now associated (or gone): it is no candidate for any other held entry. */
  #resolveCandidate(messageId: string): void {
    for (const [entryId, candidates] of this.#heldEntries) {
      candidates.delete(messageId);
      if (candidates.size === 0) this.#heldEntries.delete(entryId);
    }
  }

  /** C3.5: navigation restarts the build, so reads say `building` until its page publishes. */
  #navigate(identity: NeoPiNativeIdentity): void {
    this.#domain = { ...this.#domain, branchGeneration: this.#domain.branchGeneration + 1 };
    this.#horizonCursor = null;
    this.#pageApplied = false;
    this.#setIdentity(identity);
  }

  #setIdentity(identity: NeoPiNativeIdentity): void {
    this.#identity = identity;
    const revision = this.store.bump();
    if (identity.sessionFile !== null)
      this.#onEssential?.({
        type: "identity",
        revision,
        domain: this.#domain,
        sessionId: identity.sessionId,
        sessionFile: identity.sessionFile,
        leafId: identity.leafId,
      });
  }

  /** A joined durable entry retires the live record it replaces, with that entry as the join. */
  #joinEntry(entry: NeoPiNativeObservedJournalEntry): void {
    const messageId = this.#pendingJoins.get(entry.id);
    if (messageId !== undefined) {
      this.#pendingJoins.delete(entry.id);
      this.#retire(messageKey(messageId), entry.id);
    }
    const message = entry.message;
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      this.store.remove(toolKey(message.toolCallId), entry.id);
      this.store.remove(editPreviewKey(message.toolCallId), entry.id);
    }
  }

  #retire(key: string, entryId: string): void {
    const value = this.store.get(key)?.value;
    if (!this.store.remove(key, entryId)) return;
    if (value?.class === "message") this.#resolveCandidate(value.messageId);
    this.#heldEntries.delete(entryId);
    const position = this.journal.positionOf(entryId);
    if (position >= 0) this.#releaseHeldBefore(position);
  }

  /**
   * C1 messages row: "an ended message never regresses; the final body stays
   * until its identified durable entry is joined (a known alias alone does not
   * retire it)". An alias marks the message durable; only the entry with that
   * id in the journal retires it.
   */
  #alias(messageId: string, entryId: string): void {
    // This entry, and every earlier one, now has its association settled.
    const position = this.journal.positionOf(entryId);
    if (position >= 0) this.#releaseHeldBefore(position + 1);
    const key = messageKey(messageId);
    const held = this.store.get(key)?.value;
    if (held?.class !== "message" || (held.phase === "durable" && held.entryId === entryId)) return;
    this.store.put(key, { ...held, phase: "durable", entryId });
    this.#resolveCandidate(messageId);
    if (position >= 0) this.#retire(key, entryId);
    else this.#pendingJoins.set(entryId, messageId);
  }

  #message(type: "message_start" | "message_update" | "message_end", frame: NativeRecord): void {
    const messageId = text(frame.messageId);
    const native = asRecord(frame.message);
    if (messageId === undefined || !native) return;
    const key = messageKey(messageId);
    const record = this.store.get(key);
    const held = record?.value;
    // The snapshot message (`snapshot: true`) is merged like any start (C3.2):
    // anything already ended, durable or joined (`joinEntryId`) is kept.
    if (
      (held?.class === "message" && held.phase !== "open") ||
      record?.joinEntryId ||
      this.store.wasRetired(key)
    )
      return;
    const { message, stopOutcome } = observeNeoPiMessage(native);
    this.#lastMessageId = messageId;
    const value: MessageValue = {
      class: "message",
      messageId,
      phase: type === "message_end" ? "ended" : "open",
      entryId: null,
      message,
      ...(stopOutcome === undefined ? {} : { stopOutcome }),
    };
    this.store.put(key, value);
  }

  /**
   * C1 tools row: "a terminal or background-final update is kept as the tool's
   * outcome until a durable result is joined". An update after the end is kept
   * beside the result, never in place of it. A tool whose start was not seen
   * has unknown coverage (C3.6).
   */
  #tool(
    type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end",
    frame: NativeRecord,
  ): void {
    const toolCallId = text(frame.toolCallId);
    if (toolCallId === undefined) return;
    const key = toolKey(toolCallId);
    const record = this.store.get(key);
    if (record?.joinEntryId || this.store.wasRetired(key)) return;
    const held = record?.value;
    const previous = held?.class === "tool" ? held : undefined;
    const ended = previous?.state.status === "ended";
    if (type === "tool_execution_start" && previous) return;
    const state: NativeRecord = {
      ...previous?.state,
      toolName: frame.toolName ?? previous?.state.toolName,
    };
    if (type === "tool_execution_start") {
      state.status = "running";
      if ("args" in frame) state.args = frame.args;
      if ("intent" in frame) state.intent = frame.intent;
    } else if (type === "tool_execution_update") {
      state.status = ended ? "ended" : "running";
      if ("args" in frame && !ended) state.args = frame.args;
      if ("partialResult" in frame) state.partialResult = frame.partialResult;
    } else {
      state.status = "ended";
      if ("result" in frame) state.result = frame.result;
      state.isError = frame.isError === true;
    }
    this.store.put(key, {
      class: "tool",
      toolCallId,
      coverage: previous?.coverage ?? (type === "tool_execution_start" ? "since-build" : "unknown"),
      state,
    });
  }

  /**
   * r12 §2.11 rule 2: "The projection keeps the latest preview per tool call
   * ... Intermediate tentative diffs may be skipped". Only the built-in `edit`
   * tool qualifies. Rule 3: any other argument stream, or an edit preview of a
   * shape this reducer does not know, keeps every update in order.
   */
  #toolStream(frame: NativeRecord): void {
    const toolCallId = text(frame.toolCallId);
    const toolName = text(frame.toolName);
    if (toolCallId === undefined || toolName === undefined) return;
    const preview = toolName === "edit" ? editPreview(toolCallId, frame.update) : undefined;
    if (!preview) {
      this.#pushInbox({
        type: "tool_stream_update",
        seq: this.#inboxSeq + 1,
        toolCallId,
        toolName,
        ...("update" in frame ? { update: frame.update } : {}),
      });
      return;
    }
    const key = editPreviewKey(toolCallId);
    const record = this.store.get(key);
    if (record?.joinEntryId || this.store.wasRetired(key)) return;
    const held = record?.value;
    if (held?.class === "editPreview") {
      if (preview.generation < held.generation) return;
      // The final preview carries the final error; a late tentative one never replaces it.
      if (!held.streaming && preview.streaming) return;
    }
    this.store.put(key, preview);
  }

  #notice(frame: NativeRecord): void {
    const level = text(frame.level);
    const message = text(frame.message);
    if (level === undefined || message === undefined) return;
    const source = text(frame.source);
    this.#pushInbox({
      type: "notice",
      seq: this.#inboxSeq + 1,
      level,
      message,
      ...(source === undefined ? {} : { source }),
    });
    // C3.6: "A reported persistence failure ends the wait for a durable entry
    // and becomes a visible fault that keeps the final body." Ended messages
    // keep their body by construction; the fault makes the failure visible.
    if (level === "error" && source === "session-persistence") {
      this.store.put(`fault:${source}`, { class: "fault", value: { source, level, message } });
      // No alias will come for a held entry; show both copies rather than stall history.
      this.#heldEntries.clear();
    }
  }

  /**
   * Appends one live-only record and enforces the hard bound (decision 8 (c)):
   * the oldest records are evicted into a gap at the head of the inbox. While
   * the inbox is unobserved (amendment to 8 (a)) the record is dropped into a
   * `not-observed` gap at once. Only inbox records are ever dropped.
   */
  #pushInbox(record: InboxItem): void {
    const bytes = encodedSize(record);
    const meta = { bytes, receivedAt: this.#now() };
    this.#inboxSeq = record.seq;
    this.#inbox.push(record);
    this.#inboxMeta.push(meta);
    this.#inboxBytes += bytes;
    if (!this.#inboxObserved) this.#dropAt(this.#inbox.length - 1, "not-observed");
    const limits = this.#inboxLimits;
    while (this.#inbox.length > limits.records || this.#inboxBytes > limits.bytes) {
      // Evict the oldest payload into a gap of its own reason; gaps of
      // different reasons stay apart. Only when gaps alone exceed the bound do
      // the two oldest merge; across reasons the merged gap is `mixed`.
      const oldest = this.#inbox.findIndex((item) => item.type !== "gap");
      if (oldest >= 0) this.#dropAt(oldest, "evicted");
      else if (this.#inbox.length > 1) this.#mergeInto(0, 1, "mixed");
      else break;
    }
  }

  /**
   * Decision 8 (a) with its amendment: while no view holds a lease nothing is
   * retained. B5 calls this with `false` when the last lease is released (every
   * payload held is dropped into a `not-observed` gap) and `true` when one is
   * taken.
   */
  setInboxObserved(observed: boolean): void {
    this.#inboxObserved = observed;
    if (observed) return;
    for (let index = 0; index < this.#inbox.length;) {
      if (this.#inbox[index]!.type === "gap") {
        index++;
        continue;
      }
      const length = this.#inbox.length;
      this.#dropAt(index, "not-observed");
      // Merged into the gap before it: the next item now sits at `index`.
      if (this.#inbox.length === length) index++;
    }
  }

  /**
   * Replaces the record at `index` with a gap of `reason`, merged into a gap
   * of the same reason just before it.
   */
  #dropAt(index: number, reason: InboxGap["reason"]): void {
    const record = this.#inbox[index]!;
    const meta = this.#inboxMeta[index]!;
    const gap = gapOf(record, meta.receivedAt, reason);
    this.#replace(index, 1, gap, meta.receivedAt);
    const previous = this.#inbox[index - 1];
    if (previous?.type === "gap" && previous.reason === reason)
      this.#mergeInto(index - 1, index, reason);
  }

  /** Merges the item at `later` (= `earlier + 1`) into the gap at `earlier`. */
  #mergeInto(earlier: number, later: number, reason: InboxGap["reason"]): void {
    const gap = this.#inbox[earlier] as InboxGap;
    const next = this.#inbox[later]!;
    const nextMeta = this.#inboxMeta[later]!;
    const absorbed = next.type === "gap" ? next : gapOf(next, nextMeta.receivedAt, reason);
    const toolStreams = [...gap.toolStreams];
    let truncated = gap.toolStreamsTruncated || absorbed.toolStreamsTruncated;
    for (const stream of absorbed.toolStreams) {
      const at = toolStreams.findIndex((held) => held.toolCallId === stream.toolCallId);
      if (at >= 0)
        toolStreams[at] = {
          ...toolStreams[at]!,
          updates: toolStreams[at]!.updates + stream.updates,
        };
      else if (toolStreams.length < GAP_TOOL_CALLS) toolStreams.push(stream);
      else truncated = true;
    }
    const merged: InboxGap = {
      type: "gap",
      seq: absorbed.toSeq,
      // Across reasons the cause is no longer known for the whole interval.
      reason: gap.reason === absorbed.reason ? gap.reason : "mixed",
      fromSeq: gap.fromSeq,
      toSeq: absorbed.toSeq,
      firstReceivedAt: gap.firstReceivedAt,
      lastReceivedAt: absorbed.lastReceivedAt,
      notices: gap.notices + absorbed.notices,
      toolStreams,
      toolStreamsTruncated: truncated,
    };
    this.#replace(earlier, 2, merged, nextMeta.receivedAt);
  }

  #replace(index: number, count: number, gap: InboxGap, receivedAt: number): void {
    const bytes = encodedSize(gap);
    let freed = 0;
    for (let offset = 0; offset < count; offset++) freed += this.#inboxMeta[index + offset]!.bytes;
    this.#inbox.splice(index, count, gap);
    this.#inboxMeta.splice(index, count, { bytes, receivedAt });
    this.#inboxBytes += bytes - freed;
  }

  /**
   * Prunes records every live reader has passed (decision 8 (b)). B5 calls this
   * with the minimum `inboxSeq` over live lease cursors; a gap wholly at or
   * below it goes too.
   */
  pruneInbox(throughSeq: number): void {
    let count = 0;
    let freed = 0;
    while (count < this.#inbox.length && this.#inbox[count]!.seq <= throughSeq) {
      freed += this.#inboxMeta[count]!.bytes;
      count++;
    }
    if (count === 0) return;
    this.#inbox.splice(0, count);
    this.#inboxMeta.splice(0, count);
    this.#inboxBytes -= freed;
  }

  /**
   * The run is over: no hold waits past it, and an edit preview whose call
   * never ran (aborted after its final preview) is dropped; its diagnostic and
   * recovery are their own records (§2.11 rule 2).
   */
  #runEnded(): void {
    this.#heldEntries.clear();
    const orphans: string[] = [];
    for (const record of this.store.values())
      if (
        record.value?.class === "editPreview" &&
        this.store.get(toolKey(record.value.toolCallId))?.value?.class !== "tool"
      )
        orphans.push(record.key);
    for (const key of orphans) this.store.remove(key);
  }

  #run(type: string, frame: NativeRecord): void {
    const held = this.store.get(RUN_KEY)?.value;
    const run: NativeRecord = { ...(held?.class === "run" ? held.value : {}) };
    const owners = new Set(strings(run.owners));
    const named = strings(frame.owners);
    switch (type) {
      case "agent_start":
        run.active = true;
        owners.clear();
        for (const owner of strings(frame.runOwners)) owners.add(owner);
        break;
      case "agent_end":
        run.active = false;
        run.turnActive = false;
        owners.clear();
        break;
      case "turn_start":
        run.turnActive = true;
        break;
      case "turn_end":
        run.turnActive = false;
        break;
      case "run_owners_joined":
        for (const owner of named) owners.add(owner);
        break;
      case "run_owners_skipped":
        run.skipped = { owners: named, reason: frame.reason ?? null };
        break;
    }
    run.owners = [...owners];
    this.store.put(RUN_KEY, { class: "run", value: run });
  }

  /**
   * One roster entity per child, key `roster:<id>`, value `{id, runToken,
   * lifecycle?, progress?, inventory?, history?, ticks}`. A lifecycle start
   * with a new run token is a new activation and replaces the live part.
   * Progress never revives a finished activation.
   */
  #roster(type: "subagent_lifecycle" | "subagent_progress", frame: NativeRecord): void {
    const payload = asRecord(frame.payload);
    const runToken = text(payload?.runToken);
    const id = text(type === "subagent_lifecycle" ? payload?.id : asRecord(payload?.progress)?.id);
    if (!payload || runToken === undefined || id === undefined) return;
    const key = `roster:${id}`;
    const held = this.store.get(key)?.value;
    const previous = held?.class === "roster" ? held.value : undefined;
    const sameRun = previous?.runToken === runToken;
    const entry: NativeRecord = sameRun
      ? { ...previous }
      : {
          ...previous,
          id,
          runToken,
          lifecycle: undefined,
          progress: undefined,
          unobserved: undefined,
          ticks: 0,
        };
    if (type === "subagent_lifecycle") {
      if (!sameRun && payload.status !== "started" && previous?.runToken !== undefined) return;
      entry.lifecycle = payload;
    } else {
      if (!sameRun && previous?.runToken !== undefined) return;
      const status = text(asRecord(entry.lifecycle)?.status);
      if (status !== undefined && TERMINAL_CHILD_STATUSES.has(status)) return;
      entry.progress = payload;
    }
    for (const field of ["lifecycle", "progress", "unobserved"] as const)
      if (entry[field] === undefined) delete entry[field];
    this.#rosterLive.set(id, this.store.put(key, { class: "roster", value: entry }));
  }

  /** A settled step of a child (`subagent_event` at the `events` level): a re-read trigger, not content. */
  #rosterTick(frame: NativeRecord): void {
    const payload = asRecord(frame.payload);
    const id = text(payload?.id);
    const eventType = asRecord(payload?.event)?.type;
    if (id === undefined || !SETTLED_CHILD_EVENTS.has(String(eventType))) return;
    const key = `roster:${id}`;
    const held = this.store.get(key)?.value;
    const entry: NativeRecord = held?.class === "roster" ? { ...held.value } : { id };
    entry.ticks = (typeof entry.ticks === "number" ? entry.ticks : 0) + 1;
    // A tick is a re-read trigger, not roster state: replies still apply.
    this.store.put(key, { class: "roster", value: entry });
  }

  #rosterRow(
    id: string,
    mark: NeoPiNativeRequestMark,
    update: (entry: NativeRecord) => void,
  ): void {
    const key = `roster:${id}`;
    const record = this.store.get(key);
    if ((this.#rosterLive.get(id) ?? 0) > mark.revision) return;
    const entry: NativeRecord =
      record?.value?.class === "roster" ? { ...record.value.value } : { id, ticks: 0 };
    update(entry);
    this.store.put(key, { class: "roster", value: entry });
  }

  /**
   * `job_lifecycle` `{event, job, runningCount}`: a settled job is final; only
   * a fresh registration reopens its id. A frame whose job update is refused
   * is stale, and so is its running count.
   */
  #job(frame: NativeRecord): void {
    const job = asRecord(frame.job);
    const id = text(job?.id);
    if (job && id !== undefined) {
      const held = this.store.get(`job:${id}`)?.value;
      const previous = held?.class === "presentation" ? asRecord(held.value.job) : undefined;
      const reopens = previous && previous.status !== "running" && job.status === "running";
      if (reopens && frame.event !== "registered") return;
      this.#putJob(id, job);
    }
    if (typeof frame.runningCount === "number")
      this.store.put("presentation:jobs", {
        class: "presentation",
        value: { runningCount: frame.runningCount },
      });
  }

  /** Settled jobs are kept up to a bound, oldest leaving by tombstone. */
  #putJob(id: string, job: NativeRecord): void {
    const key = `job:${id}`;
    this.store.put(key, { class: "presentation", value: { job } });
    this.#settledJobs = this.#settledJobs.filter((held) => held !== key);
    if (job.status === "running") return;
    this.#settledJobs.push(key);
    while (this.#settledJobs.length > SETTLED_JOBS) this.store.remove(this.#settledJobs.shift()!);
  }

  /**
   * `command_output`, in arrival order, anchored after the last delivered
   * journal entry and the newest live message at arrival (C1 informational
   * receipt; its durable re-read is N11a, a later stage). The newest
   * `COMMAND_OUTPUTS` are kept.
   */
  #commandOutput(frame: NativeRecord): void {
    if (typeof frame.text !== "string" || frame.text === "") return;
    const afterEntry = this.journal.at(this.deliverableJournalEnd - 1);
    this.store.put(`receipt:command:${this.#commandOutputs++}`, {
      class: "receipt",
      value: {
        kind: "command_output",
        text: frame.text,
        afterEntryId: afterEntry?.id ?? null,
        afterMessageId: this.#lastMessageId,
      },
    });
    if (this.#commandOutputs > COMMAND_OUTPUTS)
      this.store.remove(`receipt:command:${this.#commandOutputs - 1 - COMMAND_OUTPUTS}`);
  }

  /**
   * One native microphone capture, key `presentation:dictation`. NeoPi runs one
   * capture at a time and opens it with a state frame; any other frame for a
   * different or ended capture is a straggler.
   */
  #dictation(frame: NativeRecord): void {
    const captureId = text(frame.captureId);
    if (captureId === undefined) return;
    const held = this.store.get("presentation:dictation")?.value;
    const current = held?.class === "presentation" ? held.value : undefined;
    const same = current?.captureId === captureId;
    if (same && current?.phase === "ended") return;
    let next: NativeRecord | undefined;
    if (frame.type === "dictation_state" && DICTATION_PHASES.has(String(frame.state)))
      next = { captureId, phase: frame.state, text: same ? current?.text : "", error: null };
    else if (current !== undefined && !same) return;
    else if (frame.type === "dictation_transcript" && typeof frame.text === "string")
      next = { captureId, phase: current?.phase ?? "recording", text: frame.text, error: null };
    else if (frame.type === "dictation_end")
      next = {
        captureId,
        phase: "ended",
        text: typeof frame.text === "string" ? frame.text : "",
        error: typeof frame.error === "string" && frame.error ? frame.error : null,
      };
    if (next) this.store.put("presentation:dictation", { class: "presentation", value: next });
  }

  #uiRequest(frame: NativeRecord): void {
    const id = text(frame.id);
    const method = text(frame.method);
    if (id === undefined || method === undefined) return;
    if (DIALOG_METHODS.has(method)) this.openObligation(id, frame as NeoPiNativeSessionCommand);
    else if (method === "cancel" && typeof frame.targetId === "string")
      this.settleObligation(frame.targetId, "cancelled");
    else if (method === "set_editor_text" && typeof frame.text === "string")
      this.store.put("presentation:editorText", {
        class: "presentation",
        value: { id, text: frame.text },
      });
    else if (method === "notify" && typeof frame.message === "string") {
      const { type: _type, id: _id, ...value } = frame;
      this.store.put("presentation:notify", { class: "presentation", value });
    } else if (method === "setStatus" || method === "setWidget" || method === "setTitle") {
      const name =
        method === "setStatus"
          ? text(frame.statusKey)
          : method === "setWidget"
            ? text(frame.widgetKey)
            : "";
      if (name === undefined) return;
      const { type: _type, id: _id, ...value } = frame;
      this.store.put(`presentation:${method}:${name}`, { class: "presentation", value });
    }
  }

  #setting(property: string, value: NativeRecord): void {
    this.store.put(`setting:${property}`, { class: "setting", value: { property, ...value } });
  }

  /** C1 operations row: "current op plus last terminal outcome kept until superseded". */
  #operation(kind: string, frame: NativeRecord, edge: "start" | "end"): void {
    const key = `operation:${kind}`;
    const held = this.store.get(key)?.value;
    const previous = held?.class === "operation" ? held.value : {};
    this.store.put(key, {
      class: "operation",
      value:
        edge === "start"
          ? { kind, current: frame, last: previous.last ?? null }
          : { kind, current: null, last: frame },
    });
  }
}

/** The built-in edit tool's preview, or undefined when the payload is not that shape. */
function editPreview(toolCallId: string, update: unknown): EditPreviewValue | undefined {
  const record = asRecord(update);
  const generation = record?.generation;
  if (
    !record ||
    typeof generation !== "number" ||
    !Number.isInteger(generation) ||
    generation < 0 ||
    typeof record.streaming !== "boolean" ||
    !Array.isArray(record.files)
  )
    return undefined;
  const files: NeoPiEditFilePreview[] = [];
  for (const raw of record.files) {
    const file = asRecord(raw);
    if (typeof file?.path !== "string") return undefined;
    files.push({
      path: file.path,
      ...(typeof file.diff === "string" ? { diff: file.diff } : {}),
      ...(typeof file.firstChangedLine === "number"
        ? { firstChangedLine: file.firstChangedLine }
        : {}),
      ...(typeof file.error === "string" ? { error: file.error } : {}),
      ...(typeof file.op === "string" ? { op: file.op } : {}),
      ...(typeof file.rename === "string" ? { rename: file.rename } : {}),
    });
  }
  return { class: "editPreview", toolCallId, generation, streaming: record.streaming, files };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Encoded UTF-8 size of a value's JSON. */
function encodedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** A one-record gap standing for `record`. */
function gapOf(
  record: NeoPiNativeInboxRecord,
  receivedAt: number,
  reason: InboxGap["reason"],
): InboxGap {
  if (record.type === "gap") return record;
  return {
    type: "gap",
    seq: record.seq,
    reason,
    fromSeq: record.seq,
    toSeq: record.seq,
    firstReceivedAt: receivedAt,
    lastReceivedAt: receivedAt,
    notices: record.type === "notice" ? 1 : 0,
    toolStreams:
      record.type === "tool_stream_update"
        ? [{ toolCallId: record.toolCallId, toolName: record.toolName, updates: 1 }]
        : [],
    toolStreamsTruncated: false,
  };
}
