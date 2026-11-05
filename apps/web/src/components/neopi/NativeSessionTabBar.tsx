import { useAtomValue } from "@effect/atom-react";
import {
  nativeRecord,
  nativeSessionKey,
  type NativeSessionFeed,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { agentIdentity, nativeSessionIdentityKey } from "@t3tools/shared/agentNames";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { isElectron } from "../../env";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import {
  closeNativeSession,
  cycleNativeSession,
  nativeSessionAtoms,
  selectNativeSession,
  useNativeSessionSelection,
} from "../../state/neopiNativeSessions";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { Tab, TAB_BASELINE_CLASS } from "../ui/tab";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useCreateNativeSession } from "./NativeSessionSidebar";

const TAB_STATUS = {
  attention: { label: "Waiting for your answer", dot: "bg-primary" },
  working: { label: "Working", dot: "bg-warning" },
  terminal: { label: "Following a terminal", dot: "bg-info" },
  ready: { label: "Ready", dot: "bg-success" },
  connecting: { label: "Connecting", dot: "bg-muted-foreground/50" },
  offline: { label: "Reconnecting · showing cached conversation", dot: "bg-muted-foreground/50" },
  // Background tabs show inventory status without holding a native observation open.
  idle: { label: "Not connected", dot: "bg-muted-foreground/30" },
} as const;
type TabStatus = keyof typeof TAB_STATUS;
const LISTED_TAB_STATUS = { busy: "working", waiting: "attention", idle: "ready" } as const;

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

function NativeSessionTab({
  tab,
  active,
}: {
  readonly tab: NativeSessionTarget;
  readonly active: boolean;
}) {
  const listedSessions = useEnvironmentQuery(
    nativeSessionAtoms.list({ environmentId: tab.environmentId, input: {} }),
  ).data?.sessions;
  const feed: Atom.Atom<FeedResult> = active
    ? nativeSessionAtoms.watch({ environmentId: tab.environmentId, input: { ref: tab.ref } })
    : UNWATCHED;
  const watchedStatus = useAtomValue(feed, selectStatus);
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
  const status =
    TAB_STATUS[
      active ? watchedStatus : listed?.live ? LISTED_TAB_STATUS[listed.live.state] : "idle"
    ];
  const title =
    listed?.title || sessionName || listed?.firstMessage.split("\n")[0]?.trim() || "New session";
  const identity = agentIdentity(
    nativeSessionIdentityKey({
      sessionId: sessionId || listed?.sessionId,
      sessionFile: tab.ref.sessionFile,
    }),
  );
  const close = () => closeNativeSession(tab);
  return (
    <Tab
      active={active}
      className="[-webkit-app-region:no-drag]"
      onMouseDown={(event) => {
        // Keeps the browser's middle-click autoscroll from taking the gesture.
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        close();
      }}
    >
      <PanelTabCloseButton label={`Close ${title} (${identity.label})`} onClick={close}>
        <span
          role="img"
          aria-label={status.label}
          className={cn("size-2 shrink-0 rounded-full", status.dot)}
        />
      </PanelTabCloseButton>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              className="flex min-w-0 cursor-pointer flex-col text-left"
              onClick={() => selectNativeSession(tab)}
            />
          }
        >
          <span className="truncate">{title}</span>
          <span className="truncate text-3xs text-muted-foreground">{identity.label}</span>
        </TooltipTrigger>
        <TooltipPopup>
          <div className="flex max-w-80 flex-col gap-0.5">
            <span className="break-words">{title}</span>
            <span className="text-muted-foreground">
              {identity.label} · {identity.pronouns}
            </span>
            {listed?.cwd ? (
              <span className="break-all text-muted-foreground">{listed.cwd}</span>
            ) : null}
            <span className="text-muted-foreground">{status.label}</span>
          </div>
        </TooltipPopup>
      </Tooltip>
    </Tab>
  );
}

/** Ctrl+Tab and Ctrl+Shift+Tab by default. Capture phase: the composer consumes Tab itself. */
function useNativeSessionTabShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "sessionTab.next" && command !== "sessionTab.previous") return;
      if (!cycleNativeSession(command === "sessionTab.next" ? "next" : "previous")) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings]);
}

/**
 * The open sessions as tabs, in the workspace's title bar. The session's own
 * actions portal into `actionsRef`'s slot at the trailing edge.
 */
export function NativeSessionTabBar({
  actionsRef,
}: {
  readonly actionsRef: (element: HTMLDivElement | null) => void;
}) {
  useNativeSessionTabShortcuts();
  const tabs = useNativeSessionSelection((state) => state.tabs);
  const target = useNativeSessionSelection((state) => state.target);
  const create = useCreateNativeSession();
  const listRef = useRef<HTMLDivElement>(null);
  const activeKey = target ? nativeSessionKey(target) : null;
  useEffect(() => {
    if (activeKey === null) return;
    listRef.current
      ?.querySelector<HTMLElement>("[data-active-tab='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // A wheel has no horizontal axis; let it scroll the tabs.
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const before = list.scrollLeft;
      list.scrollLeft +=
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      if (list.scrollLeft !== before) event.preventDefault();
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <WorkspacePageHeader
      electron={isElectron}
      className={cn("gap-1", TAB_BASELINE_CLASS)}
      data-session-tab-bar
    >
      <div
        ref={listRef}
        className="flex min-w-0 items-end gap-1 self-stretch overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const key = nativeSessionKey(tab);
          const active = key === activeKey;
          return <NativeSessionTab key={key} tab={tab} active={active} />;
        })}
      </div>
      <Button
        aria-label="New thread"
        className="mb-1.5 shrink-0 self-end"
        size="icon-xs"
        variant="ghost-muted"
        onClick={() =>
          void create().catch((cause) => toastManager.add({ type: "error", title: String(cause) }))
        }
      >
        <PlusIcon className="size-3.5" />
      </Button>
      <div ref={actionsRef} className="ml-auto flex shrink-0 items-center" />
    </WorkspacePageHeader>
  );
}
