import { workspaceKey, workspaceResourceId } from "@t3tools/client-runtime/environment";
import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
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
import ThreadTerminalDrawer from "../ThreadTerminalDrawer";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { confirmTerminalClose } from "~/lib/terminalCloseConfirm";

export interface NativeSessionTerminalHandle {
  newTerminal: () => void;
  splitTerminal: (direction?: "horizontal" | "vertical") => void;
  closeActiveTerminal: () => void;
}

export interface NativeSessionTerminalProps {
  readonly target: NativeSessionTarget;
  /** Authoritative cwd from the live native session. */
  readonly cwd: string;
  readonly visible?: boolean;
  readonly mode?: "drawer" | "panel";
  readonly keybindings: ResolvedKeybindingsConfig;
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

function NativeSessionTerminalBody({
  target,
  cwd,
  visible = true,
  mode = "drawer",
  keybindings,
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
  const [hasOpened, setHasOpened] = useState(visible);

  const synchronizeVisibility = useEffectEvent((open: boolean) => {
    if (open) setHasOpened(true);
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
    (kind: "new" | "horizontal" | "vertical") => {
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
        else panels.splitTerminal(target, surface.id, terminalId, kind);
      } else if (kind === "new") store.newTerminal(target, terminalId);
      else if (kind === "vertical") store.splitTerminalVertical(target, terminalId);
      else store.splitTerminal(target, terminalId);
      setLocalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId: target.environmentId,
        input: { threadId, terminalId, cwd, providerInstanceId: target.ref.providerInstanceId },
      });
    },
    [cwd, openTerminal, sessions, target, threadId, panelIds, surface],
  );

  const removeTerminal = useCallback(
    (terminalId: string) => {
      void (async () => {
        const result = await closeTerminal({
          environmentId: target.environmentId,
          input: { threadId, terminalId, deleteHistory: true },
        });
        if (result._tag === "Failure") return;
        useTerminalUiStateStore.getState().closeTerminal(target, terminalId);
        if (surface) useRightPanelStore.getState().closeTerminal(target, surface.id, terminalId);
        setLocalFocusRequestId((value) => value + 1);
      })();
    },
    [closeTerminal, target, threadId, surface],
  );

  useImperativeHandle(
    controllerRef,
    () => ({
      newTerminal: () => createTerminal("new"),
      splitTerminal: (direction = "horizontal") => createTerminal(direction),
      closeActiveTerminal: () => {
        void confirmTerminalClose([labels.get(activeTerminalId) ?? activeTerminalId]).then(
          (confirmed) => {
            if (confirmed) removeTerminal(activeTerminalId);
          },
        );
      },
    }),
    [activeTerminalId, createTerminal, removeTerminal, labels],
  );

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
        focusRequestId={focusRequestId + localFocusRequestId}
        onSplitTerminal={() => createTerminal("horizontal")}
        onSplitTerminalVertical={() => createTerminal("vertical")}
        onNewTerminal={() => createTerminal("new")}
        onActiveTerminalChange={(terminalId) => {
          if (surface)
            useRightPanelStore.getState().activateTerminal(target, surface.id, terminalId);
          else useTerminalUiStateStore.getState().setActiveTerminal(target, terminalId);
          setLocalFocusRequestId((value) => value + 1);
        }}
        onCloseTerminal={removeTerminal}
        onHeightChange={(height) =>
          useTerminalUiStateStore.getState().setTerminalHeight(target, height)
        }
        {...(onAddTerminalContext ? { onAddTerminalContext } : {})}
        terminalLabelsById={labels}
        terminalLaunchLocationsById={locations}
        keybindings={keybindings}
        {...shortcutLabels}
      />
    </div>
  );
}
