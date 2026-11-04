import type {
  NeoPiJournalEntry,
  NeoPiJournalPage,
  NeoPiJournalStreamEvent,
} from "@t3tools/contracts";

export interface NativeIdentity {
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly leafId: string | null;
}
export interface NativeLiveMessage {
  readonly messageId: string;
  readonly message: Readonly<Record<string, unknown>>;
}
export interface NativeConversation {
  readonly identity: NativeIdentity | null;
  readonly entries: ReadonlyArray<NeoPiJournalEntry>;
  readonly pending: ReadonlyArray<NativeLiveMessage>;
  readonly persisted: ReadonlyMap<string, string>;
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
  | { type: "older"; page: NeoPiJournalPage; revision: number }
  | { type: "identity"; identity: NativeIdentity }
  | { type: "entry"; identity: NativeIdentity; entry: NeoPiJournalEntry }
  | { type: "persisted"; identity: NativeIdentity; messageId: string; entryId: string }
  | {
      type: "persistence_snapshot";
      identity: NativeIdentity;
      messageEntryIds: ReadonlyArray<{ messageId: string; entryId: string }>;
    }
  | { type: "message"; messageId: string; message: Readonly<Record<string, unknown>> };

function uniqueEntries(entries: ReadonlyArray<NeoPiJournalEntry>) {
  const seen = new Set<string>();
  return entries.filter((entry) => !seen.has(entry.id) && !!seen.add(entry.id));
}

/** Native parent pointers select the branch. No context reconstruction or SQL messages. */
export function reduceNativeConversation(
  state: NativeConversation,
  action: NativeConversationAction,
): NativeConversation {
  switch (action.type) {
    case "disconnect":
      return {
        ...state,
        pending: [],
        persisted: new Map(),
        revision: state.revision + 1,
        needsSnapshot: true,
      };
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
        cursor: page.nextCursor,
        cursorLeaf: page.leafId,
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
      const entries = uniqueEntries([...action.page.entries, ...state.entries]);
      const entryIds = new Set(entries.map((entry) => entry.id));
      return {
        ...state,
        entries,
        pending: state.pending.filter(
          (message) => !entryIds.has(state.persisted.get(message.messageId) ?? ""),
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
    case "message": {
      if (!state.identity) return state;
      const entryId = state.persisted.get(action.messageId);
      if (entryId && state.entries.some((entry) => entry.id === entryId)) return state;
      const index = state.pending.findIndex((message) => message.messageId === action.messageId);
      const message = { messageId: action.messageId, message: action.message };
      return {
        ...state,
        pending:
          index < 0
            ? [...state.pending, message]
            : state.pending.map((previous, position) => (position === index ? message : previous)),
      };
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

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export interface NativeConversationFeed {
  readonly conversation: NativeConversation;
  readonly connection: Extract<NeoPiJournalStreamEvent, { type: "connection" }> | null;
  readonly busy: boolean | null;
}
export const emptyNativeConversationFeed = (): NativeConversationFeed => ({
  conversation: emptyNativeConversation(),
  connection: null,
  busy: null,
});

export function applyNativeConversationEvent(
  feed: NativeConversationFeed,
  event: NeoPiJournalStreamEvent,
): NativeConversationFeed {
  const state = feed.conversation;
  if (event.type === "connection")
    return {
      connection: event,
      busy:
        event.status === "connected" && typeof event.state?.isStreaming === "boolean"
          ? event.state.isStreaming
          : null,
      conversation:
        event.status === "connected"
          ? state
          : reduceNativeConversation(state, { type: "disconnect" }),
    };
  if (event.type === "snapshot")
    return { ...feed, conversation: reduceNativeConversation(state, event) };
  const frame = event.event;
  if (frame.type === "agent_start") return { ...feed, busy: true };
  if (frame.type === "agent_end") return { ...feed, busy: false };
  let conversation = state;
  if (
    typeof frame.sessionId === "string" &&
    (typeof frame.sessionFile === "string" || frame.sessionFile === null) &&
    (typeof frame.leafId === "string" || frame.leafId === null)
  ) {
    const identity: NativeIdentity = {
      sessionId: frame.sessionId,
      sessionFile: frame.sessionFile,
      leafId: frame.leafId,
    };
    if (
      (frame.type === "message_start" ||
        frame.type === "message_update" ||
        frame.type === "message_end") &&
      !sameNativeSession(state.identity, identity)
    )
      return feed;
    if (frame.type === "journal_state") {
      // A reconnect boundary can predate the page already rendered by the client.
      // Recover durable IDs without moving that hydrated branch backwards.
      if (frame.reason !== "snapshot" || !sameNativeSession(state.identity, identity))
        conversation = reduceNativeConversation(state, { type: "identity", identity });
      if (frame.reason === "snapshot" && Array.isArray(frame.messageEntryIds)) {
        const messageEntryIds = frame.messageEntryIds.flatMap((value) => {
          const pair = record(value);
          return typeof pair.messageId === "string" && typeof pair.entryId === "string"
            ? [{ messageId: pair.messageId, entryId: pair.entryId }]
            : [];
        });
        conversation = reduceNativeConversation(conversation, {
          type: "persistence_snapshot",
          identity,
          messageEntryIds,
        });
      }
    }
    if (frame.type === "journal_entry") {
      const entry = record(frame.entry);
      if (
        typeof entry.id === "string" &&
        typeof entry.type === "string" &&
        typeof entry.timestamp === "string" &&
        (typeof entry.parentId === "string" || entry.parentId === null)
      )
        conversation = reduceNativeConversation(state, {
          type: "entry",
          identity,
          entry: entry as NeoPiJournalEntry,
        });
    }
    if (
      frame.type === "message_persisted" &&
      typeof frame.messageId === "string" &&
      typeof frame.entryId === "string"
    )
      conversation = reduceNativeConversation(state, {
        type: "persisted",
        identity,
        messageId: frame.messageId,
        entryId: frame.entryId,
      });
  }
  if (
    (frame.type === "message_start" ||
      frame.type === "message_update" ||
      frame.type === "message_end") &&
    typeof frame.messageId === "string"
  ) {
    conversation = reduceNativeConversation(state, {
      type: "message",
      messageId: frame.messageId,
      message: record(frame.message),
    });
    if (frame.snapshot === true) return { ...feed, conversation, busy: true };
  }
  return conversation === state ? feed : { ...feed, conversation };
}
