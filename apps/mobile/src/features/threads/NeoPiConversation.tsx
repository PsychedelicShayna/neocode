import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { NeoPiJournalEntry, ScopedThreadRef } from "@t3tools/contracts";
import { journalEntryCategory, journalEntryLabel, journalRecord } from "@t3tools/client-runtime/neopi-journal";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { nativeSessionDraftKey, useNeoPiConversation } from "../../state/neopiConversation";
import { clearComposerDraft, replaceComposerDraftFromNative, useComposerDraft } from "../../state/use-composer-drafts";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { NativeError } from "./NativeNeoPiControls";
import { NeoPiJournalContent } from "./NeoPiJournalContent";
import { NeoPiSessionTree } from "./NeoPiSessionTree";

export function NeoPiConversation({ threadRef, cwd, bottomInset, listRef, ownerStatus, queuedMessages, onEditPendingMessage, onEndFollowEnabledChange, onHasConversationChange }: {
  threadRef: ScopedThreadRef;
  cwd: string | null;
  bottomInset: number;
  listRef: RefObject<LegendListRef | null>;
  ownerStatus: string | undefined;
  onEndFollowEnabledChange: (value: boolean) => void;
  onHasConversationChange: (value: boolean) => void;
  queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  onEditPendingMessage: (message: QueuedThreadMessage) => void;
}) {
  const { conversation, connection, loading, error, refresh, loadOlder, paging, busy } = useNeoPiConversation(threadRef);
  const [treeOpen, setTreeOpen] = useState(false);
  const currentConnected = useRef(false);
  currentConnected.current = connection?.status === "connected";
  useEffect(() => {
    if (ownerStatus && ownerStatus !== "starting" && ownerStatus !== "stopped" && !currentConnected.current) refresh();
  }, [ownerStatus, refresh]);
  const nativeDraft = useComposerDraft(conversation.identity ? nativeSessionDraftKey(threadRef, conversation.identity) : null);
  const legacyBackupKey = `${scopedThreadKey(threadRef.environmentId, threadRef.threadId)}-unbound-draft`;
  const legacyBackup = useComposerDraft(legacyBackupKey);
  const restoreLegacyDraft = () => {
    if (!conversation.identity) return;
    replaceComposerDraftFromNative(nativeSessionDraftKey(threadRef, conversation.identity), { text: legacyBackup.text, attachments: legacyBackup.attachments, context: legacyBackup.context });
    clearComposerDraft(legacyBackupKey, { deferAttachmentCleanup: true });
  };
  const hasConversation = conversation.entries.some(entry => entry.type === "message" && journalRecord(entry.message).role === "user");
  useEffect(() => { onHasConversationChange(hasConversation); }, [hasConversation, onHasConversationChange]);
  const renderEntry = useCallback((entry: NeoPiJournalEntry, durable: boolean) => {
    const category = journalEntryCategory(entry);
    return <View className={category === "system" ? "gap-3 border-b border-l-2 border-border-subtle px-4 py-4" : "gap-3 border-b border-border-subtle px-4 py-4"}>
      <View className="gap-1"><Text className="text-xs font-t3-medium text-foreground">{journalEntryLabel(entry)}</Text>{entry.timestamp ? <Text className="text-xs text-foreground-muted">{entry.timestamp}</Text> : null}{!durable ? <Text className="text-xs text-foreground-muted">Live native message · awaiting persistence</Text> : null}</View>
      <NeoPiJournalContent entry={entry} threadRef={threadRef} cwd={cwd} />
    </View>;
  }, [cwd, threadRef.environmentId, threadRef.threadId]);
  const attached = connection?.status === "connected";
  const status = loading ? "Connecting to native conversation" : connection?.ownership === "stopped" ? "Stopped native session · read-only history" : !attached ? connection?.status === "disconnected" || connection?.status === "gap" ? "Reconnecting native conversation" : "Native conversation unavailable" : connection.ownership === "gui" ? "Attached to NeoPi" : connection.ownership === "terminal" ? "Following terminal-owned NeoPi session" : "Native owner unknown";
  return <View className="flex-1">
    <View className="gap-2 border-b border-border-subtle px-4 py-2"><Text accessibilityRole="text" className="text-xs text-foreground">{status}</Text>{connection?.reason ? <Text className="text-xs text-foreground-muted">{connection.reason}</Text> : null}{conversation.needsSnapshot ? <Text className="text-xs text-foreground-muted">Rebuilding the canonical branch. Live drafts are not replayed.</Text> : null}{busy ? <Text className="text-xs text-foreground-muted">{conversation.pending.length ? "Native turn in progress." : "Native turn in progress. Waiting for the next complete native update."}</Text> : null}{nativeDraft.nativeTree?.resumeResult?.resumeToken ? <Text className="text-xs text-foreground-muted">A saved answer is waiting for review in Session tree. It has not resumed the agent.</Text> : null}<View className="flex-row flex-wrap gap-2"><MaterialButton label="Session tree" tone="text" onPress={() => setTreeOpen(true)} /><MaterialButton label="Reconnect / refresh" tone="text" onPress={refresh} />{conversation.identity && (conversation.cursor || conversation.cursorLeaf !== conversation.identity.leafId) ? <MaterialButton label={paging ? "Reading older entries…" : "Load older native entries"} disabled={paging || conversation.needsSnapshot} onPress={() => void loadOlder()} /> : null}</View><NativeError message={error} /></View>
    {legacyBackup.text || legacyBackup.attachments.length ? <View className="gap-2 border-b border-border-subtle px-4 py-2"><Text className="text-xs text-foreground-muted">A separate unsent draft was retained when this UI alias attached to an existing native session. Restoring it replaces the current draft, not native history.</Text><MaterialButton label="Restore retained local draft" disabled={!conversation.identity} onPress={restoreLegacyDraft} /></View> : null}
    <KeyboardAwareLegendList
      ref={listRef}
      data={conversation.entries}
      keyExtractor={entry => entry.id}
      renderItem={({ item }) => renderEntry(item, true)}
      estimatedItemSize={180}
      maintainVisibleContentPosition
      maintainScrollAtEnd={{ animated: false }}
      maintainScrollAtEndThreshold={0.1}
      style={{ flex: 1 }}
      keyboardShouldPersistTaps="handled"
      onScroll={event => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; onEndFollowEnabledChange(contentSize.height - layoutMeasurement.height - contentOffset.y < 80); }}
      scrollEventThrottle={16}
      ListEmptyComponent={conversation.pending.length ? null : <Text className="px-4 py-8 text-foreground-muted">{loading ? "Reading native history…" : attached ? "This native branch has no entries." : "Native history is unavailable. No SQL conversation is substituted."}</Text>}
      ListFooterComponent={<View>{conversation.pending.map(({ messageId, message }) => <View key={messageId}>{renderEntry({ id: `live:${messageId}`, parentId: conversation.identity?.leafId ?? null, type: "message", timestamp: "", message }, false)}</View>)}{queuedMessages.map(message => <View key={message.messageId} className="gap-2 border-t border-border-subtle px-4 py-3"><Text className="text-xs text-foreground-muted">Local outbox · not yet native history</Text><Text selectable className="text-foreground">{message.text}</Text>{message.attachments.length ? <Text className="text-xs text-foreground-muted">{message.attachments.length} local attachments</Text> : null}<MaterialButton label="Edit queued message" tone="text" onPress={() => onEditPendingMessage(message)} /></View>)}<View style={{ height: bottomInset }} /></View>}
    />
    {treeOpen ? <NeoPiSessionTree key={`${threadRef.environmentId}:${threadRef.threadId}`} threadRef={threadRef} cwd={cwd} onClose={() => setTreeOpen(false)} /> : null}
  </View>;
}
