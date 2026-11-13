import type { LegendListRef } from "@legendapp/list/react";
import type { EnvironmentId, NeoPiNativeSessionRef, ThreadId } from "@t3tools/contracts";
import type { TranscriptRow } from "@t3tools/client-runtime/neopi-transcript";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { useStableCallback } from "../../hooks/useStableCallback";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { useLeaveLiveEdgeOnScroll } from "../chat/useLeaveLiveEdgeOnScroll";
import { projectNativeTimeline, type NativeQueuedMessage } from "./nativeTimeline";
import { NativeQueuedMessages } from "./NativeQueuedMessages";

const NO_TURN_DIFFS: [] = [];
const NO_RUNS: [] = [];
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
  readonly nativeRef?: NeoPiNativeSessionRef;
  /** Stable per native file; must not parse as a scoped thread key. */
  readonly timelineKey: string;
  readonly cwd: string | undefined;
  readonly listRef?: RefObject<LegendListRef | null>;
  readonly loadEarlier: {
    readonly loading: boolean;
    readonly onLoadEarlier: () => void;
  } | null;
  readonly followSignal?: number;
  /** Height of a composer that overlays the list bottom (thread view); 0 when docked below. */
  readonly composerInset?: number;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly queuedMessages?: ReadonlyArray<NativeQueuedMessage>;
  readonly onSteerQueuedMessage?: (id: string) => void;
  readonly onRemoveQueuedMessage?: (id: string) => void;
  /** Drops NeoPi's reasoning blocks from the view; the journal keeps them. */
  readonly hideThinking?: boolean;
  /** Each new value toggles every tool call of the latest turn open or closed. */
  readonly toggleToolOutputSerial?: number;
}) {
  const settings = useEnvironmentSettings(props.environmentId);
  const navigate = useNavigate();
  const onOpenThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };
  const { resolvedTheme } = useTheme();
  const localListRef = useRef<LegendListRef | null>(null);
  const listRef = props.listRef ?? localListRef;
  const visibleRows = props.hideThinking
    ? props.rows.filter((row) => row.kind !== "thinking")
    : props.rows;
  const timeline = projectNativeTimeline(visibleRows, props.busy);
  const followSignal = props.followSignal ?? 0;
  const [pausedSignal, setPausedSignal] = useState<number | null>(null);
  const liveFollow = pausedSignal !== followSignal;
  const onIsAtEndChange = (atEnd: boolean) => {
    if (atEnd) setPausedSignal(null);
  };
  const onManualNavigation = useStableCallback(() => setPausedSignal(followSignal));
  // Nothing else tells this view the reader scrolled up, and the list re-pins
  // to the end on every layout while follow is on.
  useLeaveLiveEdgeOnScroll(listRef, onManualNavigation);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes a send's follow signal with the imperative timeline scroll position
  useEffect(() => {
    if (followSignal === 0) return;
    void listRef.current?.scrollToEnd({ animated: false });
  }, [followSignal, listRef]);
  return (
    // The header and docked composer sit outside the list, so its edges fade instead of cutting text.
    <div className="relative flex min-h-0 flex-1 flex-col [mask-image:linear-gradient(to_bottom,transparent,black_1.25rem,black_calc(100%-0.75rem),transparent)]">
      <MessagesTimeline
        isWorking={props.busy}
        activeTurnStartedAt={props.busy ? (timeline.latestRun?.startedAt ?? null) : null}
        listRef={listRef}
        timelineEntries={timeline.entries}
        latestRun={timeline.latestRun}
        runningRunId={timeline.runningRunId}
        turnDiffSummaries={NO_TURN_DIFFS}
        routeThreadKey={props.timelineKey}
        onOpenThread={onOpenThread}
        runs={NO_RUNS}
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
        onAnchorSizeChanged={noop}
        emptyPlaceholderInset={props.composerInset ?? 0}
        contentInsetEndAdjustment={props.composerInset ?? 0}
        liveFollowEnabled={liveFollow}
        onIsAtEndChange={onIsAtEndChange}
        historyControls={
          props.loadEarlier
            ? { ...props.loadEarlier, hasMoreHistory: true, error: null }
            : undefined
        }
        {...(props.nativeRef ? { nativeRef: props.nativeRef } : {})}
        {...(props.assistantName ? { assistantName: props.assistantName } : {})}
        footer={
          <NativeQueuedMessages
            messages={props.queuedMessages ?? []}
            onSendNow={props.onSteerQueuedMessage}
            onWithdraw={props.onRemoveQueuedMessage}
          />
        }
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
