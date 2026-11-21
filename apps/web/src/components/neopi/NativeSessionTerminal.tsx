import { workspaceKey, workspaceResourceId } from "@t3tools/client-runtime/environment";
import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import { MANAGED_TMUX_TERMINAL_ID } from "@t3tools/contracts";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useState,
  type Ref,
} from "react";
import type { TerminalContextSelection } from "~/lib/terminalContext";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { terminalEnvironment } from "~/state/terminal";
import { useAtomCommand } from "~/state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";
import ThreadTerminalDrawer, { TerminalViewport } from "../ThreadTerminalDrawer";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { confirmTerminalClose } from "~/lib/terminalCloseConfirm";
import { closeNativeTerminal } from "./closeNativeTerminal";

interface TerminalSplitOptions {
  readonly focusNewTerminal?: boolean;
  readonly reveal?: boolean;
}

export interface NativeSessionTerminalHandle {
  newTerminal: () => void;
  splitTerminal: (direction?: "horizontal" | "vertical", options?: TerminalSplitOptions) => void;
  closeActiveTerminal: () => void;
  /** Closes one terminal after the same confirmation `closeActiveTerminal` asks for. */
  closeTerminal: (terminalId: string) => void;
}

export interface NativeSessionTerminalProps {
  readonly target: NativeSessionTarget;
  /** Authoritative cwd from the live native session. */
  readonly cwd: string;
  readonly visible?: boolean;
  readonly mode?: "drawer" | "panel";
  readonly focusRequestId?: number;
  readonly onAddTerminalContext?: (selection: TerminalContextSelection) => void;
  readonly splitShortcutLabel?: string | undefined;
  readonly splitVerticalShortcutLabel?: string | undefined;
  readonly newShortcutLabel?: string | undefined;
  readonly closeShortcutLabel?: string | undefined;
  readonly surface?: Extract<RightPanelSurface, { kind: "terminal" }>;
  readonly controllerRef?: Ref<NativeSessionTerminalHandle>;
}

/** A native workspace uses the stock drawer and PTY lifecycle, never SQL session state. */
export function NativeSessionTerminal(props: NativeSessionTerminalProps) {
  return <NativeSessionTerminalBody key={workspaceKey(props.target)} {...props} />;
}

/** Mounting the TUI subscribes to its client PTY; unmounting detaches only that client. */
export function NativeManagedTuiView({
  target,
  cwd,
  monitor,
  onSessionExited,
}: {
  target: NativeSessionTarget;
  cwd: string;
  monitor?: { readonly agentId: string; readonly viewId: string };
  onSessionExited?: () => void;
}) {
  return (
    <section
      aria-label={monitor ? "Managed NeoPi agent monitor" : "Managed NeoPi TUI"}
      data-thread-terminal-drawer
      className={
        monitor
          ? "relative min-h-0 flex-1 overflow-hidden"
          : "relative h-[min(40dvh,24rem)] shrink-0 overflow-hidden border-t border-border"
      }
    >
      <TerminalViewport
        advancedTypography={false}
        threadRef={target}
        terminalId={MANAGED_TMUX_TERMINAL_ID}
        terminalLabel={monitor ? "NeoPi Monitor" : "NeoPi TUI"}
        managedTmux={monitor ? { ...target.ref, monitor } : target.ref}
        cwd={cwd}
        onSessionExited={onSessionExited ?? (() => {})}
        focusRequestId={0}
        autoFocus
        visible
        resizeEpoch={0}
        drawerHeight={0}
      />
    </section>
  );
}

function NativeSessionTerminalBody({
  target,
  cwd,
  visible = true,
  mode = "drawer",
  focusRequestId = 0,
  onAddTerminalContext,
  surface,
  controllerRef,
  ...shortcutLabels
}: NativeSessionTerminalProps) {
  const threadId = useMemo(() => workspaceResourceId(target), [target]);
  const ui = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, target),
  );
  const sessions = useKnownTerminalSessions({ environmentId: target.environmentId, threadId });
  const panelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, target),
  );
  const panelIds = useMemo(
    () =>
      new Set(
        panelState.surfaces.flatMap((item) => (item.kind === "terminal" ? item.terminalIds : [])),
      ),
    [panelState.surfaces],
  );
  const terminalIds = surface?.terminalIds ?? ui.terminalIds.filter((id) => !panelIds.has(id));
  const activeTerminalId =
    surface?.activeTerminalId ??
    (terminalIds.includes(ui.activeTerminalId)
      ? ui.activeTerminalId
      : (terminalIds[0] ?? ui.activeTerminalId));
  const terminalGroups = surface
    ? [
        {
          id: surface.id,
          terminalIds: surface.terminalIds,
          ...(surface.splitDirection ? { splitDirection: surface.splitDirection } : {}),
        },
      ]
    : ui.terminalGroups.flatMap((group) => {
        const ids = group.terminalIds.filter((id) => !panelIds.has(id));
        return ids.length ? [{ ...group, terminalIds: ids }] : [];
      });
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "terminal close");
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const [autoFocus, setAutoFocus] = useState(true);
  const requestFocus = useCallback(() => {
    setAutoFocus(true);
    setLocalFocusRequestId((value) => value + 1);
  }, []);
  const [hasOpened, setHasOpened] = useState(visible);

  const synchronizeVisibility = useEffectEvent((open: boolean) => {
    if (open) setHasOpened(true);
    else setAutoFocus(true);
    if (!surface) useTerminalUiStateStore.getState().setTerminalOpen(target, open);
  });
  useEffect(() => {
    synchronizeVisibility(visible);
  }, [visible]);

  useEffect(() => {
    if (surface) return;
    const serverIds = sessions
      .map((session) => session.target.terminalId)
      .filter((id) => !panelIds.has(id));
    // Metadata can lag a freshly allocated shell. Keep optimistic local ids
    // until the server has caught up; explicit closes have store tombstones.
    const localIds = ui.terminalIds;
    if (serverIds.every((id) => localIds.includes(id))) return;
    useTerminalUiStateStore.getState().reconcileTerminalIds(target, serverIds);
  }, [sessions, target, ui.terminalIds, panelIds, surface]);

  const labels = useMemo(
    () =>
      new Map(
        sessions.map((session) => [
          session.target.terminalId,
          resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
        ]),
      ),
    [sessions],
  );
  const locations = useMemo(
    () =>
      new Map(
        sessions.flatMap((session) =>
          session.state.summary
            ? [
                [
                  session.target.terminalId,
                  {
                    cwd: session.state.summary.cwd,
                    worktreePath: session.state.summary.worktreePath,
                  },
                ] as const,
              ]
            : [],
        ),
      ),
    [sessions],
  );

  const createTerminal = useCallback(
    (kind: "new" | "horizontal" | "vertical", options?: TerminalSplitOptions) => {
      const { focusNewTerminal = true, reveal = true } = options ?? {};
      const store = useTerminalUiStateStore.getState();
      const current = selectThreadTerminalUiState(store.terminalUiStateByThreadKey, target);
      const terminalId = nextTerminalId([
        ...current.terminalIds,
        ...sessions.map((session) => session.target.terminalId),
        ...panelIds,
      ]);
      if (surface) {
        const panels = useRightPanelStore.getState();
        if (kind === "new") panels.openTerminal(target, terminalId);
        else
          panels.splitTerminal(target, surface.id, terminalId, kind, {
            activate: focusNewTerminal,
            reveal,
          });
      } else if (kind === "new") store.newTerminal(target, terminalId);
      else if (kind === "vertical")
        store.splitTerminalVertical(target, terminalId, focusNewTerminal);
      else store.splitTerminal(target, terminalId, focusNewTerminal);
      if (focusNewTerminal) requestFocus();
      else if (reveal) setAutoFocus(false);
      void openTerminal({
        environmentId: target.environmentId,
        input: { threadId, terminalId, cwd, providerInstanceId: target.ref.providerInstanceId },
      });
    },
    [cwd, openTerminal, sessions, target, threadId, panelIds, surface, requestFocus],
  );

  const removeTerminal = useCallback(
    (terminalId: string) => {
      void (async () => {
        const result = await closeNativeTerminal({
          close: closeTerminal,
          target,
          threadId,
          terminalId,
          surfaceId: surface?.id ?? null,
        });
        if (result._tag === "Failure") return;
        requestFocus();
      })();
    },
    [closeTerminal, target, threadId, surface?.id, requestFocus],
  );

  useImperativeHandle(controllerRef, () => {
    const confirmAndClose = (terminalId: string) => {
      void confirmTerminalClose([labels.get(terminalId) ?? terminalId]).then((confirmed) => {
        if (confirmed) removeTerminal(terminalId);
      });
    };
    return {
      newTerminal: () => createTerminal("new"),
      splitTerminal: (direction = "horizontal", options) => createTerminal(direction, options),
      closeActiveTerminal: () => confirmAndClose(activeTerminalId),
      closeTerminal: confirmAndClose,
    };
  }, [activeTerminalId, createTerminal, removeTerminal, labels]);

  if (!hasOpened && !visible) return null;
  return (
    <div className={visible ? "contents" : "hidden"}>
      <ThreadTerminalDrawer
        mode={mode}
        threadRef={target}
        cwd={cwd}
        visible={visible}
        height={ui.terminalHeight}
        terminalIds={terminalIds}
        activeTerminalId={activeTerminalId}
        terminalGroups={terminalGroups}
        activeTerminalGroupId={surface?.id ?? ui.activeTerminalGroupId}
        autoFocus={autoFocus}
        focusRequestId={focusRequestId + localFocusRequestId}
        onSplitTerminal={() => createTerminal("horizontal")}
        onSplitTerminalVertical={() => createTerminal("vertical")}
        onNewTerminal={() => createTerminal("new")}
        onActiveTerminalChange={(terminalId) => {
          if (surface)
            useRightPanelStore.getState().activateTerminal(target, surface.id, terminalId);
          else useTerminalUiStateStore.getState().setActiveTerminal(target, terminalId);
          requestFocus();
        }}
        onCloseTerminal={removeTerminal}
        onHeightChange={(height) =>
          useTerminalUiStateStore.getState().setTerminalHeight(target, height)
        }
        {...(onAddTerminalContext ? { onAddTerminalContext } : {})}
        terminalLabelsById={labels}
        terminalLaunchLocationsById={locations}
        {...shortcutLabels}
      />
    </div>
  );
}
