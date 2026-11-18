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

/** One projection key. `value === null` is a tombstone; `removed` once its tombstone expired. */
export interface NeoPiNativeStoreRecord {
  readonly key: string;
  readonly ordinal: number;
  revision: number;
  value: NeoPiNativeEntityValue | null;
  /**
   * For a retired message or tool: the durable entry that replaced it. The
   * tombstone is sent only to a reader that already holds that entry.
   */
  joinEntryId: string | null;
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
  /** Tombstones in revision order; an entry is stale once its record changed. */
  #tombstones: Array<{ readonly record: NeoPiNativeStoreRecord; readonly revision: number }> = [];
  #tombstoneHead = 0;
  #tombstoneCount = 0;

  readonly tombstoneCapacity: number;

  constructor(tombstoneCapacity: number) {
    this.tombstoneCapacity = tombstoneCapacity;
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

  put(key: string, value: NeoPiNativeEntityValue): number {
    const revision = ++this.#revision;
    const existing = this.#byKey.get(key);
    if (existing) {
      if (existing.value === null) this.#tombstoneCount--;
      existing.value = value;
      existing.revision = revision;
      existing.joinEntryId = null;
      return revision;
    }
    const record: NeoPiNativeStoreRecord = {
      key,
      ordinal: this.#nextOrdinal++,
      revision,
      value,
      joinEntryId: null,
      removed: false,
    };
    this.#byKey.set(key, record);
    this.#order.push(record);
    return revision;
  }

  remove(key: string, joinEntryId: string | null = null): boolean {
    const record = this.#byKey.get(key);
    if (!record || record.value === null) return false;
    record.value = null;
    record.revision = ++this.#revision;
    record.joinEntryId = joinEntryId;
    this.#tombstones.push({ record, revision: record.revision });
    this.#tombstoneCount++;
    this.#expire();
    return true;
  }

  /** Drops every key; the caller changes the identity domain, so no tombstone is owed. */
  clear(): void {
    this.#byKey.clear();
    this.#order = [];
    this.#removedInOrder = 0;
    this.#tombstones = [];
    this.#tombstoneHead = 0;
    this.#tombstoneCount = 0;
    this.#horizon = this.#revision;
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
    while (this.#tombstoneCount > this.tombstoneCapacity) {
      const entry = this.#tombstones[this.#tombstoneHead++];
      if (!entry) break;
      const { record, revision } = entry;
      if (record.removed || record.value !== null || record.revision !== revision) continue;
      record.removed = true;
      this.#byKey.delete(record.key);
      this.#removedInOrder++;
      this.#tombstoneCount--;
      if (revision > this.#horizon) this.#horizon = revision;
    }
    if (this.#tombstoneHead > 64 && this.#tombstoneHead * 2 > this.#tombstones.length) {
      this.#tombstones = this.#tombstones.slice(this.#tombstoneHead);
      this.#tombstoneHead = 0;
    }
    if (this.#removedInOrder > 64 && this.#removedInOrder * 2 > this.#order.length) {
      this.#order = this.#order.filter((record) => !record.removed);
      this.#removedInOrder = 0;
    }
  }
}

/** Recent journal entries by absolute position, joined by entry identity (C3.4). */
export class NeoPiNativeJournalTail {
  #entries: NeoPiNativeObservedJournalEntry[] = [];
  #offset = 0;
  #start = 0;
  readonly #positions = new Map<string, number>();

  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** Absolute position of the oldest retained entry. */
  get start(): number {
    return this.#start;
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
  }
}

export interface NeoPiNativeIdentity {
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly leafId: string | null;
}

/**
 * What a reply must have been requested under to be applied (C3.3): replies
 * from another projection incarnation or branch are rejected, and a key changed
 * after `revision` is not overwritten.
 */
export interface NeoPiNativeRequestMark {
  readonly revision: number;
  readonly projectionIncarnation: number;
  readonly branchGeneration: number;
}

/** Fences a fold can raise. `identity-changed` and `navigated` both restart a build (C3.5). */
export type NeoPiNativeFence = "none" | "identity-changed" | "navigated";

export interface NeoPiNativeProjectionOptions {
  readonly domain: NeoPiNativeObservationDomain;
  readonly tombstoneCapacity: number;
  readonly journalCapacity: number;
  /** Essential facts, synchronously, in revision order. */
  readonly onEssential?: (envelope: NeoPiNativeProjectionEnvelope) => void;
}

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

const messageKey = (messageId: string) => `message:${messageId}`;
const toolKey = (toolCallId: string) => `tool:${toolCallId}`;
const editPreviewKey = (toolCallId: string) => `editPreview:${toolCallId}`;
const RUN_KEY = "run";

type MessageValue = Extract<NeoPiNativeEntityValue, { class: "message" }>;
type ToolValue = Extract<NeoPiNativeEntityValue, { class: "tool" }>;
type EditPreviewValue = Extract<NeoPiNativeEntityValue, { class: "editPreview" }>;

export class NeoPiNativeProjection {
  readonly store: NeoPiNativeKeyedStore;
  readonly journal: NeoPiNativeJournalTail;
  #domain: NeoPiNativeObservationDomain;
  #identity: NeoPiNativeIdentity | null = null;
  #inbox: NeoPiNativeInboxRecord[] = [];
  #inboxSeq = 0;
  readonly #obligations = new Map<
    string,
    { readonly revision: number; readonly request: NeoPiNativeSessionCommand }
  >();
  /** Durable entry id → message id, for messages whose entry has not joined yet. */
  readonly #pendingJoins = new Map<string, string>();
  #stateApplied = false;
  #pageApplied = false;
  #horizonCursor: { readonly firstEntryId: string; readonly cursor: string } | null = null;
  readonly #onEssential: ((envelope: NeoPiNativeProjectionEnvelope) => void) | undefined;

  constructor(options: NeoPiNativeProjectionOptions) {
    this.store = new NeoPiNativeKeyedStore(options.tombstoneCapacity);
    this.journal = new NeoPiNativeJournalTail(options.journalCapacity);
    this.#domain = options.domain;
    this.#onEssential = options.onEssential;
  }

  get domain(): NeoPiNativeObservationDomain {
    return this.#domain;
  }

  get identity(): NeoPiNativeIdentity | null {
    return this.#identity;
  }

  /** C3.4: published once live state and one validated horizon page exist. */
  get published(): boolean {
    return this.#stateApplied && this.#pageApplied;
  }

  /** Live-only records without a reducer, in arrival order; `seq` is contiguous. */
  get inbox(): readonly NeoPiNativeInboxRecord[] {
    return this.#inbox;
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
      projectionIncarnation: this.#domain.projectionIncarnation,
      branchGeneration: this.#domain.branchGeneration,
    };
  }

  /**
   * A rebuild (new owner epoch or a replaced observation connection) starts a
   * new projection incarnation and keeps what is already held (C3.6: "A rebuild
   * inside one owner epoch keeps state the projection already holds and the
   * snapshot does not replace, in particular ended-but-not-durable messages and
   * tool outcomes"). A tool still running may have ended unseen, so its
   * coverage becomes unknown.
   */
  rebuild(ownerEpoch: number = this.#domain.ownerEpoch): void {
    this.#domain = {
      ...this.#domain,
      ownerEpoch,
      projectionIncarnation: this.#domain.projectionIncarnation + 1,
      buildAttempt: 0,
    };
    this.#stateApplied = false;
    this.#pageApplied = false;
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

  /** C3.1: attempts are numbered within one projection incarnation. */
  beginBuildAttempt(): NeoPiNativeObservationDomain {
    this.#domain = { ...this.#domain, buildAttempt: this.#domain.buildAttempt + 1 };
    return this.#domain;
  }

  fold(frame: NativeRecord): NeoPiNativeFence {
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
      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "run_owners_joined":
      case "run_owners_skipped":
        this.#run(type, frame);
        return "none";
      case "subagent_lifecycle":
      case "subagent_progress":
        this.#roster(type, frame);
        return "none";
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
      case "thinking_level_changed": {
        const { type: _type, ...value } = frame;
        this.#setting("thinkingLevel", { value });
        return "none";
      }
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
    this.#stateApplied = true;
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
    if (!joined && later[0]?.parentId !== pageLast?.id) later.length = 0;
    this.journal.reset();
    for (const entry of entries) this.journal.append(entry);
    for (const entry of later) this.journal.append(entry);
    this.#horizonCursor =
      page.nextCursor !== undefined && entries[0]
        ? { firstEntryId: entries[0].id, cursor: page.nextCursor }
        : null;
    for (const entry of entries) this.#joinEntry(entry);
    this.#pageApplied = true;
    return true;
  }

  #acceptsReply(mark: NeoPiNativeRequestMark): boolean {
    return (
      mark.projectionIncarnation === this.#domain.projectionIncarnation &&
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
      this.#pendingJoins.clear();
      this.#horizonCursor = null;
      this.#stateApplied = false;
      this.#pageApplied = false;
      this.#domain = {
        ...this.#domain,
        projectionIncarnation: this.#domain.projectionIncarnation + 1,
        buildAttempt: 0,
        branchGeneration: 0,
      };
      this.#setIdentity({ sessionId, sessionFile, leafId });
      return "identity-changed";
    }
    if (frame.reason === "snapshot" && Array.isArray(frame.messageEntryIds))
      for (const pair of frame.messageEntryIds) {
        const association = asRecord(pair);
        if (typeof association?.messageId === "string" && typeof association.entryId === "string")
          this.#alias(association.messageId, association.entryId);
      }
    if (!held) {
      this.#setIdentity({ sessionId, sessionFile, leafId });
      return "none";
    }
    // NeoPi announces the new leaf before the `journal_entry` that appends it,
    // so an unknown leaf is decided by that entry. A leaf already in the tail
    // other than the head is a move back to an existing entry: navigation.
    const head = this.journal.head?.id ?? null;
    const position = leafId === null ? -1 : this.journal.positionOf(leafId);
    if (leafId !== null && leafId !== head && position >= 0) {
      this.journal.truncateAfter(position);
      this.#navigate({ sessionId, sessionFile, leafId });
      return "navigated";
    }
    return "none";
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
    if (navigated && this.#identity) this.#navigate({ ...this.#identity, leafId: entry.id });
    else if (this.#identity) this.#identity = { ...this.#identity, leafId: entry.id };
    this.#joinEntry(entry);
    return navigated ? "navigated" : "none";
  }

  #navigate(identity: NeoPiNativeIdentity): void {
    this.#domain = { ...this.#domain, branchGeneration: this.#domain.branchGeneration + 1 };
    this.#horizonCursor = null;
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
      this.store.remove(messageKey(messageId), entry.id);
    }
    const message = entry.message;
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      this.store.remove(toolKey(message.toolCallId), entry.id);
      this.store.remove(editPreviewKey(message.toolCallId), entry.id);
    }
  }

  /**
   * C1 messages row: "an ended message never regresses; the final body stays
   * until its identified durable entry is joined (a known alias alone does not
   * retire it)". An alias marks the message durable; only the entry with that
   * id in the journal retires it.
   */
  #alias(messageId: string, entryId: string): void {
    const key = messageKey(messageId);
    const held = this.store.get(key)?.value;
    if (held?.class !== "message" || (held.phase === "durable" && held.entryId === entryId)) return;
    this.store.put(key, { ...held, phase: "durable", entryId });
    if (this.journal.positionOf(entryId) >= 0) this.store.remove(key, entryId);
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
    if ((held?.class === "message" && held.phase !== "open") || record?.joinEntryId) return;
    const { message, stopOutcome } = observeNeoPiMessage(native);
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
    if (record?.joinEntryId) return;
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
    if (record?.joinEntryId) return;
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
    if (level === "error" && source === "session-persistence")
      this.store.put(`fault:${source}`, { class: "fault", value: { source, level, message } });
  }

  #pushInbox(record: NeoPiNativeInboxRecord): void {
    this.#inboxSeq = record.seq;
    this.#inbox.push(record);
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

  /** Roster key is child id + run token (C1). Progress never revives a finished activation. */
  #roster(type: "subagent_lifecycle" | "subagent_progress", frame: NativeRecord): void {
    const payload = asRecord(frame.payload);
    const runToken = text(payload?.runToken);
    const id = text(type === "subagent_lifecycle" ? payload?.id : asRecord(payload?.progress)?.id);
    if (!payload || runToken === undefined || id === undefined) return;
    const key = `roster:${id}:${runToken}`;
    const held = this.store.get(key)?.value;
    const entry: NativeRecord = { id, runToken, ...(held?.class === "roster" ? held.value : {}) };
    if (type === "subagent_lifecycle") entry.lifecycle = payload;
    else {
      const status = text(asRecord(entry.lifecycle)?.status);
      if (status !== undefined && TERMINAL_CHILD_STATUSES.has(status)) return;
      entry.progress = payload;
    }
    this.store.put(key, { class: "roster", value: entry });
  }

  #uiRequest(frame: NativeRecord): void {
    const id = text(frame.id);
    const method = text(frame.method);
    if (id === undefined || method === undefined) return;
    if (DIALOG_METHODS.has(method)) this.openObligation(id, frame as NeoPiNativeSessionCommand);
    else if (method === "cancel" && typeof frame.targetId === "string")
      this.settleObligation(frame.targetId, "cancelled");
    else if (method === "setStatus" || method === "setWidget" || method === "setTitle") {
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
