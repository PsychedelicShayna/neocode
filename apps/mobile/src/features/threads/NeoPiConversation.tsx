import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { NeoPiJournalEntry, ScopedThreadRef } from "@t3tools/contracts";
import { journalEntryCategory, journalEntryLabel } from "@t3tools/client-runtime/neopi-journal";
import {
  useEffect,
  useEffectEvent,
  useState,
  type ComponentPropsWithRef,
  type RefObject,
} from "react";
import { Platform, View } from "react-native";
import Animated from "react-native-reanimated";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { nativeSessionDraftKey, useNeoPiConversation } from "../../state/neopiConversation";
import {
  clearComposerDraft,
  replaceComposerDraftFromNative,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { NativeError } from "./NativeNeoPiControls";
import { NeoPiJournalContent } from "./NeoPiJournalContent";
import { NeoPiSessionTree } from "./NeoPiSessionTree";

function NativeConversationScrollView(props: ComponentPropsWithRef<typeof Animated.ScrollView>) {
  return (
    <NativeScrollViewMarker style={{ flex: 1 }}>
      <Animated.ScrollView {...props} />
    </NativeScrollViewMarker>
  );
}

export function NeoPiConversation({
  threadRef,
  cwd,
  bottomInset,
  listRef,
  ownerStatus,
  queuedMessages,
  onEditPendingMessage,
  onEndFollowEnabledChange,
}: {
  threadRef: ScopedThreadRef;
  cwd: string | null;
  bottomInset: number;
  listRef: RefObject<LegendListRef | null>;
  ownerStatus: string | undefined;
  onEndFollowEnabledChange: (value: boolean) => void;
  queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  onEditPendingMessage: (message: QueuedThreadMessage) => void;
}) {
  const { conversation, connection, loading, error, refresh, loadOlder, paging, busy } =
    useNeoPiConversation(threadRef);
  const [treeOpen, setTreeOpen] = useState(false);
  const refreshOwnerConnection = useEffectEvent(() => {
    if (connection?.status !== "connected") refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Native owner lifecycle announcements may require reopening the observer.
  useEffect(() => {
    if (ownerStatus && ownerStatus !== "starting" && ownerStatus !== "stopped")
      refreshOwnerConnection();
  }, [ownerStatus]);
  const nativeDraft = useComposerDraft(
    conversation.identity ? nativeSessionDraftKey(threadRef, conversation.identity) : null,
  );
  const legacyBackupKey = `${scopedThreadKey(threadRef.environmentId, threadRef.threadId)}-unbound-draft`;
  const legacyBackup = useComposerDraft(legacyBackupKey);
  const restoreLegacyDraft = () => {
    if (!conversation.identity) return;
    replaceComposerDraftFromNative(nativeSessionDraftKey(threadRef, conversation.identity), {
      text: legacyBackup.text,
      attachments: legacyBackup.attachments,
      context: legacyBackup.context,
    });
    clearComposerDraft(legacyBackupKey, { deferAttachmentCleanup: true });
  };
  const renderEntry = (entry: NeoPiJournalEntry, durable: boolean) => {
    const category = journalEntryCategory(entry);
    return (
      <View
        className={
          category === "system"
            ? "gap-3 border-b border-l-2 border-border-subtle px-4 py-4"
            : "gap-3 border-b border-border-subtle px-4 py-4"
        }
      >
        <View className="gap-1">
          <Text className="text-xs font-t3-medium text-foreground">{journalEntryLabel(entry)}</Text>
          {entry.timestamp ? (
            <Text className="text-xs text-foreground-muted">{entry.timestamp}</Text>
          ) : null}
          {!durable ? (
            <Text className="text-xs text-foreground-muted">
              Live native message · awaiting persistence
            </Text>
          ) : null}
        </View>
        <NeoPiJournalContent entry={entry} threadRef={threadRef} cwd={cwd} />
      </View>
    );
  };
  const attached = connection?.status === "connected";
  const status = loading
    ? "Connecting to native conversation"
    : connection?.ownership === "stopped"
      ? "Stopped native session · read-only history"
      : !attached
        ? connection?.status === "disconnected" || connection?.status === "gap"
          ? "Reconnecting native conversation"
          : "Native conversation unavailable"
        : connection.ownership === "gui"
          ? "Attached to NeoPi"
          : connection.ownership === "terminal"
            ? "Following terminal-owned NeoPi session"
            : "Native owner unknown";
  return (
    <View className="flex-1">
      <View className="gap-2 border-b border-border-subtle px-4 py-2">
        <Text accessibilityRole="text" className="text-xs text-foreground">
          {status}
        </Text>
        {connection?.reason ? (
          <Text className="text-xs text-foreground-muted">{connection.reason}</Text>
        ) : null}
        {conversation.needsSnapshot ? (
          <Text className="text-xs text-foreground-muted">
            Rebuilding the canonical branch. Live drafts are not replayed.
          </Text>
        ) : null}
        {busy ? (
          <Text className="text-xs text-foreground-muted">
            {conversation.pending.length
              ? "Native turn in progress."
              : "Native turn in progress. Waiting for the next complete native update."}
          </Text>
        ) : null}
        {nativeDraft.nativeTree?.resumeResult?.resumeToken ? (
          <Text className="text-xs text-foreground-muted">
            A saved answer is waiting for review in Session tree. It has not resumed the agent.
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          <Button label="Session tree" tone="text" onPress={() => setTreeOpen(true)} />
          <Button label="Reconnect / refresh" tone="text" onPress={refresh} />
          {conversation.identity &&
          (conversation.cursor || conversation.cursorLeaf !== conversation.identity.leafId) ? (
            <Button
              label={paging ? "Reading older entries…" : "Load older native entries"}
              disabled={paging || conversation.needsSnapshot}
              onPress={() => void loadOlder()}
            />
          ) : null}
        </View>
        <NativeError message={error} />
      </View>
      {legacyBackup.text || legacyBackup.attachments.length ? (
        <View className="gap-2 border-b border-border-subtle px-4 py-2">
          <Text className="text-xs text-foreground-muted">
            A separate unsent draft was retained when this UI alias attached to an existing native
            session. Restoring it replaces the current draft, not native history.
          </Text>
          <Button
            label="Restore retained local draft"
            disabled={!conversation.identity}
            onPress={restoreLegacyDraft}
          />
        </View>
      ) : null}
      {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- The registered native scroll component is supplied only on iOS. */}
      <KeyboardAwareLegendList
        ref={listRef}
        {...(Platform.OS === "ios" ? { ScrollViewComponent: NativeConversationScrollView } : {})}
        data={conversation.entries}
        keyExtractor={(entry) => entry.id}
        renderItem={({ item }) => renderEntry(item, true)}
        estimatedItemSize={180}
        maintainVisibleContentPosition
        maintainScrollAtEnd={{ animated: false }}
        maintainScrollAtEndThreshold={0.1}
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          onEndFollowEnabledChange(
            contentSize.height - layoutMeasurement.height - contentOffset.y < 80,
          );
        }}
        scrollEventThrottle={16}
        ListEmptyComponent={
          conversation.pending.length ? null : (
            <Text className="px-4 py-8 text-foreground-muted">
              {loading
                ? "Reading native history…"
                : attached
                  ? "This native branch has no entries."
                  : "Native history is unavailable. No SQL conversation is substituted."}
            </Text>
          )
        }
        ListFooterComponent={
          <View>
            {conversation.pending.map(({ messageId, message }) => (
              <View key={messageId}>
                {renderEntry(
                  {
                    id: `live:${messageId}`,
                    parentId: conversation.identity?.leafId ?? null,
                    type: "message",
                    timestamp: "",
                    message,
                  },
                  false,
                )}
              </View>
            ))}
            {queuedMessages.map((message) => (
              <View
                key={message.messageId}
                className="gap-2 border-t border-border-subtle px-4 py-3"
              >
                <Text className="text-xs text-foreground-muted">
                  Local outbox · not yet native history
                </Text>
                <Text selectable className="text-foreground">
                  {message.text}
                </Text>
                {message.attachments.length ? (
                  <Text className="text-xs text-foreground-muted">
                    {message.attachments.length} local attachments
                  </Text>
                ) : null}
                <Button
                  label="Edit queued message"
                  tone="text"
                  onPress={() => onEditPendingMessage(message)}
                />
              </View>
            ))}
            <View style={{ height: bottomInset }} />
          </View>
        }
      />
      {treeOpen ? (
        <NeoPiSessionTree
          key={`${threadRef.environmentId}:${threadRef.threadId}`}
          threadRef={threadRef}
          cwd={cwd}
          onClose={() => setTreeOpen(false)}
        />
      ) : null}
    </View>
  );
}
