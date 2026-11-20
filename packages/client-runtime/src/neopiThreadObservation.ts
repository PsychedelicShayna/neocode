import type {
  NeoPiJournalPage,
  NeoPiNativeObservationLifecycle,
  NeoPiThreadNativeRef,
} from "@t3tools/contracts";
import {
  emptyNativeConversation,
  reduceNativeConversation,
  sameNativeSession,
  type NativeConversation,
} from "./neopiConversation.ts";

/** What a thread's transcript, tree and status line show about its native observation. */
export interface ThreadNativeConnection {
  readonly status: "connected" | "unavailable" | "disconnected" | "identity_changed";
  /** `gui`: NeoCode's own runtime owns the session; `stopped`: nothing does. */
  readonly ownership: "gui" | "terminal" | "stopped" | "unknown";
  readonly canNavigate: boolean;
  /**
   * Where the transcript comes from. `live`: the observation. `read-only`: no owner can be
   * observed, so history is read through the journal. `none`: nothing of this session may be
   * shown (it is not the thread's session, or the thread has none).
   */
  readonly history: "live" | "read-only" | "none";
  readonly reason: string | null;
}

/** The observation controller's view of one session, as far as a thread needs it. */
export interface ThreadObservationInput {
  readonly phase: "attaching" | NeoPiNativeObservationLifecycle | "transport-lost" | "unauthorized";
  readonly reason: string | null;
  readonly connected: boolean;
  readonly session: {
    readonly sessionId: string;
    readonly capabilities: ReadonlyArray<string>;
  } | null;
}

export const CONTROL_PLANE_OFF_REASON =
  "NeoCode cannot observe this session: its NeoPi runtime is running, but that runtime's control plane is turned off (--no-control-socket or control.enabled=false) or not supported by its NeoPi version. The session itself is still running.";

export const SESSION_CHANGED_REASON =
  "The native session no longer matches this thread's binding, so its content is not shown. Refresh the binding.";

/**
 * Maps a thread's native ref and its attach-only observation onto the thread statuses.
 * `null` while the ref or the first attachment is still being established.
 */
export function threadNativeConnection(
  ref: NeoPiThreadNativeRef | null,
  observation: ThreadObservationInput | null,
): ThreadNativeConnection | null {
  if (ref === null) return null;
  if (ref.status === "unavailable")
    return {
      status: "unavailable",
      ownership: "unknown",
      canNavigate: false,
      history: "none",
      reason: ref.reason,
    };
  // What the owner is comes from NeoCode's own runtime: owning the session, or attached to a
  // terminal that does. Without one, an attached owner is a terminal.
  const owner: ThreadNativeConnection["ownership"] = ref.runtime === "gui" ? "gui" : "terminal";
  if (observation === null) return null;
  const { phase, session } = observation;
  if (session !== null && session.sessionId !== ref.sessionId)
    return {
      status: "identity_changed",
      ownership: owner,
      canNavigate: false,
      history: "none",
      reason: SESSION_CHANGED_REASON,
    };
  const live = (
    status: "connected" | "disconnected",
    reason: string | null,
  ): ThreadNativeConnection => ({
    status,
    ownership: owner,
    canNavigate:
      status === "connected" && session?.capabilities.includes("session_tree_navigation") === true,
    history: "live",
    reason,
  });
  switch (phase) {
    case "attaching":
      return session === null ? null : live("disconnected", null);
    case "building":
    case "observing":
      return observation.connected
        ? live("connected", null)
        : live("disconnected", observation.reason);
    case "reconnecting":
    case "transport-lost":
    case "authority-unresolved":
      return live("disconnected", observation.reason);
    // A session NeoCode's own runtime owns is never "stopped": finding no attachable owner for
    // it means its control plane is off or unsupported. Its history stays readable.
    case "owner-stopped":
      return ref.runtime === "gui"
        ? {
            status: "unavailable",
            ownership: "gui",
            canNavigate: false,
            history: "read-only",
            reason: CONTROL_PLANE_OFF_REASON,
          }
        : {
            status: "unavailable",
            ownership: "stopped",
            canNavigate: false,
            history: "read-only",
            reason: observation.reason,
          };
    // An owner this server cannot follow live (for example one without journal events) still
    // has readable history.
    case "incompatible":
      return {
        status: "unavailable",
        ownership: owner,
        canNavigate: false,
        history: "read-only",
        reason:
          ref.runtime === "gui"
            ? CONTROL_PLANE_OFF_REASON
            : `Live updates are unavailable for this NeoPi owner${observation.reason ? `: ${observation.reason}` : "."}`,
      };
    case "identity-changed":
      return {
        status: "identity_changed",
        ownership: owner,
        canNavigate: false,
        history: "none",
        reason: observation.reason ?? SESSION_CHANGED_REASON,
      };
    case "detached":
    case "unauthorized":
      return {
        status: "unavailable",
        ownership: owner,
        canNavigate: false,
        history: "none",
        reason: observation.reason,
      };
  }
}

/** Older history exists exactly when the oldest held entry has a parent. */
export const nativeOlderHistoryAvailable = (conversation: NativeConversation) =>
  conversation.identity !== null && (conversation.entries[0]?.parentId ?? null) !== null;

/**
 * The next older journal page for a transcript, for the `older` reducer action. A page cursor
 * is used while it is bound to the current leaf. Otherwise (the cursor was cut short, or the
 * live journal ring dropped the start of the first page) it walks backward from the current
 * leaf until it reaches the parent of the oldest held entry, so older history stays reachable.
 */
export async function findOlderNativePage(
  conversation: NativeConversation,
  fetchPage: (cursor: string | undefined) => Promise<NeoPiJournalPage>,
  maxPages = 50,
): Promise<NeoPiJournalPage | null> {
  const parentId = conversation.entries[0]?.parentId ?? null;
  if (conversation.identity === null || parentId === null) return null;
  if (conversation.cursor !== undefined && conversation.cursorLeaf === conversation.identity.leafId)
    return fetchPage(conversation.cursor);
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const next = await fetchPage(cursor);
    if (next.entries.some((entry) => entry.id === parentId)) return next;
    if (next.nextCursor === undefined) return null;
    cursor = next.nextCursor;
  }
  return null;
}

/**
 * What a thread transcript shows: the source conversation (live from the observation, or a
 * read-only journal page) with any older history the view paged in kept in front of it.
 * Pure, so views derive it during render. `paged` is the conversation the last older page
 * was joined into; it is used only while it is the same session.
 */
export function mergeThreadConversation(
  paged: NativeConversation | null,
  source: NativeConversation,
): NativeConversation {
  if (
    paged === null ||
    source.identity === null ||
    source.needsSnapshot ||
    !sameNativeSession(paged.identity, source.identity)
  )
    return source;
  const merged = reduceNativeConversation(paged, {
    type: "snapshot",
    page: {
      ...source.identity,
      sessionFile: source.identity.sessionFile ?? "",
      entries: source.entries,
      totalEntries: source.entries.length,
      ...(source.cursor ? { nextCursor: source.cursor } : {}),
    },
  });
  // The paged cursor stays usable while the branch has not moved since it was read.
  const keepCursor =
    paged.identity?.leafId === source.identity.leafId && paged.cursorLeaf === source.cursorLeaf;
  return {
    ...source,
    entries: merged.entries,
    ...(keepCursor ? { cursor: paged.cursor, cursorLeaf: paged.cursorLeaf } : {}),
  };
}

/** A read-only transcript from one journal page, for a session no owner can be observed for. */
export const readOnlyThreadConversation = (page: NeoPiJournalPage | null): NativeConversation =>
  page === null
    ? emptyNativeConversation()
    : reduceNativeConversation(emptyNativeConversation(), { type: "snapshot", page });
