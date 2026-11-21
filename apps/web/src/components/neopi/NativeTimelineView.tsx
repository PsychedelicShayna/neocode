import type { LegendListRef } from "@legendapp/list/react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { TranscriptRow } from "@t3tools/client-runtime/neopi-transcript";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import type { QueuedComposerMessage } from "../../queuedMessageStore";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { ScrollToEndButton } from "../chat/ScrollToEndButton";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import type { CitationHistoryPage } from "../chat/useAssistantCitationTarget";
import {
  notifyTimelinePageScroll,
  useLeaveLiveEdgeOnScroll,
} from "../chat/useLeaveLiveEdgeOnScroll";
import { projectNativeTimeline } from "./nativeTimeline";

const NO_TURN_DIFFS: [] = [];
const noop = () => {};

/**
 * A native NeoPi conversation drawn by the stock T3 timeline. The caller owns
 * the journal projection inputs; this owns live-follow, which re-engages on
 * `followSignal` changes (a send) and when the reader returns to the live edge.
 */
export function NativeTimelineView(props: {
  readonly rows: readonly TranscriptRow[];
  readonly busy: boolean;
  readonly runPaused?: boolean;
  /** The author label on the assistant's messages: the session's own name and designation. */
  readonly assistantName?: string;
  readonly environmentId: EnvironmentId;
  /** Stable per native file; must not parse as a scoped thread key. */
  readonly timelineKey: string;
  readonly cwd: string | undefined;
  readonly listRef?: RefObject<LegendListRef | null>;
  readonly loadEarlier: CitationHistoryPage | null;
  readonly followSignal?: number;
  /** Height of a composer that overlays the list bottom (thread view); 0 when docked below. */
  readonly composerInset?: number;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly queuedMessages?: ReadonlyArray<QueuedComposerMessage>;
  readonly onSteerQueuedMessage?: (id: string) => void;
  readonly onRemoveQueuedMessage?: (id: string) => void;
  /** Drops NeoPi's reasoning blocks from the view; the journal keeps them. */
  readonly hideThinking?: boolean;
  /** Each new value toggles every tool call of the latest turn open or closed. */
  readonly toggleToolOutputSerial?: number;
  /** Live output missing from shown tool calls, by call id, marked at each call. */
  readonly toolLosses?: ReadonlyMap<string, readonly { readonly text: string }[]>;
}) {
  const settings = useEnvironmentSettings(props.environmentId);
  const { resolvedTheme } = useTheme();
  const localListRef = useRef<LegendListRef | null>(null);
  const listRef = props.listRef ?? localListRef;
  const visibleRows = useMemo(
    () => (props.hideThinking ? props.rows.filter((row) => row.kind !== "thinking") : props.rows),
    [props.rows, props.hideThinking],
  );
  const timeline = useMemo(
    () => projectNativeTimeline(visibleRows, props.busy, props.toolLosses, props.runPaused),
    [visibleRows, props.busy, props.toolLosses, props.runPaused],
  );
  const [liveFollow, setLiveFollow] = useState(true);
  const [isAtEnd, setIsAtEnd] = useState(true);
  const onLeave = useCallback(() => setLiveFollow(false), []);
  const onReturn = useCallback(() => setLiveFollow(true), []);
  // Leaving and coming back are both read from the reader's input. Arriving at
  // the end by itself never resumes follow: a pin already in flight when the
  // reader left (a new message starting) lands there and must not take them back.
  useLeaveLiveEdgeOnScroll(listRef, liveFollow, onLeave, onReturn);
  const followSignal = props.followSignal ?? 0;
  useEffect(() => {
    if (followSignal === 0) return;
    setLiveFollow(true);
    void listRef.current?.scrollToEnd({ animated: false });
  }, [followSignal, listRef]);
  const composerInset = props.composerInset ?? 0;
  const jumpToEnd = () => {
    const list = listRef.current;
    const node = list?.getScrollableNode();
    if (!list || !node) return;
    notifyTimelinePageScroll(node, "End");
    void list.scrollToEnd({ animated: false });
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* The header and docked composer sit outside the list, so its edges fade instead of cutting text. */}
      <div className="relative flex min-h-0 flex-1 flex-col [mask-image:linear-gradient(to_bottom,transparent,black_1.25rem,black_calc(100%-0.75rem),transparent)]">
        <MessagesTimeline
          isWorking={props.busy}
          activeTurnStartedAt={props.busy ? (timeline.latestTurn?.startedAt ?? null) : null}
          listRef={listRef}
          timelineEntries={timeline.entries}
          latestTurn={timeline.latestTurn}
          runningTurnId={timeline.runningTurnId}
          turnDiffSummaries={NO_TURN_DIFFS}
          routeThreadKey={props.timelineKey}
          onOpenTurnDiff={noop}
          supportsConversationRollback={false}
          onRevertToTurnCount={noop}
          isRevertingCheckpoint={false}
          onImageExpand={props.onImageExpand}
          activeThreadEnvironmentId={props.environmentId}
          markdownCwd={props.cwd}
          resolvedTheme={resolvedTheme}
          timestampFormat={settings.timestampFormat}
          workspaceRoot={props.cwd}
          anchorMessageId={null}
          onAnchorReady={noop}
          contentInsetEndAdjustment={composerInset}
          liveFollowEnabled={liveFollow}
          onIsAtEndChange={setIsAtEnd}
          onManualNavigation={onLeave}
          loadEarlier={props.loadEarlier}
          {...(props.assistantName ? { assistantName: props.assistantName } : {})}
          {...(props.queuedMessages ? { queuedMessages: props.queuedMessages } : {})}
          {...(props.onSteerQueuedMessage
            ? { onSteerQueuedMessage: props.onSteerQueuedMessage }
            : {})}
          {...(props.onRemoveQueuedMessage
            ? { onRemoveQueuedMessage: props.onRemoveQueuedMessage }
            : {})}
          {...(props.toggleToolOutputSerial === undefined
            ? {}
            : { toggleToolOutputSerial: props.toggleToolOutputSerial })}
        />
      </div>
      {!liveFollow && !isAtEnd && (
        <ScrollToEndButton bottom={composerInset + 4} onClick={jumpToEnd} />
      )}
    </div>
  );
}

/** Timeline key for a native file: unique per file, never a parseable scoped thread key. */
export function nativeTimelineKey(environmentId: string, sessionFile: string): string {
  return `native|${environmentId}|${sessionFile}`.replaceAll(":", "_");
}
