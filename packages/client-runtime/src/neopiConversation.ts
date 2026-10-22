import type { NeoPiJournalEntry, NeoPiJournalPage } from "@t3tools/contracts";

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
  identity: null, entries: [], pending: [], persisted: new Map(), cursor: undefined,
  cursorLeaf: null, revision: 0, needsSnapshot: false,
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
  | { type: "message"; messageId: string; message: Readonly<Record<string, unknown>> };

function uniqueEntries(entries: ReadonlyArray<NeoPiJournalEntry>) {
  const seen = new Set<string>();
  return entries.filter((entry) => !seen.has(entry.id) && !!seen.add(entry.id));
}

/** Native parent pointers select the branch. No context reconstruction or SQL messages. */
export function reduceNativeConversation(state: NativeConversation, action: NativeConversationAction): NativeConversation {
  switch (action.type) {
    case "disconnect":
      return { ...state, pending: [], persisted: new Map(), revision: state.revision + 1, needsSnapshot: true };
    case "snapshot": {
      const page = action.page;
      // A leaf notification can arrive before its branch snapshot. Compare with
      // the loaded history, not that newly announced leaf.
      const loadedLeaf = state.entries.at(-1)?.id;
      const extendsBranch = sameNativeSession(state.identity, page) &&
        loadedLeaf !== undefined && page.entries.some((entry) => entry.id === loadedLeaf);
      const entries = uniqueEntries([...(extendsBranch ? state.entries : []), ...page.entries]);
      const ids = new Set(entries.map((entry) => entry.id));
      return {
        identity: page, entries,
        pending: extendsBranch
          ? state.pending.filter((message) => !ids.has(state.persisted.get(message.messageId) ?? "")) : [],
        persisted: extendsBranch ? state.persisted : new Map(),
        cursor: page.nextCursor, cursorLeaf: page.leafId,
        revision: state.revision + 1, needsSnapshot: false,
      };
    }
    case "older": {
      if (action.revision !== state.revision || !sameNativeSession(state.identity, action.page) ||
        action.page.leafId !== state.cursorLeaf) return state;
      return { ...state, entries: uniqueEntries([...action.page.entries, ...state.entries]), cursor: action.page.nextCursor };
    }
    case "identity": {
      if (!sameNativeSession(state.identity, action.identity))
        return { ...emptyNativeConversation(), identity: action.identity, revision: state.revision + 1, needsSnapshot: true };
      if (state.identity?.leafId === action.identity.leafId) return state;
      // Native announces the leaf before the corresponding durable entry.
      return { ...state, identity: action.identity, revision: state.revision + 1, needsSnapshot: true };
    }
    case "entry": {
      if (!sameNativeSession(state.identity, action.identity)) return state;
      if (state.entries.some((entry) => entry.id === action.entry.id)) return state;
      const last = state.entries.at(-1)?.id ?? null;
      if (action.entry.parentId !== last || action.entry.id !== action.identity.leafId)
        return { ...state, needsSnapshot: true };
      const pending = state.pending.filter((message) => state.persisted.get(message.messageId) !== action.entry.id);
      return { ...state, identity: action.identity, entries: [...state.entries, action.entry], pending,
        needsSnapshot: false, revision: state.revision + 1 };
    }
    case "persisted": {
      if (!sameNativeSession(state.identity, action.identity)) return state;
      const persisted = new Map(state.persisted).set(action.messageId, action.entryId);
      return { ...state, persisted,
        pending: state.entries.some((entry) => entry.id === action.entryId)
          ? state.pending.filter((message) => message.messageId !== action.messageId) : state.pending };
    }
    case "message": {
      if (!state.identity || state.needsSnapshot) return state;
      const entryId = state.persisted.get(action.messageId);
      if (entryId && state.entries.some((entry) => entry.id === entryId)) return state;
      const index = state.pending.findIndex((message) => message.messageId === action.messageId);
      const message = { messageId: action.messageId, message: action.message };
      return { ...state, pending: index < 0 ? [...state.pending, message]
        : state.pending.map((previous, position) => position === index ? message : previous) };
    }
  }
}

/** Ask answers and drafts belong to one canonical file, never a thread alias. */
export function nativeNavigationGuards(identity: NativeIdentity) {
  if (identity.sessionFile === null) throw new Error("This session has no canonical native file.");
  return { expectedSessionId: identity.sessionId, expectedSessionFile: identity.sessionFile,
    expectedLeafId: identity.leafId };
}
