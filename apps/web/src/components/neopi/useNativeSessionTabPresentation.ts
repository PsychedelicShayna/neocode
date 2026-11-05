import { useAtomValue } from "@effect/atom-react";
import {
  nativeRecord,
  type NativeSessionFeed,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { agentIdentity, nativeSessionIdentityKey } from "@t3tools/shared/agentNames";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { nativeSessionAtoms } from "../../state/neopiNativeSessions";
import { useEnvironmentQuery } from "../../state/query";

export const TAB_STATUS = {
  attention: { label: "Waiting for your answer", dot: "bg-primary" },
  working: { label: "Working", dot: "bg-warning" },
  terminal: { label: "Following a terminal", dot: "bg-info" },
  ready: { label: "Ready", dot: "bg-success" },
  connecting: { label: "Connecting", dot: "bg-muted-foreground/50" },
  offline: { label: "Reconnecting · showing cached conversation", dot: "bg-muted-foreground/50" },
  // Watching a session attaches it, so only sessions opened in this run are watched.
  idle: { label: "Not connected", dot: "bg-muted-foreground/30" },
} as const;
type TabStatus = keyof typeof TAB_STATUS;

type FeedResult = AsyncResult.AsyncResult<NativeSessionFeed, unknown>;
const UNWATCHED = Atom.make(AsyncResult.initial<NativeSessionFeed, never>());

// Selectors return primitives so a tab re-renders only when what it shows changes,
// not on every streamed delta.
const selectStatus = (result: FeedResult): TabStatus => {
  if (!AsyncResult.isSuccess(result))
    return AsyncResult.isInitial(result) ? "connecting" : "offline";
  const feed = result.value;
  if (!feed.connected) return "offline";
  if (feed.dialogs.length > 0) return "attention";
  if (feed.busy) return "working";
  return feed.session?.attachment === "terminal" ? "terminal" : "ready";
};
const selectSessionName = (result: FeedResult): string => {
  if (!AsyncResult.isSuccess(result)) return "";
  const name = nativeRecord(result.value.session?.state).sessionName;
  return typeof name === "string" ? name.trim() : "";
};

const selectSessionId = (result: FeedResult): string =>
  AsyncResult.isSuccess(result) ? (result.value.session?.sessionId ?? "") : "";

/** What a session tab, and the Ctrl+Tab switcher, show for one session. */
export function useNativeSessionTabPresentation(tab: NativeSessionTarget, watched: boolean) {
  const listedSessions = useEnvironmentQuery(
    nativeSessionAtoms.list({ environmentId: tab.environmentId, input: {} }),
  ).data?.sessions;
  const feed: Atom.Atom<FeedResult> = watched
    ? nativeSessionAtoms.watch({ environmentId: tab.environmentId, input: { ref: tab.ref } })
    : UNWATCHED;
  const watchedStatus = useAtomValue(feed, selectStatus);
  const status = TAB_STATUS[watched ? watchedStatus : "idle"];
  const sessionName = useAtomValue(feed, selectSessionName);
  const sessionId = useAtomValue(feed, selectSessionId);
  // A moved session (`/wt`) keeps its id while its file changes, and the list
  // can still hold the previous file's row, so the id finds its title too.
  const listed =
    listedSessions?.find(
      (entry) =>
        entry.ref.sessionFile === tab.ref.sessionFile &&
        entry.ref.providerInstanceId === tab.ref.providerInstanceId,
    ) ??
    (sessionId
      ? listedSessions?.find(
          (entry) =>
            entry.sessionId === sessionId &&
            entry.ref.providerInstanceId === tab.ref.providerInstanceId,
        )
      : undefined);
  const title =
    listed?.title || sessionName || listed?.firstMessage.split("\n")[0]?.trim() || "New session";
  const identity = agentIdentity(
    nativeSessionIdentityKey({
      sessionId: sessionId || listed?.sessionId,
      sessionFile: tab.ref.sessionFile,
    }),
  );
  return { title, identity, status, cwd: listed?.cwd };
}
