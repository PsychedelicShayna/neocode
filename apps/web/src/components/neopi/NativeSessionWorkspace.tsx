import { BracesIcon, GitForkIcon, UnplugIcon } from "lucide-react";
import type { LegendListRef } from "@legendapp/list/react";
import {
  NATIVE_COMMAND_COMPLETIONS_CAPABILITY,
  nativeCommandCompletions,
  nativeRecord,
  nativeSessionKey,
  nativeSlashCommands,
  type NativeSessionTarget,
  type NativeSlashCommand,
} from "@t3tools/client-runtime/neopi-native-sessions";
import {
  createTranscriptProjector,
  transcriptUserText,
  type CommandRow,
} from "@t3tools/client-runtime/neopi-transcript";
import { agentIdentity, nativeSessionIdentityKey } from "@t3tools/shared/agentNames";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { isElectron } from "../../env";
import { nativeDictationAvailable } from "./nativeDictation";
import { useNativeDictation } from "./useNativeDictation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { ComposerSurface } from "../chat/ComposerSurface";
import { cn } from "../../lib/utils";
import {
  nativeSessionAtoms,
  closeNativeSession,
  replaceNativeSession,
  useNativeSession,
  useNativeSessionSelection,
} from "../../state/neopiNativeSessions";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import { SidebarInset } from "../ui/sidebar";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { NativeSessionStatusBar } from "./NativeSessionStatusBar";
import { NativeSessionTabBar } from "./NativeSessionTabBar";
import { useCreateNativeSession } from "./NativeSessionSidebar";
import { NativeTimelineView, nativeTimelineKey } from "./NativeTimelineView";
import {
  nativeQueuedMessages,
  nextPromotableNativeQueuedMessageId,
  parseNativeQueuedMessageId,
} from "./nativeTimeline";
import {
  nativeTraitsCommands,
  nativeTraitsDescriptors,
  nativeTraitsModels,
  nativeTraitsStateFromSession,
  parseNativeThinkingLevels,
} from "./nativeTraits";
import { useAtomCommand } from "../../state/use-atom-command";
import { createPortal } from "react-dom";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerImageAttachment,
  type ComposerFileAttachment,
} from "../../composerDraftStore";
import { useComposerHandleContext } from "../../composerHandleContext";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import {
  EMPTY_SERVER_PROVIDERS,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "../../state/server";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { ChatComposer, type ChatComposerHandle } from "../chat/ChatComposer";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { createPageScrollController } from "../chat/pageScrollController";
import type { NativeModelChoice } from "../chat/neopiModelSwitcher";
import { NativeSessionModelPicker } from "./NativeSessionModelPicker";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { NativeBranchToolbar } from "./NativeBranchToolbar";
import { NativeSessionWorkspacePanels } from "./NativeSessionWorkspacePanels";
import { AgentHubSourceProvider, useNativeAgentHubSource } from "./agents/useNativeAgentHubSource";
import {
  NATIVE_CYCLE_ROLE_CAPABILITY,
  NATIVE_ROLE_CYCLE_UNSUPPORTED,
  nativeRoleCycleNotice,
  nativeThinkingCycleNotice,
  type NativeSessionCommand,
} from "./nativeSessionShortcuts";
import {
  toggleNativeThinkingVisibility,
  useNativeTranscriptView,
} from "../../state/nativeTranscriptView";
import { consumeNativeDraft, prepareNativePrompt } from "./neopiNativeComposer";
import { restoreNativeEditor } from "./neopiNativeDraft";
import type { ComposerSubmissionIntent } from "../../composer-logic";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";

type Request = ReturnType<typeof useNativeSession>["request"];
const answeredDialogs = new Map<string, Set<string>>();
const consumedEditors = new Map<string, string>();

function HeaderIconButton(props: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={props.label}
            {...(props.pressed !== undefined ? { "aria-pressed": props.pressed } : {})}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function NativeSessionWorkspace() {
  const target = useNativeSessionSelection((state) => state.target);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <NativeSessionTabBar actionsRef={setActionsSlot} />
      {target ? (
        <NativeSessionView
          key={nativeSessionKey(target)}
          target={target}
          actionsSlot={actionsSlot}
        />
      ) : (
        <NativeSessionStart />
      )}
    </SidebarInset>
  );
}
function NativeSessionStart() {
  const create = useCreateNativeSession();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <>
      <div className="m-auto flex max-w-lg flex-col items-center gap-4 p-6">
        <h1 className="text-xl font-semibold">Start a conversation</h1>
        <p className="text-sm text-muted-foreground">
          No project or repository required. NeoPi creates and owns the session.
        </p>
        <Button
          disabled={pending}
          onClick={() => {
            setPending(true);
            void create()
              .catch((cause) => setError(String(cause)))
              .finally(() => setPending(false));
          }}
        >
          New thread
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}

export function NativeSessionView({
  target,
  actionsSlot,
}: {
  target: NativeSessionTarget;
  /** The tab bar's trailing slot, where this session's header actions render. */
  actionsSlot?: HTMLElement | null;
}) {
  const { feed, session, conversation, request, loading, error } = useNativeSession(target);
  const close = useAtomCommand(nativeSessionAtoms.close, { reportFailure: false });
  const key = nativeSessionKey(target);
  const assistantName = agentIdentity(
    nativeSessionIdentityKey({
      sessionId: session?.sessionId,
      sessionFile: target.ref.sessionFile,
    }),
  ).label;
  const agentHub = useNativeAgentHubSource({ target, feed, request });
  const draftStore = useComposerDraftStore;
  const panelOpen = useRightPanelStore(
    (value) => selectThreadRightPanelState(value.byThreadKey, target).isOpen,
  );
  const settings = useEnvironmentSettings(target.environmentId);
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const fileAttachmentBytes =
    serverConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const terminalOpen = useTerminalUiStateStore(
    (value) => selectThreadTerminalUiState(value.terminalUiStateByThreadKey, target).terminalOpen,
  );
  // ChatComposer keeps this ref in sync with its own draft subscription. Read the
  // stored prompt once here: subscribing would re-render the whole workspace
  // (transcript, panels) on every keystroke.
  const [initialPrompt] = useState(
    () => draftStore.getState().getComposerDraft(target)?.prompt ?? "",
  );
  const promptRef = useRef(initialPrompt);
  const imagesRef = useRef<ComposerImageAttachment[]>([]);
  const filesRef = useRef<ComposerFileAttachment[]>([]);
  const terminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const dictation = useNativeDictation({ feed, request, composerRef });
  const dictationAvailable = nativeDictationAvailable({
    isDesktop: isElectron,
    localEnvironmentDisabled: isLocalEnvironmentDisabled(),
    environmentId: target.environmentId,
    primaryEnvironmentId,
    attachment: session?.attachment,
  });
  const timelineRef = useRef<LegendListRef | null>(null);
  const [followSignal, setFollowSignal] = useState(0);
  const submit = useCallback<Request>(
    async (command, attachments) => {
      const result = await request(command, attachments);
      if (command.type === "prompt") setFollowSignal((value) => value + 1);
      return result;
    },
    [request],
  );
  const [composerElement, setComposerElement] = useState<HTMLDivElement | null>(null);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const sendingRef = useRef(false);
  const focusComposer = useCallback(() => composerRef.current?.focusAtEnd(), [composerRef]);
  // The workspace remounts after Models Back; the draft stays in its store.
  useEffect(() => focusComposer(), [focusComposer]);
  const pageScroll = useMemo(
    () =>
      createPageScrollController({
        getContainer: () => timelineRef.current?.getScrollableNode() ?? null,
        getScrollPaddingBottomPx: () => 0,
      }),
    [],
  );
  useEffect(() => () => pageScroll.dispose(), [pageScroll]);
  const [debug, setDebug] = useState(false);
  const openTree = useCallback(
    () => useRightPanelStore.getState().open(target, "native-history"),
    [target],
  );
  const [models, setModels] = useState(false);
  const [sending, setSending] = useState(false);
  const [paging, setPaging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, unknown>>({});
  const [commands, setCommands] = useState<readonly NativeSlashCommand[]>([]);
  const [dismissed, setDismissed] = useState(() => answeredDialogs.get(key) ?? new Set<string>());
  useEffect(() => {
    if (session) setState(session.state);
  }, [session]);
  // NeoPi moved this session to another file (`/wt`, fork): the selection and
  // its tab follow in place, never a second tab for the same session.
  const movedRef = feed.movedTo ?? session?.ref ?? null;
  useEffect(() => {
    if (movedRef && movedRef.sessionFile !== target.ref.sessionFile)
      replaceNativeSession(target, { environmentId: target.environmentId, ref: movedRef });
  }, [movedRef, target]);
  // The sidebar and tab titles read the session list, which still names the old file.
  const hasMoved = feed.movedTo !== null;
  useEffect(() => {
    if (hasMoved)
      appAtomRegistry.refresh(
        nativeSessionAtoms.list({ environmentId: target.environmentId, input: {} }),
      );
  }, [hasMoved, target.environmentId]);
  const loadOlder = async () => {
    if (paging || !conversation.cursor) return;
    setPaging(true);
    try {
      await request({
        type: "get_entries_page",
        scope: "branch",
        direction: "backward",
        limit: 128,
        cursor: conversation.cursor,
      });
    } catch (cause) {
      setLocalError(String(cause));
    } finally {
      setPaging(false);
    }
  };
  // NeoPi owns the command list; an announcement of a changed list re-reads it.
  useEffect(() => {
    if (!feed.connected) return;
    let active = true;
    void request({ type: "get_available_commands" })
      .then((value) => {
        if (active) setCommands(nativeSlashCommands(value));
      })
      .catch((cause) => {
        if (active) setLocalError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [feed.connected, feed.commandsRevision, request]);
  const completesArguments =
    session?.capabilities.includes(NATIVE_COMMAND_COMPLETIONS_CAPABILITY) === true;
  const completeCommandArgument = useCallback(
    async (command: string, prefix: string) =>
      nativeCommandCompletions(
        await request({ type: "get_command_completions", command, prefix }),
        prefix,
      ),
    [request],
  );
  useEffect(() => {
    if (!feed.editor || consumedEditors.get(key) === feed.editor.id) return;
    consumedEditors.set(key, feed.editor.id);
    // A native menu's editor text must not destroy a prompt the user is still composing.
    if (!composerDraftHasUserContent(draftStore.getState().getComposerDraft(target))) {
      draftStore.getState().setPrompt(target, feed.editor.text);
    }
  }, [feed.editor, key, target]);
  const execute = useCallback(
    async (command: Record<string, unknown> & { type: string }) => {
      setLocalError(null);
      const result = await submit(command);
      if (command.type !== "prompt" && command.type !== "extension_ui_response") {
        const observed = await request({ type: "get_state" });
        setState(nativeRecord(observed));
      }
      return result;
    },
    [request, submit],
  );
  // While NeoPi runs, a prompt steers in at the next tool boundary, which is
  // what T3's queue promises; the alternate intent waits for the whole run.
  const send = useCallback(
    async (intent?: ComposerSubmissionIntent) => {
      const snapshot = draftStore.getState().getComposerDraft(target);
      if (
        !composerDraftHasUserContent(snapshot) ||
        !snapshot ||
        sendingRef.current ||
        !feed.connected
      )
        return;
      if (composerRef.current?.hasPendingAttachments()) {
        setLocalError("Wait for the attachment to finish preparing before sending.");
        return;
      }
      sendingRef.current = true;
      setSending(true);
      setLocalError(null);
      try {
        const prompt = await prepareNativePrompt(target, snapshot);
        const busy = nativeSessionAtoms.cached(target)?.busy ?? feed.busy;
        await submit(
          {
            type: "prompt",
            message: prompt.message,
            ...(busy ? { streamingBehavior: intent === "alternate" ? "followUp" : "steer" } : {}),
          },
          prompt.attachments,
        );
        consumeNativeDraft(target, snapshot, prompt.attachments);
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        sendingRef.current = false;
        setSending(false);
        focusComposer();
      }
    },
    [target, feed.connected, feed.busy, submit, composerRef, focusComposer],
  );
  const commandOutputs = useMemo(() => {
    // Command results are local display history anchored after the entry they followed.
    const outputs = new Map<string | null, CommandRow[]>();
    for (const output of feed.commandOutputs) {
      const anchor = output.afterMessageId
        ? (conversation.persisted.get(output.afterMessageId) ?? `live:${output.afterMessageId}`)
        : output.afterEntryId;
      const row: CommandRow = { kind: "command", id: output.id, text: output.text };
      const group = outputs.get(anchor);
      if (group) group.push(row);
      else outputs.set(anchor, [row]);
    }
    return outputs;
  }, [feed.commandOutputs, conversation.persisted]);
  // Streaming replaces only live messages; the projector keeps the rest of the rows as they were.
  const [projectRows] = useState(createTranscriptProjector);
  const rows = useMemo(
    () =>
      projectRows(
        {
          entries: conversation.entries,
          pending: conversation.pending,
          leafId: conversation.identity?.leafId ?? null,
        },
        { debug, commandOutputs },
      ),
    [
      projectRows,
      conversation.entries,
      conversation.pending,
      conversation.identity?.leafId,
      debug,
      commandOutputs,
    ],
  );
  const queueStamp = conversation.entries.at(-1)?.timestamp ?? "";
  const queuedMessages = useMemo(
    () => nativeQueuedMessages(feed.queue, queueStamp),
    [feed.queue, queueStamp],
  );
  const steerQueued = useCallback(
    (id: string) => {
      const queued = parseNativeQueuedMessageId(id);
      if (!queued) return;
      void request({ type: "promote_queued_message", message: queued.text }).catch((cause) =>
        setLocalError(String(cause)),
      );
    },
    [request],
  );
  // Enter on an empty composer sends the oldest queued follow-up now.
  const sendNextQueuedNow = useCallback(() => {
    const id = nextPromotableNativeQueuedMessageId(queuedMessages);
    if (id === null) return false;
    steerQueued(id);
    return true;
  }, [queuedMessages, steerQueued]);
  const removeQueued = useCallback(
    (id: string) => {
      const queued = parseNativeQueuedMessageId(id);
      const parsed = queuedMessages.find((message) => message.id === id);
      if (!queued || !parsed) return;
      void request({ type: "remove_queued_message", message: queued.text, queue: queued.lane })
        .then(() => {
          // Cancel returns the draft, context included, without destroying a newer one.
          const store = draftStore.getState();
          const current = store.getComposerDraft(target)?.prompt ?? "";
          store.setPrompt(
            target,
            current.trim() ? `${parsed.prompt}\n\n${current}` : parsed.prompt,
          );
          if (parsed.terminalContexts.length > 0)
            store.addTerminalContexts(target, parsed.terminalContexts);
          for (const annotation of parsed.previewAnnotations)
            store.addPreviewAnnotation(target, annotation);
          for (const comment of parsed.reviewComments) store.addReviewComment(target, comment);
          focusComposer();
        })
        .catch((cause) => setLocalError(String(cause)));
    },
    [request, draftStore, target, focusComposer, queuedMessages],
  );
  // Selecting a user message in the tree hands its text back for editing, as the
  // TUI does. A draft already in the composer stays; the notice says why.
  const onTreeNavigated = useCallback(
    (answer: Record<string, unknown>) => {
      try {
        if (restoreNativeEditor(target, answer) === "kept")
          toastManager.add({
            id: "native-tree-editor",
            title: "Draft kept",
            description: "The selected message was not placed in the composer.",
            timeout: 4000,
          });
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : String(cause));
      }
      focusComposer();
    },
    [target, focusComposer],
  );
  const loadEarlier = useMemo(
    () =>
      conversation.cursor
        ? { loading: paging, cursor: conversation.cursor, onLoadEarlier: () => void loadOlder() }
        : null,
    // loadOlder reads the latest cursor and paging state on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversation.cursor, paging],
  );
  const promptHistory = useMemo(
    () => transcriptUserText(conversation.entries),
    [conversation.entries],
  );
  const model = nativeRecord(state.model);
  const modelId = typeof model.id === "string" ? model.id : null;
  const thinkingLevelsKey = `${String(model.provider)}/${String(modelId)}`;
  const [thinkingLevels, setThinkingLevels] = useState<{
    readonly key: string;
    readonly levels: readonly string[];
  } | null>(null);
  // The levels belong to the model; ask NeoPi again whenever the model changes.
  useEffect(() => {
    if (!feed.connected || modelId === null) return;
    let active = true;
    void request({ type: "get_available_thinking_levels" })
      .then((value) => {
        if (active)
          setThinkingLevels({ key: thinkingLevelsKey, levels: parseNativeThinkingLevels(value) });
      })
      .catch((cause) => {
        if (active) setLocalError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [feed.connected, modelId, thinkingLevelsKey, request]);
  const nativeThinkingLevel = typeof state.thinkingLevel === "string" ? state.thinkingLevel : null;
  const nativeFastModeEnabled = state.fastModeEnabled === true;
  const changeTraits = useCallback(
    async (next: Parameters<typeof nativeTraitsCommands>[1]) => {
      try {
        for (const command of nativeTraitsCommands(
          { thinkingLevel: nativeThinkingLevel, fastModeEnabled: nativeFastModeEnabled },
          next,
        ))
          await execute(command);
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [execute, nativeThinkingLevel, nativeFastModeEnabled],
  );
  const traits = useMemo(() => {
    if (modelId === null) return null;
    const descriptors = nativeTraitsDescriptors(
      nativeTraitsStateFromSession(
        state,
        thinkingLevels?.key === thinkingLevelsKey ? thinkingLevels.levels : [],
      ),
    );
    return descriptors.length === 0
      ? null
      : {
          model: modelId,
          models: nativeTraitsModels(modelId, descriptors),
          onModelOptionsChange: (next: Parameters<typeof nativeTraitsCommands>[1]) =>
            void changeTraits(next),
        };
  }, [modelId, state, thinkingLevels, thinkingLevelsKey, changeTraits]);
  const modelLabel = String(model.name ?? model.id ?? "Choose native model");
  const displayState =
    [
      // The effort selector already shows the level once NeoPi has listed levels.
      traits ? null : state.thinkingLevel,
      // Chat mode is NeoPi's no-tools conversation mode; only an active one is news.
      typeof state.chatMode === "string" && state.chatMode !== "off"
        ? `Chat ${state.chatMode}`
        : null,
    ]
      .filter((value) => typeof value === "string")
      .join(" · ") || null;
  const selectModel = useCallback(
    (choice: NativeModelChoice) => {
      setModels(false);
      void execute(
        choice.kind === "role"
          ? { type: "set_role", role: choice.role }
          : { type: "set_model", provider: choice.provider, modelId: choice.modelId },
      ).catch((cause) => setLocalError(String(cause)));
    },
    [execute],
  );
  const interrupt = useCallback(() => {
    void execute({ type: "abort" }).catch((cause) => setLocalError(String(cause)));
  }, [execute]);
  const hideThinking = useNativeTranscriptView((state) => state.hideThinking);
  const [toolOutputSerial, setToolOutputSerial] = useState(0);
  const canCycleRole = session?.capabilities.includes(NATIVE_CYCLE_ROLE_CAPABILITY) === true;
  const runNativeCommand = useCallback(
    (command: NativeSessionCommand) => {
      const notify = (title: string) =>
        toastManager.add({ id: `native-shortcut:${command}`, title, timeout: 1500 });
      const fail = (cause: unknown) =>
        setLocalError(cause instanceof Error ? cause.message : String(cause));
      switch (command) {
        case "composer.thinking.cycle":
          void execute({ type: "cycle_thinking_level" })
            .then((result) => notify(nativeThinkingCycleNotice(result)))
            .catch(fail);
          return;
        case "composer.role.cycleForward":
        case "composer.role.cycleBackward":
          if (!canCycleRole) {
            notify(NATIVE_ROLE_CYCLE_UNSUPPORTED);
            return;
          }
          void execute({
            type: "cycle_role",
            direction: command === "composer.role.cycleForward" ? "forward" : "backward",
          })
            .then((result) => notify(nativeRoleCycleNotice(result)))
            .catch(fail);
          return;
        case "transcript.thinking.toggle":
          toggleNativeThinkingVisibility();
          notify(
            useNativeTranscriptView.getState().hideThinking
              ? "Reasoning hidden"
              : "Reasoning shown",
          );
          return;
        case "transcript.tools.toggleExpand":
          setToolOutputSerial((value) => value + 1);
          return;
      }
    },
    [execute, canCycleRole],
  );
  const dialog = feed.dialogs.find(
    (item) => typeof item.id === "string" && !dismissed.has(item.id),
  );
  return (
    <AgentHubSourceProvider source={agentHub}>
      {actionsSlot
        ? createPortal(
            // Leaves room for the fixed terminal and panel toggles at the titlebar edge.
            <div
              className={cn(
                "flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]",
                // The fixed titlebar controls gain a maximize button while the panel is open.
                panelOpen ? "pr-26.5 sm:pr-22.5" : "pr-18.25 sm:pr-14.25",
              )}
            >
              <HeaderIconButton label="Session tree" onClick={openTree}>
                <GitForkIcon className="size-4" />
              </HeaderIconButton>
              <HeaderIconButton
                label={debug ? "Hide native records" : "Show native records"}
                pressed={debug}
                onClick={() => setDebug((value) => !value)}
              >
                <BracesIcon className="size-4" />
              </HeaderIconButton>
              <HeaderIconButton
                label="Disconnect session"
                onClick={() =>
                  void close({
                    environmentId: target.environmentId,
                    input: { ref: target.ref },
                  }).then((result) => {
                    if (result._tag === "Failure")
                      setLocalError(String(squashAtomCommandFailure(result)));
                    else closeNativeSession(target);
                  })
                }
              >
                <UnplugIcon className="size-4" />
              </HeaderIconButton>
            </div>,
            actionsSlot,
          )
        : null}
      <NativeSessionWorkspacePanels
        target={target}
        cwd={session?.cwd ?? null}
        agents={feed.agents}
        keybindings={keybindings}
        composerRef={composerRef}
        composerOverlayElement={composerElement}
        workspaceMutationId={conversation.entries.at(-1)?.id ?? null}
        onAddTerminalContext={(selection) => composerRef.current?.addTerminalContext(selection)}
        onSendAnnotation={() => void send()}
        onOpenTree={openTree}
        request={request}
        execute={execute}
        onTreeNavigated={onTreeNavigated}
        onOpenModels={() => setModels((value) => !value)}
        onInterrupt={interrupt}
        busy={feed.busy}
        onToggleDictation={dictationAvailable ? dictation.toggle : undefined}
        dictationActive={dictation.phase !== "idle"}
        onNativeCommand={runNativeCommand}
      >
        {error || localError ? (
          <p role="alert" className="shrink-0 px-5 py-1 text-xs text-destructive">
            {localError ?? error}
          </p>
        ) : null}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <NativeTimelineView
            rows={rows}
            busy={feed.busy}
            assistantName={assistantName}
            environmentId={target.environmentId}
            timelineKey={nativeTimelineKey(target.environmentId, target.ref.sessionFile)}
            cwd={session?.cwd}
            listRef={timelineRef}
            loadEarlier={loadEarlier}
            followSignal={followSignal}
            onImageExpand={setExpandedImage}
            queuedMessages={queuedMessages}
            hideThinking={hideThinking}
            toggleToolOutputSerial={toolOutputSerial}
            onSteerQueuedMessage={steerQueued}
            onRemoveQueuedMessage={removeQueued}
          />
        </div>
        <ComposerSurface.Shell ref={setComposerElement} contextStrip className="shrink-0">
          {Object.values(feed.notices).some(Boolean) ? (
            <div className="flex flex-col gap-0.5 ps-(--workspace-gutter-start) pe-(--workspace-gutter-end) pt-2 text-xs text-muted-foreground">
              {Object.values(feed.notices)
                .filter(Boolean)
                .map((notice, index) => (
                  <p key={index} className="whitespace-pre-wrap">
                    {notice}
                  </p>
                ))}
            </div>
          ) : null}
          <ComposerSurface.Host>
            <ChatComposer
              routeKind="native"
              routeThreadRef={target}
              composerDraftTarget={target}
              environmentId={target.environmentId}
              attachmentUploadsCapabilityKnown={serverConfig !== null}
              supportsAttachmentUploads={
                serverConfig?.environment.capabilities.attachmentUploads === true
              }
              maxFileAttachmentBytes={
                fileAttachmentBytes === null
                  ? null
                  : clampFileAttachmentUploadBytes(fileAttachmentBytes)
              }
              phase={feed.connected ? (feed.busy ? "running" : "ready") : "disconnected"}
              isConnecting={loading}
              isSendBusy={sending}
              sendDisabledReason={feed.connected ? null : "Reconnect NeoPi before sending."}
              settings={settings}
              resolvedTheme={resolvedTheme}
              keybindings={keybindings}
              terminalOpen={terminalOpen}
              gitCwd={session?.cwd ?? null}
              promptRef={promptRef}
              composerImagesRef={imagesRef}
              composerFilesRef={filesRef}
              composerTerminalContextsRef={terminalContextsRef}
              composerRef={composerRef}
              onPageScrollKeyDown={pageScroll.handleKeyDown}
              onPageScrollKeyUp={pageScroll.handleKeyUp}
              onPageScrollRelease={pageScroll.releaseActiveKey}
              onSend={(event, intent) => {
                event?.preventDefault();
                void send(intent);
              }}
              onInterrupt={interrupt}
              focusComposer={focusComposer}
              scheduleComposerFocus={focusComposer}
              setThreadError={(_, message) => setLocalError(message)}
              onExpandImage={setExpandedImage}
              onFileOpen={(attachment) =>
                useRightPanelStore.getState().openAttachment(target, attachment)
              }
              nativeSession={{
                modelControl: (
                  <NativeSessionModelPicker
                    target={target}
                    providers={serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS}
                    settings={settings}
                    keybindings={keybindings}
                    modelLabel={modelLabel}
                    modelSelector={
                      typeof model.provider === "string" && typeof model.id === "string"
                        ? `${model.provider}/${model.id}`
                        : ""
                    }
                    displayState={displayState}
                    open={models}
                    onOpenChange={setModels}
                    disabled={sending}
                    terminalOpen={terminalOpen}
                    onSelect={selectModel}
                  />
                ),
                commands,
                attachment: session?.attachment,
                ...(completesArguments ? { completeCommandArgument } : {}),
                traits,
                onSendQueuedNow: sendNextQueuedNow,
                promptHistory,
                modelPickerOpen: models,
                onOpenModelPicker: () => setModels(true),
                onOpenSessionTree: openTree,
                onOpenModeControl: () => {
                  void execute({ type: "prompt", message: "/chat" }).catch((cause) =>
                    setLocalError(String(cause)),
                  );
                },
                onToggleModelPicker: () => setModels((value) => !value),
                onCompactContext: () => {
                  void execute({ type: "prompt", message: "/compact" }).catch((cause) =>
                    setLocalError(String(cause)),
                  );
                },
                ...(dictationAvailable ? { dictation } : {}),
              }}
            />
          </ComposerSurface.Host>
          <NativeBranchToolbar
            environmentId={target.environmentId}
            cwd={session?.cwd ?? null}
            busy={feed.busy}
            connected={feed.connected}
            onRunCommand={(message) => {
              void execute({ type: "prompt", message }).catch((cause) =>
                setLocalError(String(cause)),
              );
            }}
            onReturnFocus={focusComposer}
          />
        </ComposerSurface.Shell>
        <NativeSessionStatusBar target={target} />
      </NativeSessionWorkspacePanels>
      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
      {dialog ? (
        <NativeSessionDialog
          key={String(dialog.id)}
          dialog={dialog}
          request={request}
          onAnswered={() => {
            const next = new Set(dismissed).add(String(dialog.id));
            answeredDialogs.set(key, next);
            setDismissed(next);
          }}
        />
      ) : null}
    </AgentHubSourceProvider>
  );
}

export function NativeSessionDialog({
  dialog,
  request,
  onAnswered,
}: {
  dialog: Record<string, unknown>;
  request: Request;
  onAnswered: () => void;
}) {
  const [value, setValue] = useState(typeof dialog.prefill === "string" ? dialog.prefill : "");
  const [answers, setAnswers] = useState<
    Record<string, { selectedOptions: string[]; customInput: string }>
  >({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toolApproval = dialog.type === "tool_approval_request";
  const planProposal = dialog.type === "plan_proposal_request";
  const responseType = toolApproval
    ? "tool_approval_response"
    : planProposal
      ? "plan_proposal_response"
      : "extension_ui_response";
  const respond = async (answer: Record<string, unknown>) => {
    if (pending) return;
    setPending(true);
    try {
      await request({ type: responseType, id: dialog.id, ...answer });
      onAnswered();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  const cancel = () =>
    respond(
      planProposal
        ? { decision: "refine", feedback: value || "Plan review cancelled." }
        : { cancelled: true },
    );
  const questions = Array.isArray(dialog.questions) ? dialog.questions.map(nativeRecord) : [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void cancel();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {String(dialog.title ?? (toolApproval ? `Allow ${dialog.toolName}?` : "NeoPi asks"))}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-96 space-y-3 overflow-auto px-6 pb-4">
          {dialog.message ? <p className="text-sm">{String(dialog.message)}</p> : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {toolApproval ? (
            <>
              {typeof dialog.reason === "string" ? (
                <p className="text-sm">{dialog.reason}</p>
              ) : null}
              <pre className="overflow-auto whitespace-pre-wrap text-xs">
                {JSON.stringify(dialog.args, null, 2)}
              </pre>
              {Array.isArray(dialog.details)
                ? dialog.details.map((detail, index) => (
                    <p key={index} className="text-sm">
                      {String(detail)}
                    </p>
                  ))
                : null}
              {Array.isArray(dialog.safetyChecks)
                ? dialog.safetyChecks.map((item, index) => {
                    const check = nativeRecord(item);
                    return (
                      <p key={index} role="alert" className="text-sm text-destructive">
                        {String(check.message ?? check.code ?? check.id)}
                      </p>
                    );
                  })
                : null}
            </>
          ) : null}
          {planProposal ? (
            <>
              <pre className="whitespace-pre-wrap text-sm">{String(dialog.planMarkdown ?? "")}</pre>
              <Textarea
                aria-label="Plan feedback"
                placeholder="Feedback for refinement"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </>
          ) : null}
          {dialog.method === "select" && Array.isArray(dialog.options)
            ? dialog.options.map((option, index) => (
                <div key={index}>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => void respond({ value: option })}
                  >
                    {String(option)}
                  </Button>
                </div>
              ))
            : null}
          {dialog.method === "input" ? (
            <Input
              autoFocus
              type={dialog.secret === true ? "password" : "text"}
              aria-label={String(dialog.title)}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : null}
          {dialog.method === "editor" ? (
            <Textarea
              autoFocus
              aria-label={String(dialog.title)}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : null}
          {questions.map((question) => {
            const id = String(question.id);
            const answer = answers[id] ?? { selectedOptions: [], customInput: "" };
            return (
              <fieldset key={id} className="space-y-2">
                <legend className="text-sm font-medium">{String(question.question)}</legend>
                {(Array.isArray(question.options) ? question.options : []).map((item, index) => {
                  const option = nativeRecord(item);
                  const label = String(option.label);
                  return (
                    <label key={index} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={answer.selectedOptions.includes(label)}
                        onCheckedChange={() =>
                          setAnswers({
                            ...answers,
                            [id]: {
                              ...answer,
                              selectedOptions: question.multi
                                ? answer.selectedOptions.includes(label)
                                  ? answer.selectedOptions.filter((value) => value !== label)
                                  : [...answer.selectedOptions, label]
                                : [label],
                            },
                          })
                        }
                      />
                      {label}
                      {typeof option.description === "string" ? ` · ${option.description}` : ""}
                    </label>
                  );
                })}
                <Input
                  aria-label={`Other answer: ${String(question.question)}`}
                  value={answer.customInput}
                  onChange={(event) =>
                    setAnswers({ ...answers, [id]: { ...answer, customInput: event.target.value } })
                  }
                />
              </fieldset>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => void cancel()}>
            Cancel
          </Button>
          {toolApproval ? (
            <>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void respond({ decision: "deny" })}
              >
                Deny
              </Button>
              {!Array.isArray(dialog.safetyChecks) || dialog.safetyChecks.length === 0 ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => void respond({ decision: "allow_session" })}
                >
                  Allow for session
                </Button>
              ) : null}
              <Button disabled={pending} onClick={() => void respond({ decision: "allow_once" })}>
                Allow once
              </Button>
            </>
          ) : null}
          {planProposal ? (
            <>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void respond({ decision: "refine", feedback: value })}
              >
                Refine
              </Button>
              <Button disabled={pending} onClick={() => void respond({ decision: "approve" })}>
                Approve plan
              </Button>
            </>
          ) : null}
          {dialog.method === "confirm" ? (
            <>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void respond({ confirmed: false })}
              >
                No
              </Button>
              <Button disabled={pending} onClick={() => void respond({ confirmed: true })}>
                Yes
              </Button>
            </>
          ) : null}
          {dialog.method === "input" || dialog.method === "editor" ? (
            <Button disabled={pending} onClick={() => void respond({ value })}>
              Submit
            </Button>
          ) : null}
          {dialog.method === "ask" ? (
            <Button
              disabled={pending}
              onClick={() =>
                void respond({
                  answers: questions.map((question) => ({
                    id: question.id,
                    ...(answers[String(question.id)] ?? { selectedOptions: [], customInput: "" }),
                  })),
                })
              }
            >
              Submit answers
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
