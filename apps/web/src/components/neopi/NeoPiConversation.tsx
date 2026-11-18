import type { ScopedThreadRef } from "@t3tools/contracts";
import { projectTranscript } from "@t3tools/client-runtime/neopi-transcript";
import { agentIdentity, nativeSessionIdentityKey } from "@t3tools/shared/agentNames";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { NativeTimelineView, nativeTimelineKey } from "./NativeTimelineView";
import { useNativeDraftIdentity } from "./neopiNativeDraft";
import { useNeoPiConversation } from "./useNeoPiConversation";
import { nativeTreeSessionKey, useNativeTreeField } from "./neopiTreeState";

export function NeoPiConversation({
  threadRef,
  cwd,
  composerInset,
  onOpenTree,
  ownerStatus,
}: {
  threadRef: ScopedThreadRef;
  cwd?: string | undefined;
  composerInset: number;
  onOpenTree: () => void;
  ownerStatus: string | undefined;
}) {
  const { conversation, connection, loading, error, refresh, paging, loadOlder, busy } =
    useNeoPiConversation(threadRef);
  const connected = useRef(false);
  connected.current = connection?.status === "connected";
  useEffect(() => {
    // The provider's running native session is the only source of its live
    // messages. A new or replaced owner means the observer must reattach.
    // A stopped runtime is re-read too: the binding then says no NeoCode runtime runs it.
    if (ownerStatus && ownerStatus !== "starting" && !connected.current) refresh();
  }, [ownerStatus, refresh]);
  useNativeDraftIdentity(threadRef, conversation.identity);
  const [pendingResume] = useNativeTreeField(
    nativeTreeSessionKey(threadRef.environmentId, conversation.identity),
    "resumeResult",
  );
  const [debug, setDebug] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const rows = useMemo(
    () =>
      projectTranscript(
        {
          entries: conversation.entries,
          pending: conversation.pending,
          leafId: conversation.identity?.leafId ?? null,
        },
        { debug },
      ),
    [conversation.entries, conversation.pending, conversation.identity?.leafId, debug],
  );
  const identity = conversation.identity;
  const assistantName = identity
    ? agentIdentity(
        nativeSessionIdentityKey({
          sessionId: identity.sessionId,
          sessionFile: identity.sessionFile ?? "",
        }),
      ).label
    : undefined;
  const attached = connection?.status === "connected";
  const olderAvailable =
    conversation.identity !== null &&
    (conversation.cursor !== undefined || conversation.cursorLeaf !== conversation.identity.leafId);
  const loadEarlier = useMemo(
    () =>
      olderAvailable && !conversation.needsSnapshot
        ? { loading: paging, onLoadEarlier: () => void loadOlder() }
        : null,
    [olderAvailable, conversation.needsSnapshot, paging, loadOlder],
  );
  // Ready and Working are already visible in the thread chrome; only unusual
  // ownership or connection states earn a line above the conversation.
  const status = loading
    ? "Connecting to NeoPi"
    : connection?.ownership === "stopped"
      ? "Stopped session · read-only"
      : !attached
        ? connection?.status === "disconnected"
          ? "Reconnecting to NeoPi"
          : "Native conversation unavailable"
        : connection?.ownership === "terminal"
          ? "Following the terminal"
          : connection?.ownership === "gui"
            ? null
            : "Native owner unknown";
  const notes = [
    status,
    connection?.reason ?? null,
    conversation.needsSnapshot ? "Rebuilding the native branch." : null,
    pendingResume?.resumeToken ? "A saved ask answer is waiting in the session tree." : null,
  ].filter((note): note is string => note !== null);
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Native conversation">
      <div className="mx-auto flex w-full max-w-(--chat-max-width) shrink-0 items-center gap-1 px-3 pt-1 text-xs text-muted-foreground">
        <p role="status" className="min-w-0 flex-1 truncate">
          {notes.join(" · ")}
        </p>
        <Button size="xs" variant="ghost" onClick={onOpenTree}>
          Session tree
        </Button>
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={debug}
          onClick={() => setDebug((value) => !value)}
        >
          Native records
        </Button>
        {!attached ? (
          <Button size="xs" variant="ghost" onClick={() => refresh()}>
            Reconnect
          </Button>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="mx-auto w-full max-w-(--chat-max-width) px-3 py-1 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <NativeTimelineView
          rows={rows}
          busy={busy === true}
          {...(assistantName ? { assistantName } : {})}
          environmentId={threadRef.environmentId}
          timelineKey={nativeTimelineKey(threadRef.environmentId, threadRef.threadId)}
          cwd={cwd}
          loadEarlier={loadEarlier}
          composerInset={composerInset}
          onImageExpand={setExpandedImage}
        />
      </div>
      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
    </section>
  );
}
