import { BracesIcon, GitForkIcon, PlugIcon, UnplugIcon, XIcon } from "lucide-react";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import type { LegendListRef } from "@legendapp/list/react";
import {
  NATIVE_COMMAND_COMPLETIONS_CAPABILITY,
  deferNativeEditorText,
  executeNativeSessionCommand,
  nativeCommandCompletions,
  nativeValueItems,
  nativeRecord,
  nativeSessionKey,
  nativeDisconnectLabel,
  nativeOwnerNotice,
  nativeSlashCommands,
  type NativeSessionTarget,
  type NativeSlashCommand,
} from "@t3tools/client-runtime/neopi-native-sessions";
import {
  interruptNativeQueuedInput,
  takeNativeQueuedInput,
} from "@t3tools/client-runtime/neopi-native-queue";
import {
  createTranscriptProjector,
  transcriptUserText,
  type CommandRow,
} from "@t3tools/client-runtime/neopi-transcript";
import { agentIdentity, nativeSessionIdentityKey } from "@t3tools/shared/agentNames";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import * as Option from "effect/Option";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { isElectron } from "../../env";
import { nativeDictationAvailability } from "./nativeDictation";
import { useNativeDictation } from "./useNativeDictation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { ComposerSurface } from "../chat/ComposerSurface";
import { cn } from "../../lib/utils";
import {
  nativeSessionAtoms,
  replaceNativeSession,
  useNativeSession,
  useNativeSessionReconnect,
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
import {
  ChatComposer,
  type ChatComposerHandle,
  type NativeChatComposerProps,
} from "../chat/ChatComposer";
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
import {
  captureNativeComposerFocus,
  consumeNativeDraft,
  prepareNativePrompt,
} from "./neopiNativeComposer";
import { restoreNativeEditor } from "./neopiNativeDraft";
import { restoreNativeQueuedDraft } from "./neopiNativeQueueDraft";
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

export function NativeSessionWorkspace({ background = false }: { readonly background?: boolean }) {
  const target = useNativeSessionSelection((state) => state.target);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  return (
    <SidebarInset
      className={cn("h-dvh min-h-0 overflow-hidden", background && "hidden")}
      inert={background || undefined}
      aria-hidden={background || undefined}
    >
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

function NativeSessionView({
  target,
  actionsSlot,
}: {
  target: NativeSessionTarget;
  /** The tab bar's trailing slot, where this session's header actions render. */
  actionsSlot?: HTMLElement | null;
}) {
  const { feed, session, conversation, request, loading, error } = useNativeSession(target);
  const canOperateThread = useEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope);
  // Dismissing hides that one message; a different failure shows again.
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const close = useAtomCommand(nativeSessionAtoms.close, { reportFailure: false });
  const key = nativeSessionKey(target);
  const assistantName = agentIdentity(
    nativeSessionIdentityKey({
      sessionId: session?.sessionId,
      sessionFile: target.ref.sessionFile,
    }),
  ).label;
  const agentHub = useNativeAgentHubSource({ target, feed, request });
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
    () => useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "",
  );
  const promptRef = useRef(initialPrompt);
  const imagesRef = useRef<ComposerImageAttachment[]>([]);
  const filesRef = useRef<ComposerFileAttachment[]>([]);
  const terminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const preparedConnection = usePreparedConnection(target.environmentId);
  const timelineRef = useRef<LegendListRef | null>(null);
  const [followSignal, setFollowSignal] = useState(0);
  const submit: Request = useStableCallback(async (command, attachments) => {
    const result = await request(command, attachments);
    if (command.type === "prompt") setFollowSignal((value) => value + 1);
    return result;
  });
  const [composerElement, setComposerElement] = useState<HTMLDivElement | null>(null);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Revoke the expanded video's owned blob URL when its preview closes.
  useEffect(() => {
    const item = expandedImage?.images[expandedImage.index];
    // Local video expansions mint their own URL; image previews belong to the draft.
    if (item?.type !== "video" || item.src === null || !item.src.startsWith("blob:")) return;
    const src = item.src;
    return () => URL.revokeObjectURL(src);
  }, [expandedImage]);
  const sendingRef = useRef(false);
  const focusComposer = useStableCallback(() => composerRef.current?.focusAtEnd());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore DOM focus after this workspace mounts.
  useEffect(() => focusComposer(), [focusComposer]);
  const getScrollContainer = useStableCallback(
    () => timelineRef.current?.getScrollableNode() ?? null,
  );
  const [pageScroll] = useState(() =>
    createPageScrollController({
      getContainer: getScrollContainer,
      getScrollPaddingBottomPx: () => 0,
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release held keys and scheduled scroll frames on unmount.
  useEffect(() => () => pageScroll.dispose(), [pageScroll]);
  const [debug, setDebug] = useState(false);
  const openTree = useStableCallback(() =>
    useRightPanelStore.getState().open(target, "native-history"),
  );
  const [models, setModels] = useState(false);
  const [sending, setSending] = useState(false);
  const [paging, setPaging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const state = session?.state ?? {};
  const [commandCatalog, setCommandCatalog] = useState<{
    revision: number;
    commands: readonly NativeSlashCommand[];
  } | null>(null);
  const commands =
    commandCatalog?.revision === feed.commandsRevision ? commandCatalog.commands : [];
  const [dismissed, setDismissed] = useState(() => answeredDialogs.get(key) ?? new Set<string>());
  const reconnect = useNativeSessionReconnect(target);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectNow = useStableCallback(() => {
    setReconnecting(true);
    setLocalError(null);
    void reconnect()
      .catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setReconnecting(false));
  });
  // A reconnecting session still takes sends (the server holds them); an orphaned one
  // takes them by starting an owner first.
  const canSend = canOperateThread && (feed.connected || feed.ownerLoss === "orphaned");
  const ownerNotice = nativeOwnerNotice(feed.ownerLoss, session?.attachment);
  const sttEnabled = state.dictationEnabled;
  const availability = nativeDictationAvailability({
    isDesktop: isElectron,
    localEnvironmentDisabled: isLocalEnvironmentDisabled(),
    environmentId: target.environmentId,
    primaryEnvironmentId,
    connection: Option.getOrNull(preparedConnection),
    attachment: session?.attachment,
    capabilities: session?.capabilities ?? null,
    connected: feed.connected,
    sttEnabled: typeof sttEnabled === "boolean" ? sttEnabled : undefined,
  });
  const dictation = useNativeDictation({
    feed,
    request,
    composerRef,
    unavailableReason: availability.kind === "disabled" ? availability.reason : null,
  });
  const dictationShown = availability.kind !== "hidden";
  // Turning stt.enabled on happens in NeoPi's own settings, which announce nothing:
  // coming back to this window re-reads it, so the button does not stay disabled.
  const sttOff = state.dictationEnabled === false;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Window focus refreshes native dictation settings changed outside the GUI.
  useEffect(() => {
    if (!sttOff) return;
    const refresh = () => {
      void request({ type: "get_state" }).catch(() => undefined);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [sttOff, request]);
  const movedRef = feed.movedTo ?? session?.ref ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Follow NeoPi's file relocation in the external selection and tab stores.
  useEffect(() => {
    if (movedRef && movedRef.sessionFile !== target.ref.sessionFile)
      replaceNativeSession(target, { environmentId: target.environmentId, ref: movedRef });
  }, [movedRef, target]);
  const hasMoved = feed.movedTo !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A native file move invalidates the separately owned session catalog.
  useEffect(() => {
    if (hasMoved)
      appAtomRegistry.refresh(
        nativeSessionAtoms.list({ environmentId: target.environmentId, input: {} }),
      );
  }, [hasMoved, target.environmentId]);
  const loadOlder = useStableCallback(async () => {
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
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- NeoPi announcements invalidate this session's native command catalog.
  useEffect(() => {
    if (!feed.connected) return;
    const revision = feed.commandsRevision;
    let active = true;
    void request({ type: "get_available_commands" })
      .then((value) => {
        if (active) setCommandCatalog({ revision, commands: nativeSlashCommands(value) });
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
  const completeCommandArgument = useStableCallback(async (command: string, prefix: string) =>
    nativeCommandCompletions(
      await request({ type: "get_command_completions", command, prefix }),
      prefix,
    ),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe stored draft availability before applying native editor text.
  useEffect(() => {
    const editor = feed.editor;
    if (!editor || consumedEditors.get(key) === editor.id) return;
    return deferNativeEditorText({
      hasDraft: () =>
        composerDraftHasUserContent(useComposerDraftStore.getState().getComposerDraft(target)),
      apply: () => {
        consumedEditors.set(key, editor.id);
        useComposerDraftStore.getState().setPrompt(target, editor.text);
      },
      subscribe: (changed) => useComposerDraftStore.subscribe(changed),
      onDeferred: () =>
        toastManager.add({
          id: "native-editor-draft-kept",
          title: "Draft kept",
          description:
            "NeoPi provided editor text. It will be inserted after you clear or send your draft.",
          timeout: 6000,
        }),
    });
  }, [feed.editor, key, target]);
  const execute = useStableCallback(async (command: Record<string, unknown> & { type: string }) => {
    setLocalError(null);
    return executeNativeSessionCommand({
      command,
      submit: () => submit(command),
      readState: () => request({ type: "get_state" }),
      onRefreshError: setLocalError,
    });
  });
  // While NeoPi runs, a prompt steers in at the next tool boundary, which is
  // what T3's queue promises; the alternate intent waits for the whole run.
  const send = useStableCallback(async (intent?: ComposerSubmissionIntent) => {
    const snapshot = useComposerDraftStore.getState().getComposerDraft(target);
    if (!composerDraftHasUserContent(snapshot) || !snapshot || sendingRef.current || !canSend)
      return;
    if (composerRef.current?.hasPendingAttachments()) {
      setLocalError("Wait for the attachment to finish preparing before sending.");
      return;
    }
    const refocus = captureNativeComposerFocus(composerRef);
    sendingRef.current = true;
    setSending(true);
    setLocalError(null);
    try {
      const prompt = await prepareNativePrompt(target, snapshot);
      // Nothing owns the session: take it over first, so the prompt lands in a live one.
      if (!feed.connected) await reconnect();
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
      refocus();
    }
  });
  const commandOutputs = (() => {
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
  })();
  // Streaming replaces only live messages; the projector keeps the rest of the rows as they were.
  const [projectRows] = useState(createTranscriptProjector);
  const rows = projectRows(
    {
      entries: conversation.entries,
      pending: conversation.pending,
      leafId: conversation.identity?.leafId ?? null,
    },
    { debug, commandOutputs },
  );
  const queueStamp = conversation.entries.at(-1)?.timestamp ?? "";
  const queuedMessages = nativeQueuedMessages(feed.queue, queueStamp);
  const steerQueued = useStableCallback((id: string) => {
    const queued = parseNativeQueuedMessageId(id);
    if (!queued) return;
    void request({ type: "promote_queued_message", message: queued.text }).catch((cause) =>
      setLocalError(String(cause)),
    );
  });
  // Enter on an empty composer sends the oldest queued follow-up now.
  const sendNextQueuedNow = useStableCallback(() => {
    const id = nextPromotableNativeQueuedMessageId(queuedMessages);
    if (id === null) return false;
    steerQueued(id);
    return true;
  });
  const removeQueued = useStableCallback((id: string) => {
    const queued = parseNativeQueuedMessageId(id);
    if (!queued) return;
    void takeNativeQueuedInput(request, queued)
      .then(async (restoration) => {
        if (restoration === null) {
          setLocalError("That queued message has already been dispatched.");
          return;
        }
        const notice = await restoreNativeQueuedDraft(target, restoration);
        if (notice) setLocalError(notice);
        focusComposer();
      })
      .catch((cause) => setLocalError(String(cause)));
  });
  // Selecting a user message in the tree hands its text back for editing, as the
  // TUI does. A draft already in the composer stays; the notice says why.
  const onTreeNavigated = useStableCallback((answer: Record<string, unknown>) => {
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
  });
  const loadEarlier = conversation.cursor
    ? { loading: paging, cursor: conversation.cursor, onLoadEarlier: () => void loadOlder() }
    : null;
  const promptHistory = transcriptUserText(conversation.entries);
  const model = nativeRecord(state.model);
  const modelId = typeof model.id === "string" ? model.id : null;
  const thinkingLevelsKey = `${String(model.provider)}/${String(modelId)}`;
  const [thinkingLevels, setThinkingLevels] = useState<{
    readonly key: string;
    readonly levels: readonly string[];
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The active native model owns its available thinking levels.
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
  const changeTraits = useStableCallback(
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
  );
  const traits = (() => {
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
  })();
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
  const selectModel = useStableCallback((choice: NativeModelChoice) => {
    setModels(false);
    void execute(
      choice.kind === "role"
        ? { type: "set_role", role: choice.role }
        : { type: "set_model", provider: choice.provider, modelId: choice.modelId },
    ).catch((cause) => setLocalError(String(cause)));
  });
  const interrupt = useStableCallback(() => {
    void interruptNativeQueuedInput(request, session?.capabilities ?? [])
      .then(async (restoration) => {
        const notice = await restoreNativeQueuedDraft(target, restoration);
        if (notice) setLocalError(notice);
        focusComposer();
      })
      .catch((cause) => setLocalError(String(cause)));
  });
  const hideThinking = useNativeTranscriptView((state) => state.hideThinking);
  const [toolOutputSerial, setToolOutputSerial] = useState(0);
  const canCycleRole = session?.capabilities.includes(NATIVE_CYCLE_ROLE_CAPABILITY) === true;
  const runNativeCommand = useStableCallback((command: NativeSessionCommand) => {
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
          useNativeTranscriptView.getState().hideThinking ? "Reasoning hidden" : "Reasoning shown",
        );
        return;
      case "transcript.tools.toggleExpand":
        setToolOutputSerial((value) => value + 1);
        return;
    }
  });
  // Streamed tokens re-render this view, and the composer is the costliest
  // subtree on it: everything it takes stays referentially stable until its own
  // inputs change, so only keystrokes and real composer state re-render it.
  const providers = serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const modelProvider = typeof model.provider === "string" ? model.provider : null;
  const modelSelector =
    modelProvider !== null && modelId !== null ? `${modelProvider}/${modelId}` : "";
  const modelControl = (
    <NativeSessionModelPicker
      target={target}
      providers={providers}
      settings={settings}
      keybindings={keybindings}
      modelLabel={modelLabel}
      modelSelector={modelSelector}
      displayState={displayState}
      open={models}
      onOpenChange={setModels}
      disabled={sending}
      terminalOpen={terminalOpen}
      onSelect={selectModel}
    />
  );
  const nativeSessionComposer: NativeChatComposerProps["nativeSession"] = {
    modelControl,
    commands,
    attachment: session?.attachment,
    ...(completesArguments ? { completeCommandArgument } : {}),
    traits,
    onSendQueuedNow: sendNextQueuedNow,
    stepReasoningEffort: (direction) => {
      if (thinkingLevels?.key !== thinkingLevelsKey || thinkingLevels.levels.length < 2) return;
      const levels = thinkingLevels.levels;
      const current = levels.indexOf(nativeThinkingLevel ?? "");
      const next =
        current < 0
          ? direction === 1
            ? 0
            : levels.length - 1
          : (current + direction + levels.length) % levels.length;
      const level = levels[next];
      if (level !== undefined) {
        void execute({ type: "set_thinking_level", level }).catch((cause) =>
          setLocalError(cause instanceof Error ? cause.message : String(cause)),
        );
      }
    },
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
    ...(dictationShown ? { dictation } : {}),
  };
  const onComposerSend: NativeChatComposerProps["onSend"] = useStableCallback((event, intent) => {
    event?.preventDefault();
    void send(intent);
  });
  const setComposerError: NativeChatComposerProps["setThreadError"] = useStableCallback(
    (_, message) => setLocalError(message),
  );
  const openComposerFile: NativeChatComposerProps["onFileOpen"] = useStableCallback((attachment) =>
    useRightPanelStore.getState().openAttachment(target, attachment),
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
              {feed.ownerLoss === "detached" || feed.ownerLoss === "orphaned" ? (
                <HeaderIconButton label="Reconnect session" onClick={reconnectNow}>
                  <PlugIcon className="size-4" />
                </HeaderIconButton>
              ) : (
                // Stays on this tab: the feed shows the session as detached, with a way back.
                <HeaderIconButton
                  label={nativeDisconnectLabel(session?.attachment)}
                  onClick={() =>
                    void close({
                      environmentId: target.environmentId,
                      input: { ref: target.ref },
                    }).then((result) => {
                      if (result._tag === "Failure")
                        setLocalError(String(squashAtomCommandFailure(result)));
                    })
                  }
                >
                  <UnplugIcon className="size-4" />
                </HeaderIconButton>
              )}
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
        onToggleDictation={dictationShown ? dictation.toggle : undefined}
        dictationActive={dictation.phase !== "idle"}
        onNativeCommand={runNativeCommand}
      >
        {localError || (error && error !== dismissedError) ? (
          <p
            role="alert"
            className="flex shrink-0 items-start gap-2 px-5 py-1 text-xs text-destructive"
          >
            <span className="min-w-0 flex-1">{localError ?? error}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              className="shrink-0 rounded-sm p-0.5 hover:bg-destructive/10"
              onClick={() => (localError ? setLocalError(null) : setDismissedError(error))}
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          </p>
        ) : null}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <NativeTimelineView
            rows={rows}
            busy={feed.busy}
            assistantName={assistantName}
            environmentId={target.environmentId}
            nativeRef={target.ref}
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
        <ComposerSurface.Shell ref={setComposerElement} contextRow className="shrink-0">
          {ownerNotice ? (
            <div
              role="status"
              className="flex items-center gap-2 ps-(--workspace-gutter-start) pe-(--workspace-gutter-end) pt-2 text-xs text-muted-foreground"
            >
              <p className="min-w-0 flex-1">{ownerNotice.text}</p>
              {ownerNotice.action ? (
                <Button
                  size="compact"
                  variant="outline"
                  disabled={reconnecting}
                  onClick={reconnectNow}
                >
                  {ownerNotice.action}
                </Button>
              ) : null}
            </div>
          ) : null}
          {Object.values(feed.notices).some(Boolean) ? (
            <div className="flex flex-col gap-0.5 ps-(--workspace-gutter-start) pe-(--workspace-gutter-end) pt-2 text-xs text-muted-foreground">
              {Object.entries(feed.notices)
                .filter(([, notice]) => Boolean(notice))
                .map(([id, notice]) => (
                  <p key={id} className="whitespace-pre-wrap">
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
              canOperateThread={canOperateThread}
              canInterrupt={canOperateThread && feed.busy}
              attachmentUploadsCapabilityKnown={serverConfig !== null}
              supportsAttachmentUploads={
                serverConfig?.environment.capabilities.attachmentUploads === true
              }
              maxFileAttachmentBytes={
                fileAttachmentBytes === null
                  ? null
                  : clampFileAttachmentUploadBytes(fileAttachmentBytes)
              }
              phase={
                feed.connected
                  ? feed.busy
                    ? "running"
                    : "ready"
                  : feed.ownerLoss === "orphaned"
                    ? "ready"
                    : "disconnected"
              }
              isConnecting={loading}
              isSendBusy={sending}
              sendDisabledReason={
                !canOperateThread
                  ? "This connection cannot change sessions."
                  : canSend
                    ? null
                    : "Reconnect NeoPi before sending."
              }
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
              onSend={onComposerSend}
              onInterrupt={interrupt}
              focusComposer={focusComposer}
              setThreadError={setComposerError}
              onExpandImage={setExpandedImage}
              onFileOpen={openComposerFile}
              nativeSession={nativeSessionComposer}
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

function NativeSessionDialog({
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
                ? nativeValueItems(dialog.details).map(({ key, value: detail }) => (
                    <p key={key} className="text-sm">
                      {String(detail)}
                    </p>
                  ))
                : null}
              {Array.isArray(dialog.safetyChecks)
                ? nativeValueItems(dialog.safetyChecks).map(({ key, value: item }) => {
                    const check = nativeRecord(item);
                    return (
                      <p key={key} role="alert" className="text-sm text-destructive">
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
            ? nativeValueItems(dialog.options).map(({ key, value: option }) => (
                <div key={key}>
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
                {nativeValueItems(Array.isArray(question.options) ? question.options : []).map(
                  ({ key, value: item }) => {
                    const option = nativeRecord(item);
                    const label = String(option.label);
                    return (
                      <label key={key} className="flex items-center gap-2 text-sm">
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
                  },
                )}
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
