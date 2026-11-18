import type { NeoPiJournalEntry, NeoPiJournalPage, NeoPiStopOutcome } from "@t3tools/contracts";

export interface NativeIdentity {
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly leafId: string | null;
}
export interface NativeLiveMessage {
  readonly messageId: string;
  readonly message: Readonly<Record<string, unknown>>;
  /** The typed outcome an observation read built from whitelisted fields; never raw `stopDetails`. */
  readonly stopOutcome?: NeoPiStopOutcome;
}
/**
 * A live row whose durable identity could not be established after a rebase.
 * It is never matched by text: the row leaves, and its content reads from
 * history after `afterEntryId`, the nearest durable entry.
 */
export interface NativeContinuityLoss {
  readonly messageId: string;
  readonly afterEntryId: string | null;
}
export interface NativeConversation {
  readonly identity: NativeIdentity | null;
  /**
   * Durable entries in branch order. Where an entry's parent is not the entry
   * before it, an unloaded range lies between them (`nativeConversationGaps`).
   */
  readonly entries: ReadonlyArray<NeoPiJournalEntry>;
  readonly pending: ReadonlyArray<NativeLiveMessage>;
  readonly persisted: ReadonlyMap<string, string>;
  readonly losses: ReadonlyArray<NativeContinuityLoss>;
  readonly cursor: string | undefined;
  readonly cursorLeaf: string | null;
  readonly revision: number;
  readonly needsSnapshot: boolean;
}
export const emptyNativeConversation = (): NativeConversation => ({
  identity: null,
  entries: [],
  pending: [],
  persisted: new Map(),
  losses: [],
  cursor: undefined,
  cursorLeaf: null,
  revision: 0,
  needsSnapshot: false,
});
export const sameNativeSession = (a: NativeIdentity | null, b: NativeIdentity) =>
  a !== null && a.sessionId === b.sessionId && a.sessionFile === b.sessionFile;
export const nativeIdentityKey = (identity: NativeIdentity) =>
  JSON.stringify([identity.sessionId, identity.sessionFile]);

export type NativeConversationAction =
  | { type: "disconnect" }
  | { type: "snapshot"; page: NeoPiJournalPage }
  /**
   * A fresh backward page ending at the current leaf, joined to loaded history
   * by entry id. `continuous`: the branch has only been appended to since the
   * loaded history was read, so an unjoined page leaves a gap, not a new branch.
   * Live rows are not touched: only the authority's membership retires them.
   */
  | {
      type: "horizon";
      identity: NativeIdentity;
      entries: ReadonlyArray<NeoPiJournalEntry>;
      nextCursor: string | undefined;
      continuous: boolean;
    }
  | { type: "older"; page: NeoPiJournalPage; revision: number }
  | { type: "identity"; identity: NativeIdentity }
  | { type: "entry"; identity: NativeIdentity; entry: NeoPiJournalEntry }
  | { type: "persisted"; identity: NativeIdentity; messageId: string; entryId: string }
  | {
      type: "persistence_snapshot";
      identity: NativeIdentity;
      messageEntryIds: ReadonlyArray<{ messageId: string; entryId: string }>;
    }
  | {
      type: "message";
      messageId: string;
      message: Readonly<Record<string, unknown>>;
      stopOutcome?: NeoPiStopOutcome;
    }
  /** These live rows cannot be identified with any durable entry: they become continuity losses. */
  | { type: "unresolved"; messageIds: ReadonlySet<string> }
  /**
   * Message ids of the previous owner are meaningless now. An identified row
   * keeps waiting for its entry under the key `durable:<entryId>`; any other
   * row is a continuity loss.
   */
  | { type: "owner_changed" }
  | { type: "turn_started" };

/**
 * A failed or interrupted assistant message. Its error belongs to the turn that
 * produced it, which lives in the journal from then on; a live copy of it must
 * not outlast that turn.
 */
const isFailedAssistantMessage = (message: Readonly<Record<string, unknown>>) =>
  message.role === "assistant" &&
  (message.stopReason === "error" || message.stopReason === "aborted");

function uniqueEntries(entries: ReadonlyArray<NeoPiJournalEntry>) {
  const seen = new Set<string>();
  return entries.filter((entry) => !seen.has(entry.id) && !!seen.add(entry.id));
}

/** Rows whose identified durable entry is present leave; nothing else retires a row. */
function retirePending(
  pending: ReadonlyArray<NativeLiveMessage>,
  persisted: ReadonlyMap<string, string>,
  entryIds: ReadonlySet<string>,
) {
  const kept = pending.filter((message) => !entryIds.has(persisted.get(message.messageId) ?? ""));
  return kept.length === pending.length ? pending : kept;
}

/** Turns the selected rows into continuity losses, anchored at their entry when it is loaded. */
function loseRows(
  state: NativeConversation,
  lost: (message: NativeLiveMessage) => boolean,
): NativeConversation {
  const loaded = new Set(state.entries.map((entry) => entry.id));
  const losses = state.pending.filter(lost).map((message) => {
    const entryId = state.persisted.get(message.messageId);
    return {
      messageId: message.messageId,
      afterEntryId:
        entryId !== undefined && loaded.has(entryId) ? entryId : (state.entries.at(-1)?.id ?? null),
    };
  });
  if (losses.length === 0) return state;
  const ids = new Set(losses.map((loss) => loss.messageId));
  return {
    ...state,
    pending: state.pending.filter((message) => !ids.has(message.messageId)),
    losses: [...state.losses.filter((loss) => !ids.has(loss.messageId)), ...losses],
  };
}

/**
 * Ids of entries preceded by an unloaded range: the placeholder that loads on
 * demand through `cursor`. The first entry is not one; older history is paging.
 */
export function nativeConversationGaps(conversation: NativeConversation): ReadonlySet<string> {
  const gaps = new Set<string>();
  conversation.entries.forEach((entry, index) => {
    if (index > 0 && entry.parentId !== conversation.entries[index - 1]!.id) gaps.add(entry.id);
  });
  return gaps;
}

/** Native parent pointers select the branch. No context reconstruction or SQL messages. */
export function reduceNativeConversation(
  state: NativeConversation,
  action: NativeConversationAction,
): NativeConversation {
  switch (action.type) {
    case "disconnect":
      // Live rows and their durable associations outlive the connection; only a
      // present durable entry or an unresolved rebase retires them.
      return { ...state, revision: state.revision + 1, needsSnapshot: true };
    case "snapshot": {
      const page = action.page;
      // A leaf notification can arrive before its branch snapshot. Compare with
      // the loaded history, not that newly announced leaf.
      const loadedLeaf = state.entries.at(-1)?.id;
      const extendsBranch =
        sameNativeSession(state.identity, page) &&
        loadedLeaf !== undefined &&
        page.entries.some((entry) => entry.id === loadedLeaf);
      const entries = uniqueEntries([...(extendsBranch ? state.entries : []), ...page.entries]);
      const ids = new Set(entries.map((entry) => entry.id));
      return {
        identity: page,
        entries,
        pending: extendsBranch
          ? state.pending.filter(
              (message) => !ids.has(state.persisted.get(message.messageId) ?? ""),
            )
          : [],
        persisted: sameNativeSession(state.identity, page) ? state.persisted : new Map(),
        losses: extendsBranch ? state.losses : [],
        cursor: page.nextCursor,
        cursorLeaf: page.leafId,
        revision: state.revision + 1,
        needsSnapshot: false,
      };
    }
    case "horizon": {
      const { identity, entries: page } = action;
      const same = sameNativeSession(state.identity, identity);
      const loaded = same ? state.entries : [];
      const held = new Map(loaded.map((entry, position) => [entry.id, position]));
      // The page is one contiguous run to the leaf: it replaces loaded history
      // from its oldest held entry on, filling any placeholder it covers.
      let keep = -1;
      for (const entry of page) {
        keep = held.get(entry.id) ?? -1;
        if (keep >= 0) break;
      }
      const parent = page[0]?.parentId;
      const parentAt = parent == null ? -1 : (held.get(parent) ?? -1);
      const prefix =
        keep >= 0
          ? loaded.slice(0, keep)
          : parentAt >= 0
            ? loaded.slice(0, parentAt + 1)
            : // Unjoined on a branch only appended to: the unloaded range stays a placeholder.
              action.continuous && parent != null
              ? loaded
              : [];
      const entries =
        page.length === 0 && action.continuous
          ? loaded
          : [
              ...prefix,
              ...page.map((entry) => {
                const position = held.get(entry.id);
                return position === undefined ? entry : loaded[position]!;
              }),
            ];
      return {
        identity,
        entries,
        pending: same
          ? retirePending(state.pending, state.persisted, new Set(entries.map((entry) => entry.id)))
          : [],
        persisted: same ? state.persisted : new Map(),
        losses: same ? state.losses : [],
        cursor: action.nextCursor,
        cursorLeaf: identity.leafId,
        revision: state.revision + 1,
        needsSnapshot: false,
      };
    }
    case "older": {
      if (
        action.revision !== state.revision ||
        !sameNativeSession(state.identity, action.page) ||
        action.page.leafId !== state.cursorLeaf
      )
        return state;
      // Each new entry goes before its loaded child; a gap closes where the page
      // reaches an entry already held.
      const loaded = new Set(state.entries.map((entry) => entry.id));
      const childOf = new Map(state.entries.map((entry) => [entry.parentId, entry.id]));
      const inserts = new Map<string, NeoPiJournalEntry[]>();
      let anchor: string | undefined;
      for (let position = action.page.entries.length - 1; position >= 0; position -= 1) {
        const entry = action.page.entries[position]!;
        if (loaded.has(entry.id)) {
          anchor = entry.id;
          continue;
        }
        anchor ??= childOf.get(entry.id);
        if (anchor === undefined) return state;
        inserts.set(anchor, [entry, ...(inserts.get(anchor) ?? [])]);
      }
      const entries = inserts.size
        ? state.entries.flatMap((entry) => [...(inserts.get(entry.id) ?? []), entry])
        : state.entries;
      return {
        ...state,
        entries,
        pending: retirePending(
          state.pending,
          state.persisted,
          new Set(entries.map((entry) => entry.id)),
        ),
        cursor: action.page.nextCursor,
      };
    }
    case "identity": {
      if (!sameNativeSession(state.identity, action.identity))
        return {
          ...emptyNativeConversation(),
          identity: action.identity,
          revision: state.revision + 1,
          needsSnapshot: true,
        };
      if (state.identity?.leafId === action.identity.leafId) return state;
      // Native announces the leaf before the corresponding durable entry.
      return {
        ...state,
        identity: action.identity,
        revision: state.revision + 1,
        needsSnapshot: true,
      };
    }
    case "entry": {
      if (!sameNativeSession(state.identity, action.identity)) return state;
      if (state.entries.some((entry) => entry.id === action.entry.id)) return state;
      const last = state.entries.at(-1)?.id ?? null;
      // A native flush can publish several entries with the batch's final leaf.
      // Parentage, not equality with that leaf, establishes a valid continuation.
      if (action.entry.parentId !== last) return { ...state, needsSnapshot: true };
      const pending = state.pending.filter(
        (message) => state.persisted.get(message.messageId) !== action.entry.id,
      );
      return {
        ...state,
        identity: action.identity,
        entries: [...state.entries, action.entry],
        pending,
        needsSnapshot: action.entry.id !== action.identity.leafId,
        revision: state.revision + 1,
      };
    }
    case "persistence_snapshot": {
      if (
        !sameNativeSession(state.identity, action.identity) ||
        action.messageEntryIds.length === 0
      )
        return state;
      const persisted = new Map(state.persisted);
      for (const pair of action.messageEntryIds) persisted.set(pair.messageId, pair.entryId);
      const entryIds = new Set(state.entries.map((entry) => entry.id));
      return {
        ...state,
        persisted,
        pending: state.pending.filter(
          (message) => !entryIds.has(persisted.get(message.messageId) ?? ""),
        ),
      };
    }
    case "persisted": {
      if (!sameNativeSession(state.identity, action.identity)) return state;
      const persisted = new Map(state.persisted).set(action.messageId, action.entryId);
      return {
        ...state,
        persisted,
        pending: state.entries.some((entry) => entry.id === action.entryId)
          ? state.pending.filter((message) => message.messageId !== action.messageId)
          : state.pending,
      };
    }
    case "turn_started": {
      // Live copies of an earlier turn's failure would otherwise render at the
      // tail of every later turn: a failed message may never get a persistence ID.
      const pending = state.pending.filter(({ message }) => !isFailedAssistantMessage(message));
      return pending.length === state.pending.length ? state : { ...state, pending };
    }
    case "message": {
      if (!state.identity) return state;
      const entryId = state.persisted.get(action.messageId);
      if (entryId && state.entries.some((entry) => entry.id === entryId)) return state;
      const index = state.pending.findIndex((message) => message.messageId === action.messageId);
      const message: NativeLiveMessage = {
        messageId: action.messageId,
        message: action.message,
        ...(action.stopOutcome ? { stopOutcome: action.stopOutcome } : {}),
      };
      return {
        ...state,
        pending:
          index < 0
            ? [...state.pending, message]
            : state.pending.map((previous, position) => (position === index ? message : previous)),
      };
    }
    case "unresolved":
      return loseRows(state, (message) => action.messageIds.has(message.messageId));
    case "owner_changed": {
      const lost = loseRows(state, (message) => !state.persisted.has(message.messageId));
      const persisted = new Map<string, string>();
      const pending = lost.pending.map((row) => {
        const entryId = state.persisted.get(row.messageId)!;
        const messageId = `durable:${entryId}`;
        persisted.set(messageId, entryId);
        return { ...row, messageId };
      });
      return state.persisted.size === 0 && lost === state ? state : { ...lost, pending, persisted };
    }
  }
}

/** Ask answers and drafts belong to one canonical file, never a thread alias. */
export function nativeNavigationGuards(identity: NativeIdentity) {
  if (identity.sessionFile === null) throw new Error("This session has no canonical native file.");
  return {
    expectedSessionId: identity.sessionId,
    expectedSessionFile: identity.sessionFile,
    expectedLeafId: identity.leafId,
  };
}
