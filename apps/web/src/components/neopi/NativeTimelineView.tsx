import type { LegendListRef } from "@legendapp/list/react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { TranscriptRow } from "@t3tools/client-runtime/neopi-transcript";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import type { QueuedComposerMessage } from "../../queuedMessageStore";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import type { CitationHistoryPage } from "../chat/useAssistantCitationTarget";
import { useLeaveLiveEdgeOnScroll } from "../chat/useLeaveLiveEdgeOnScroll";
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
    () => projectNativeTimeline(visibleRows, props.busy),
    [visibleRows, props.busy],
  );
  const [liveFollow, setLiveFollow] = useState(true);
  const onIsAtEndChange = useCallback((atEnd: boolean) => {
    if (atEnd) setLiveFollow(true);
  }, []);
  const onManualNavigation = useCallback(() => setLiveFollow(false), []);
  // Nothing else tells this view the reader scrolled up, and the list re-pins
  // to the end on every layout while follow is on.
  useLeaveLiveEdgeOnScroll(listRef, onManualNavigation);
  const followSignal = props.followSignal ?? 0;
  useEffect(() => {
    if (followSignal === 0) return;
    setLiveFollow(true);
    void listRef.current?.scrollToEnd({ animated: false });
  }, [followSignal, listRef]);
  return (
    // The header and docked composer sit outside the list, so its edges fade instead of cutting text.
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
        contentInsetEndAdjustment={props.composerInset ?? 0}
        liveFollowEnabled={liveFollow}
        onIsAtEndChange={onIsAtEndChange}
        onManualNavigation={onManualNavigation}
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
  );
}

/** Timeline key for a native file: unique per file, never a parseable scoped thread key. */
export function nativeTimelineKey(environmentId: string, sessionFile: string): string {
  return `native|${environmentId}|${sessionFile}`.replaceAll(":", "_");
}
