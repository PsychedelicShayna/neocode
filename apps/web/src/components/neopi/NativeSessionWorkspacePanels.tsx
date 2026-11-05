import { useAtomValue } from "@effect/atom-react";
import { workspaceKey, workspaceResourceId } from "@t3tools/client-runtime/environment";
import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import {
  deriveAgentPanelModel,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PreviewAnnotationPayload, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import * as Arr from "effect/Array";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ComposerImageAttachment } from "~/composerDraftStore";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { requestConfirmDialog } from "~/confirmDialog";
import { isElectron } from "~/env";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { getTerminalFocusOwner } from "~/lib/terminalFocus";
import { isPreviewFocused } from "~/lib/previewFocus";
import { confirmTerminalClose, isTerminalCloseConfirmPending } from "~/lib/terminalCloseConfirm";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "~/lib/terminalCloseShortcut";
import type { TerminalContextSelection } from "~/lib/terminalContext";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "~/previewStateStore";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { useEnvironmentQuery } from "~/state/query";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { terminalEnvironment } from "~/state/terminal";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";
import { NativeAgentOverlay } from "./agents/NativeAgentOverlay";
import { NativeAgentsPanel } from "./agents/NativeAgentsPanel";
import { selectAgentView, useAgentViewStore } from "./agents/agentViewStore";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { RightPanelTabs } from "../RightPanelTabs";
import { RightPanelSheet } from "../RightPanelSheet";
import { PanelLayoutControls, RightPanelMaximizeControl } from "../chat/PanelLayoutControls";
import { Button } from "../ui/button";
import { addBrowserSurface } from "../preview/addBrowserSurface";
import { closePreviewSession } from "../preview/closePreviewSession";
import { subscribePreviewAction } from "../preview/previewActionBus";
import { ThreadPreviewMiniPlayer } from "../preview/ThreadPreviewMiniPlayer";
import { usePreviewSession } from "../preview/usePreviewSession";
import { NativeBackgroundTasksPanel } from "./NativeBackgroundTasksPanel";
import { NativeSessionTerminal, type NativeSessionTerminalHandle } from "./NativeSessionTerminal";
import { isNativeSessionCommand, type NativeSessionCommand } from "./nativeSessionShortcuts";

/** Escape belongs to these while one is open; it must not also interrupt the turn. */
const ESCAPE_OWNING_OVERLAYS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
  "[data-composer-stash-drawer]",
].join(",");
import { NativeSessionTreePanel } from "./NativeSessionTreePanel";

const PreviewPanel = lazy(() =>
  import("../preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const FilePreviewPanel = lazy(() => import("../files/FilePreviewPanel"));
const DiffPanel = lazy(() => import("../DiffPanel"));
const DevicePanel = lazy(() =>
  import("../device/DevicePanel").then((module) => ({ default: module.DevicePanel })),
);

/** Only workspace presentation lives here. Conversation, execution and native connection ownership stay in the feed. */
export function NativeSessionWorkspacePanels({
  target,
  cwd,
  agents,
  keybindings,
  composerRef,
  composerOverlayElement,
  workspaceMutationId,
  onAddTerminalContext,
  onSendAnnotation,
  onOpenTree,
  request,
  execute,
  onTreeNavigated,
  onOpenModels,
  onInterrupt,
  onNativeCommand,
  busy,
  onToggleDictation,
  dictationActive,
  children,
}: {
  target: NativeSessionTarget;
  cwd: string | null;
  agents: readonly RuntimeSubagent[];
  keybindings: ResolvedKeybindingsConfig;
  composerRef: RefObject<ChatComposerHandle | null>;
  composerOverlayElement: HTMLElement | null;
  workspaceMutationId: string | null;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onSendAnnotation: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
  onOpenTree: () => void;
  /** Plain native reads and session-changing commands for the tree surface. */
  request: (command: Record<string, unknown> & { type: string }) => Promise<unknown>;
  execute: (command: Record<string, unknown> & { type: string }) => Promise<unknown>;
  onTreeNavigated: (result: Record<string, unknown>) => void;
  onOpenModels: () => void;
  onInterrupt: () => void;
  /** Runs a keybinding command that only the native session implements. */
  onNativeCommand: (command: NativeSessionCommand) => void;
  busy: boolean;
  /** Absent when this client cannot use the microphone NeoPi records from. */
  onToggleDictation: (() => void) | undefined;
  /** Escape cancels a capture before it interrupts the running turn. */
  dictationActive: boolean;
  children: ReactNode;
}) {
  const key = workspaceKey(target);
  const agentViewMode = useAgentViewStore((store) => selectAgentView(key)(store).mode);
  const agentViewActive = agentViewMode !== "session";
  const agentViewWasActive = useRef(false);
  useEffect(() => {
    // The session view was inert behind the hub or an agent; hand the keyboard back to the prompt.
    if (agentViewWasActive.current && !agentViewActive) composerRef.current?.focusAtEnd();
    // The stash drawer portals out of the inert session view; do not leave it over the hub.
    if (!agentViewWasActive.current && agentViewActive) composerRef.current?.dismissMenus();
    agentViewWasActive.current = agentViewActive;
  }, [agentViewActive, composerRef]);
  const resourceId = workspaceResourceId(target);
  // Remains subscribed even when the browser has moved to its floating surface.
  usePreviewSession(target);
  const preview = useThreadPreviewState(target);
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, target),
  );
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, target),
  );
  const terminalUi = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, target),
  );
  const sessions = useKnownTerminalSessions({
    environmentId: target.environmentId,
    threadId: resourceId,
  });
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
  const agentModel = useMemo(() => deriveAgentPanelModel({ agents }), [agents]);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const gitStatus = useEnvironmentQuery(
    cwd ? vcsEnvironment.status({ environmentId: target.environmentId, input: { cwd } }) : null,
  );
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<ReadonlySet<string>>(new Set());
  const [maximized, setMaximized] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const drawerRef = useRef<NativeSessionTerminalHandle | null>(null);
  const panelRef = useRef<NativeSessionTerminalHandle | null>(null);
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const activeSurface =
    panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ??
    panel.surfaces[0] ??
    null;

  const pendingSurfaceIds = useMemo(
    () =>
      new Set(
        panel.surfaces
          .filter((surface) => surface.kind === "file" && pendingFiles.has(surface.relativePath))
          .map((surface) => surface.id),
      ),
    [panel.surfaces, pendingFiles],
  );

  const report = useCallback(
    (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    [],
  );
  const createBrowser = useCallback(
    (profileId?: string) => {
      void addBrowserSurface({
        threadRef: target,
        openPreview,
        ...(profileId ? { profileId } : {}),
      }).then((result) => {
        if (result._tag === "Failure") report(squashAtomCommandFailure(result));
      }, report);
    },
    [target, openPreview, report],
  );
  const createTerminal = useCallback(() => {
    if (!cwd) return;
    const terminalId = nextTerminalId([
      ...terminalUi.terminalIds,
      ...sessions.map((session) => session.target.terminalId),
      ...panel.surfaces.flatMap((surface) =>
        surface.kind === "terminal" ? surface.terminalIds : [],
      ),
    ]);
    useRightPanelStore.getState().openTerminal(target, terminalId);
    void openTerminal({
      environmentId: target.environmentId,
      input: {
        threadId: resourceId,
        terminalId,
        cwd,
        providerInstanceId: target.ref.providerInstanceId,
      },
    }).then((result) => {
      if (result._tag === "Failure") report(squashAtomCommandFailure(result));
    }, report);
  }, [
    cwd,
    target,
    terminalUi.terminalIds,
    sessions,
    panel.surfaces,
    openTerminal,
    resourceId,
    report,
  ]);

  const closeSurfaces = useCallback(
    async (surfaces: readonly RightPanelSurface[]) => {
      if (
        surfaces.some((surface) => pendingSurfaceIds.has(surface.id)) &&
        !(await requestConfirmDialog("Discard unsaved file changes?", { variant: "destructive" }))
      )
        return;
      const terminalIds = surfaces.flatMap((surface) =>
        surface.kind === "terminal" ? surface.terminalIds : [],
      );
      if (
        Arr.isArrayNonEmpty(terminalIds) &&
        !(await confirmTerminalClose(Arr.map(terminalIds, (id) => labels.get(id) ?? id)))
      )
        return;
      for (const surface of surfaces) {
        if (surface.kind === "preview" && surface.resourceId) {
          const result = await closePreviewSession({
            closePreview,
            threadRef: target,
            tabId: surface.resourceId,
            snapshot: preview.sessions[surface.resourceId] ?? null,
          });
          if (result._tag === "Failure") {
            report(squashAtomCommandFailure(result));
            continue;
          }
        }
        if (surface.kind === "terminal") {
          let failed = false;
          for (const terminalId of surface.terminalIds) {
            const result = await closeTerminal({
              environmentId: target.environmentId,
              input: { threadId: resourceId, terminalId, deleteHistory: true },
            });
            if (result._tag === "Failure") {
              report(squashAtomCommandFailure(result));
              failed = true;
            } else {
              useTerminalUiStateStore.getState().closeTerminal(target, terminalId);
              useRightPanelStore.getState().closeTerminal(target, surface.id, terminalId);
            }
          }
          if (failed) continue;
        }
        useRightPanelStore.getState().closeSurface(target, surface.id);
      }
    },
    [
      target,
      pendingSurfaceIds,
      labels,
      closePreview,
      preview.sessions,
      closeTerminal,
      resourceId,
      report,
    ],
  );

  useEffect(() => {
    if (preview.serverEpoch !== null)
      useRightPanelStore.getState().reconcileBrowserSurfaces(target, Object.keys(preview.sessions));
  }, [target, preview.serverEpoch, preview.sessions]);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") useRightPanelStore.getState().toggle(target, "preview");
      }),
    [target],
  );
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        preventRepeatedTerminalCloseShortcut(event, keybindings) ||
        (isTerminalCloseConfirmPending() && preventTerminalCloseShortcut(event, keybindings))
      ) {
        event.stopPropagation();
        return;
      }
      if (isCommandPaletteOpen()) return;
      const terminalFocus = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocus === null) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: terminalFocus !== null,
          terminalOpen: terminalUi.terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen: panel.isOpen && activeSurface?.kind === "preview",
          modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
          editableFocus:
            event.target instanceof HTMLElement &&
            Boolean(event.target.closest("input,textarea,select,[contenteditable=true]")),
          isWeb: !isElectron,
          isDesktop: isElectron,
          nativeSession: true,
          composerFocus:
            event.target instanceof HTMLElement &&
            event.target.closest("[data-composer-rich-text]") !== null,
        },
      });
      let action: (() => void) | null = null;
      const terminalController =
        terminalFocus === "right-panel" ? panelRef.current : drawerRef.current;
      switch (command) {
        case "terminal.toggle":
          action = () =>
            useTerminalUiStateStore.getState().setTerminalOpen(target, !terminalUi.terminalOpen);
          break;
        case "rightPanel.toggle":
          action = () => useRightPanelStore.getState().toggleVisibility(target);
          break;
        case "rightPanel.toggleMaximized":
          action = () => setMaximized((value) => !value);
          break;
        case "rightPanel.close":
          if (panel.isOpen && activeSurface) action = () => void closeSurfaces([activeSurface]);
          break;
        case "terminal.new":
          if (cwd)
            action = () => {
              if (terminalFocus === "right-panel") createTerminal();
              else {
                useTerminalUiStateStore.getState().setTerminalOpen(target, true);
                terminalController?.newTerminal();
              }
            };
          break;
        case "terminal.split":
        case "terminal.splitVertical":
          if (cwd)
            action = () => {
              if (terminalFocus !== "right-panel")
                useTerminalUiStateStore.getState().setTerminalOpen(target, true);
              terminalController?.splitTerminal(
                command === "terminal.splitVertical" ? "vertical" : "horizontal",
              );
            };
          break;
        case "terminal.close":
          if (terminalFocus || terminalUi.terminalOpen)
            action = () => terminalController?.closeActiveTerminal();
          break;
        case "diff.toggle":
          if (gitStatus.data?.isRepo)
            action = () => useRightPanelStore.getState().toggle(target, "diff");
          break;
        case "modelPicker.toggle":
          action = onOpenModels;
          break;
        case "composer.effort":
        case "composer.mode":
          action = () => composerRef.current?.openControl(command);
          break;
        case "composer.dictation.toggle":
          action = onToggleDictation ?? null;
          break;
        case "agents.panel.toggle":
          action = () => useRightPanelStore.getState().toggle(target, "agents");
          break;
        case "agents.hub.toggle":
          action = () => useAgentViewStore.getState().dispatch(key, { type: "toggleHub" });
          break;
        case "thread.stop":
          if (
            busy &&
            !dictationActive &&
            !event.isComposing &&
            !composerRef.current?.isMenuOpen() &&
            !document.querySelector(ESCAPE_OWNING_OVERLAYS)
          )
            action = onInterrupt;
          break;
        default:
          if (isNativeSessionCommand(command)) action = () => onNativeCommand(command);
          break;
      }
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) action();
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [
    target,
    keybindings,
    terminalUi.terminalOpen,
    panel.isOpen,
    activeSurface,
    composerRef,
    cwd,
    createTerminal,
    closeSurfaces,
    gitStatus.data?.isRepo,
    onOpenModels,
    onNativeCommand,
    onInterrupt,
    busy,
    onToggleDictation,
    dictationActive,
  ]);

  const openFile = (path: string) => useRightPanelStore.getState().openFile(target, path);
  const active = (surface: RightPanelSurface) => panel.isOpen && activeSurface?.id === surface.id;
  const tabs = (
    <RightPanelTabs
      mode={sheet ? "sheet" : "inline"}
      widthStorageKey={`t3code:preview-panel-width:${key}`}
      open={panel.isOpen}
      maximized={!sheet && maximized}
      surfaces={panel.surfaces}
      environmentId={target.environmentId}
      activeSurfaceId={activeSurface?.id ?? null}
      pendingSurfaceIds={pendingSurfaceIds}
      previewSessions={preview.sessions}
      desktopByTabId={preview.desktopByTabId}
      previewRuntimeTabId={(tabId) => previewRuntimeTabId(target, preview.serverEpoch, tabId)}
      terminalLabelsById={labels}
      onActivate={(surface) => {
        useRightPanelStore.getState().activateSurface(target, surface.id);
        if (surface.kind === "preview" && surface.resourceId)
          setActivePreviewTab(target, surface.resourceId);
      }}
      onMoveSurface={(surface, toIndex) =>
        useRightPanelStore.getState().moveSurface(target, surface.id, toIndex)
      }
      onCloseSurface={(surface) => void closeSurfaces([surface])}
      onCloseOtherSurfaces={(surface) =>
        void closeSurfaces(panel.surfaces.filter((other) => other.id !== surface.id))
      }
      onCloseSurfacesToRight={(surface) =>
        void closeSurfaces(
          panel.surfaces.slice(panel.surfaces.findIndex((other) => other.id === surface.id) + 1),
        )
      }
      onCloseAllSurfaces={() => void closeSurfaces(panel.surfaces)}
      onCopyFilePath={(path) => {
        void writeTextToClipboard(path).catch(report);
      }}
      onRenameDevice={(id, title) => useRightPanelStore.getState().renameDevice(target, id, title)}
      onAddBrowser={() => createBrowser()}
      onAddBrowserInProfile={createBrowser}
      onAddTerminal={createTerminal}
      onAddDiff={() => useRightPanelStore.getState().open(target, "diff")}
      onAddFiles={() => useRightPanelStore.getState().open(target, "files")}
      onAddAgents={() => useRightPanelStore.getState().open(target, "agents")}
      onAddDevice={() => useRightPanelStore.getState().open(target, "device")}
      browserAvailable={isPreviewSupportedInRuntime()}
      terminalAvailable={cwd !== null}
      diffAvailable={gitStatus.data?.isRepo === true}
      filesAvailable={cwd !== null}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      agentsAvailable
      deviceAvailable
      liveAgentCount={agentModel.liveCount}
      nativeHistory={{ onOpen: onOpenTree }}
      nativeBackgroundTasks={{
        onOpen: () => useRightPanelStore.getState().open(target, "background-tasks"),
      }}
    >
      <Suspense fallback={null}>
        {activeSurface?.kind === "preview" ? (
          <PreviewPanel
            mode="embedded"
            placement={sheet ? "sheet" : "inline"}
            threadRef={target}
            tabId={activeSurface.resourceId}
            visible={panel.isOpen}
            onSendAnnotation={onSendAnnotation}
          />
        ) : null}
        {activeSurface?.kind === "diff" && cwd ? (
          <DiffPanel
            mode="embedded"
            composerDraftTarget={target}
            nativeWorkspace={{ target, cwd }}
            workspaceMutationId={workspaceMutationId}
          />
        ) : null}
        {activeSurface?.kind === "agents" ? <NativeAgentsPanel viewKey={key} /> : null}
        {activeSurface?.kind === "background-tasks" ? (
          <NativeBackgroundTasksPanel target={target} />
        ) : null}
        {activeSurface?.kind === "native-history" ? (
          <NativeSessionTreePanel
            target={target}
            request={request}
            execute={execute}
            onNavigated={onTreeNavigated}
          />
        ) : null}
        {panel.surfaces.map((surface) =>
          surface.kind === "terminal" && cwd ? (
            <div
              key={surface.id}
              className={active(surface) ? "flex min-h-0 flex-1 flex-col" : "hidden"}
            >
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  useRightPanelStore.getState().closeSurface(target, surface.id);
                  useTerminalUiStateStore.getState().setTerminalOpen(target, true);
                }}
              >
                Return to terminal drawer
              </Button>
              <NativeSessionTerminal
                target={target}
                cwd={cwd}
                mode="panel"
                surface={surface}
                visible={active(surface)}
                keybindings={keybindings}
                onAddTerminalContext={onAddTerminalContext}
                {...(activeSurface?.id === surface.id ? { controllerRef: panelRef } : {})}
              />
            </div>
          ) : surface.kind === "file" || surface.kind === "files" ? (
            <div
              key={surface.id}
              className={active(surface) ? "flex min-h-0 flex-1 flex-col" : "hidden"}
            >
              <FilePreviewPanel
                environmentId={target.environmentId}
                cwd={cwd ?? ""}
                projectName={cwd?.split(/[\\/]/).at(-1) ?? ""}
                threadRef={target}
                composerDraftTarget={target}
                availableEditors={serverConfig?.availableEditors ?? []}
                relativePath={surface.kind === "file" ? surface.relativePath : null}
                {...(surface.kind === "file" && surface.attachment
                  ? { attachment: surface.attachment }
                  : {})}
                revealLine={surface.kind === "file" ? surface.revealLine : null}
                revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
                onOpenFile={openFile}
                onPendingChange={(path, pending) =>
                  setPendingFiles((current) => {
                    const next = new Set(current);
                    if (pending) next.add(path);
                    else next.delete(path);
                    return next;
                  })
                }
                selectedFilePending={
                  surface.kind === "file" && pendingFiles.has(surface.relativePath)
                }
                workspaceMutationId={workspaceMutationId}
              />
            </div>
          ) : surface.kind === "device" ? (
            <div
              key={surface.id}
              className={active(surface) ? "flex min-h-0 flex-1 flex-col" : "hidden"}
            >
              <DevicePanel
                mode="embedded"
                threadRef={target}
                surface={surface}
                visible={active(surface)}
                onDismissSetup={() =>
                  useRightPanelStore.getState().closeSurface(target, surface.id)
                }
              />
            </div>
          ) : null,
        )}
      </Suspense>
    </RightPanelTabs>
  );
  const dropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive,
    addFiles: (files) => composerRef.current?.addDroppedFiles(files),
    addFolders: (folders) => composerRef.current?.addDroppedFolders(folders),
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Same viewport anchor as the thread view's titlebar controls. Surfaces are added from the panel's tab bar. */}
      <div
        className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
        data-workspace-titlebar-controls
      >
        {panel.isOpen && !sheet ? (
          <span className="pointer-events-auto flex shrink-0">
            <RightPanelMaximizeControl
              maximized={maximized}
              onToggle={() => setMaximized((value) => !value)}
            />
          </span>
        ) : null}
        <div className="pointer-events-auto flex h-full items-center">
          <PanelLayoutControls
            terminalAvailable={cwd !== null}
            terminalOpen={terminalUi.terminalOpen}
            terminalShortcutLabel={shortcutLabelForCommand(keybindings, "terminal.toggle")}
            rightPanelAvailable
            rightPanelOpen={panel.isOpen}
            rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
            liveAgentCount={
              panel.isOpen && activeSurface?.kind === "agents" ? 0 : agentModel.liveCount
            }
            onToggleTerminal={() =>
              useTerminalUiStateStore.getState().setTerminalOpen(target, !terminalUi.terminalOpen)
            }
            onToggleRightPanel={() => useRightPanelStore.getState().toggleVisibility(target)}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-4 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          className={
            maximized && panel.isOpen && !sheet
              ? "hidden"
              : "relative flex min-h-0 min-w-0 flex-1 flex-col"
          }
          {...dropHandlers}
          data-workspace-file-drag-active={dragActive || undefined}
        >
          <div className="flex min-h-0 flex-1 flex-col" inert={agentViewActive}>
            {children}
          </div>
          <NativeAgentOverlay target={target} viewKey={key} cwd={cwd} />
          {miniPlayer ? (
            <ThreadPreviewMiniPlayer
              threadRef={target}
              miniPlayer={miniPlayer}
              composerOverlayElement={composerOverlayElement}
            />
          ) : null}
          {cwd ? (
            <NativeSessionTerminal
              target={target}
              cwd={cwd}
              keybindings={keybindings}
              visible={terminalUi.terminalOpen}
              onAddTerminalContext={onAddTerminalContext}
              controllerRef={drawerRef}
            />
          ) : null}
        </div>
        {sheet ? (
          <RightPanelSheet
            animationDurationMs={0}
            open={panel.isOpen}
            browserSurface={activeSurface?.kind === "preview"}
            onClose={() => useRightPanelStore.getState().close(target)}
          >
            {tabs}
          </RightPanelSheet>
        ) : (
          tabs
        )}
      </div>
    </div>
  );
}
