import { workspaceKey, workspaceResourceId } from "@t3tools/client-runtime/environment";
import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { useEffect, useImperativeHandle, useState, type Ref } from "react";
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
import {
  focusActiveDrawerTerminal,
  focusActivePanelTerminal,
  focusTerminal,
} from "~/lib/terminalFocus";

const NO_TERMINAL_SESSIONS = [] as const;

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
  onAddTerminalContext,
  surface,
  controllerRef,
  ...shortcutLabels
}: NativeSessionTerminalProps) {
  const threadId = workspaceResourceId(target);
  const ui = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, target),
  );
  const sessions =
    useKnownTerminalSessions({ environmentId: target.environmentId, threadId }) ??
    NO_TERMINAL_SESSIONS;
  const panelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, target),
  );
  const panelIds = new Set(
    panelState.surfaces.flatMap((item) => (item.kind === "terminal" ? item.terminalIds : [])),
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
  const [hasOpened, setHasOpened] = useState(visible);

  if (visible && !hasOpened) setHasOpened(true);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes drawer visibility with the external terminal UI store
  useEffect(() => {
    if (!surface) useTerminalUiStateStore.getState().setTerminalOpen(target, visible);
  }, [target, visible, surface]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles server sessions without dropping optimistic local terminals
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

  const labels = new Map(
    sessions.map((session) => [
      session.target.terminalId,
      resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
    ]),
  );
  const locations = new Map(
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
  );

  const createTerminal = (kind: "new" | "horizontal" | "vertical") => {
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
    focusTerminal(target, terminalId);
    void openTerminal({
      environmentId: target.environmentId,
      input: { threadId, terminalId, cwd, providerInstanceId: target.ref.providerInstanceId },
    });
  };

  const removeTerminal = (terminalId: string) => {
    void (async () => {
      const result = await closeTerminal({
        environmentId: target.environmentId,
        input: { threadId, terminalId, deleteHistory: true },
      });
      if (result._tag === "Failure") return;
      useTerminalUiStateStore.getState().closeTerminal(target, terminalId);
      if (surface) useRightPanelStore.getState().closeTerminal(target, surface.id, terminalId);
      if (surface) focusActivePanelTerminal(target);
      else focusActiveDrawerTerminal(target);
    })();
  };

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
        onSplitTerminal={() => createTerminal("horizontal")}
        onSplitTerminalVertical={() => createTerminal("vertical")}
        onNewTerminal={() => createTerminal("new")}
        onActiveTerminalChange={(terminalId) => {
          if (surface)
            useRightPanelStore.getState().activateTerminal(target, surface.id, terminalId);
          else useTerminalUiStateStore.getState().setActiveTerminal(target, terminalId);
          focusTerminal(target, terminalId);
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
