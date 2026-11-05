import { useAtomValue } from "@effect/atom-react";
import {
  nativeSessionKey,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { isElectron } from "../../env";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import {
  cancelNativeSessionSwitcher,
  commitNativeSessionSwitcher,
  stepNativeSessionSwitcher,
  useNativeSessionSwitcher,
} from "../../state/nativeSessionSwitcher";
import {
  closeNativeSession,
  moveNativeSession,
  nativeSessionAtoms,
  selectNativeSession,
  useNativeSessionSelection,
} from "../../state/neopiNativeSessions";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { SortableTab, SortableTabs } from "../SortableTabs";
import { Button } from "../ui/button";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { TAB_BASELINE_CLASS } from "../ui/tab";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useCreateNativeSession } from "./NativeSessionSidebar";
import { NativeSessionSwitcher } from "./NativeSessionSwitcher";
import { useNativeSessionTabPresentation } from "./useNativeSessionTabPresentation";

function NativeSessionTab({
  tab,
  active,
  watched,
}: {
  readonly tab: NativeSessionTarget;
  readonly active: boolean;
  readonly watched: boolean;
}) {
  const { title, identity, status, cwd } = useNativeSessionTabPresentation(tab, watched);
  const close = () => closeNativeSession(tab);
  return (
    <SortableTab
      id={nativeSessionKey(tab)}
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
          <span className="truncate text-3xs leading-3 text-muted-foreground">
            {identity.label}
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          <div className="flex max-w-80 flex-col gap-0.5">
            <span className="break-words">{title}</span>
            <span className="text-muted-foreground">
              {identity.label} · {identity.pronouns}
            </span>
            {cwd ? <span className="break-all text-muted-foreground">{cwd}</span> : null}
            <span className="text-muted-foreground">{status.label}</span>
          </div>
        </TooltipPopup>
      </Tooltip>
    </SortableTab>
  );
}

/**
 * Ctrl+Tab and Ctrl+Shift+Tab by default, in recently-used order: each press
 * steps the switcher while the modifier is held and releasing it commits.
 * Capture phase: the composer consumes Tab itself.
 */
function useNativeSessionTabShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    // The modifiers that were down when the switcher opened; letting go of any commits.
    let held = { ctrl: false, meta: false, alt: false };
    const onKeyDown = (event: KeyboardEvent) => {
      if (useNativeSessionSwitcher.getState().order && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelNativeSessionSwitcher();
        return;
      }
      if (event.isComposing || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "sessionTab.next" && command !== "sessionTab.previous") return;
      if (!stepNativeSessionSwitcher(command === "sessionTab.next" ? "next" : "previous")) return;
      event.preventDefault();
      event.stopPropagation();
      held = { ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey };
      // A binding without a modifier has no release to wait for.
      if (!held.ctrl && !held.meta && !held.alt) commitNativeSessionSwitcher();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!useNativeSessionSwitcher.getState().order) return;
      if (
        (held.ctrl && !event.ctrlKey) ||
        (held.meta && !event.metaKey) ||
        (held.alt && !event.altKey)
      )
        commitNativeSessionSwitcher();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", cancelNativeSessionSwitcher);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", cancelNativeSessionSwitcher);
      cancelNativeSessionSwitcher();
    };
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
  const tabIds = useMemo(() => tabs.map(nativeSessionKey), [tabs]);
  const onMove = useCallback(
    (id: string, toIndex: number) => {
      const moving = tabs.find((tab) => nativeSessionKey(tab) === id);
      if (moving) moveNativeSession(moving, toIndex);
    },
    [tabs],
  );
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
        <SortableTabs ids={tabIds} onMove={onMove}>
          {tabs.map((tab) => {
            const key = nativeSessionKey(tab);
            const active = key === activeKey;
            return (
              <NativeSessionTab
                key={key}
                tab={tab}
                active={active}
                watched={active || nativeSessionAtoms.cached(tab) !== undefined}
              />
            );
          })}
        </SortableTabs>
      </div>
      <Button
        aria-label="New thread"
        className="mb-1 shrink-0 self-end"
        size="icon-xs"
        variant="ghost-muted"
        onClick={() =>
          void create().catch((cause) => toastManager.add({ type: "error", title: String(cause) }))
        }
      >
        <PlusIcon className="size-3.5" />
      </Button>
      <div ref={actionsRef} className="ml-auto flex shrink-0 items-center" />
      <NativeSessionSwitcher />
    </WorkspacePageHeader>
  );
}
