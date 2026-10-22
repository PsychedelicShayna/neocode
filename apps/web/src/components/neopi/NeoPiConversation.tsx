import { LegendList } from "@legendapp/list/react";
import type { NeoPiJournalEntry, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { NeoPiJournalContent } from "./NeoPiJournalContent";
import { journalEntryCategory, journalEntryLabel } from "@t3tools/client-runtime/neopi-journal";
import { useNativeDraftIdentity } from "./neopiNativeDraft";
import { useNeoPiConversation } from "./useNeoPiConversation";
import { nativeTreeSessionKey, useNativeTreeField } from "./neopiTreeState";

export function NeoPiConversation({ threadRef, cwd, composerInset, onOpenTree, ownerStatus }: {
  threadRef: ScopedThreadRef;
  cwd?: string | undefined;
  composerInset: number;
  onOpenTree: () => void;
  ownerStatus: string | undefined;
}) {
  const { conversation, connection, loading, error, refresh, paging, loadOlder, busy } = useNeoPiConversation(threadRef);
  const connected = useRef(false);
  connected.current = connection?.status === "connected";
  useEffect(() => {
    if (ownerStatus && ownerStatus !== "starting" && ownerStatus !== "stopped" && !connected.current) refresh();
  }, [ownerStatus, refresh]);
  useNativeDraftIdentity(threadRef, conversation.identity);
  const [pendingResume] = useNativeTreeField(nativeTreeSessionKey(threadRef.environmentId, conversation.identity), "resumeResult");
  const pendingEntries = useMemo(() => conversation.pending.map(({ messageId, message }) => ({
    id: `live:${messageId}`, parentId: conversation.identity?.leafId ?? null,
    type: "message", timestamp: "", message,
  } satisfies NeoPiJournalEntry)), [conversation.pending, conversation.identity?.leafId]);
  const renderEntry = useCallback((entry: NeoPiJournalEntry, durable: boolean) => {
    const category = journalEntryCategory(entry);
    return (
      <article className={cn("mx-auto w-full max-w-(--chat-max-width) border-b px-5 py-5", category === "system" && "border-l-2 border-l-primary/40 bg-muted/20", category === "tool" && "bg-muted/10")}
        data-native-entry-id={durable ? entry.id : undefined}>
        <header className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{journalEntryLabel(entry)}</span>
          {entry.timestamp ? <time dateTime={entry.timestamp}>{entry.timestamp}</time> : null}
          {!durable ? <span>Live native message · awaiting persistence</span> : null}
        </header>
        <NeoPiJournalContent entry={entry} threadRef={threadRef} cwd={cwd} />
      </article>
    );
  }, [cwd, threadRef.environmentId, threadRef.threadId]);
  const renderRow = useCallback(({ item }: { item: NeoPiJournalEntry }) => renderEntry(item, true), [renderEntry]);
  const attached = connection?.status === "connected";
  const status = loading ? "Connecting to native conversation"
    : connection?.ownership === "stopped" ? "Stopped native session · read-only"
    : !attached ? connection?.status === "disconnected" || connection?.status === "gap" ? "Reconnecting" : "Native conversation unavailable"
    : connection?.ownership === "gui" ? "Attached to NeoPi" : connection?.ownership === "terminal"
      ? "Detached from input · following terminal" : "Native owner unknown";
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Native conversation">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs">
        <div role="status" className="min-w-0">
          <p>{status}</p>
          {connection?.reason ? <p className="text-muted-foreground">{connection.reason}</p> : null}
          {conversation.needsSnapshot ? <p className="text-muted-foreground">Rebuilding the native branch. Live drafts are not replayed.</p> : null}
          {busy ? <p className="text-muted-foreground">{conversation.pending.length ? "Native turn in progress." : "Native turn in progress. Waiting for the next complete native message update."}</p> : null}
          {pendingResume?.resumeToken ? <p className="text-muted-foreground">A saved ask answer is waiting for review in Session tree. It has not resumed the agent.</p> : null}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onOpenTree}>Session tree</Button>
          <Button size="sm" variant="ghost" onClick={() => refresh()}>Reconnect / refresh</Button>
        </div>
      </header>
      {error ? <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">{error}</p> : null}
      {conversation.identity && (conversation.cursor || conversation.cursorLeaf !== conversation.identity.leafId) ? (
        <div className="shrink-0 border-b px-4 py-2">
          <Button size="sm" variant="outline" disabled={paging || conversation.needsSnapshot} onClick={() => void loadOlder()}>
            {paging ? "Reading older entries…" : "Load older native entries"}
          </Button>
        </div>
      ) : null}
      {conversation.entries.length || pendingEntries.length ? <LegendList data={conversation.entries} keyExtractor={(entry) => entry.id} renderItem={renderRow}
        estimatedItemSize={180} recycleItems maintainVisibleContentPosition
        maintainScrollAtEnd={{ animated: false }} maintainScrollAtEndThreshold={0.1}
        ListFooterComponent={<>{pendingEntries.map((entry) => <div key={entry.id}>{renderEntry(entry, false)}</div>)}<div style={{ height: composerInset }} /></>}
        className="min-h-0 flex-1 overflow-auto" aria-label="Canonical native branch entries" />
        : <div className="px-5 py-8 text-sm text-muted-foreground">{loading ? "Reading native history…" : attached ? "This native branch has no entries." : "Native history is not available. No SQL conversation is substituted."}</div>}
    </section>
  );
}
