import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  nativeCatalogModels,
  nativeRecord,
  nativeSessionKey,
  nativeTranscriptRows,
  type NativeSessionTarget,
  type NativeTranscriptRow,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { journalEntryLabel } from "@t3tools/client-runtime/neopi-journal";
import { createNativeSubmissionFollow } from "@t3tools/client-runtime/neopi-submission-follow";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  nativeSessionAtoms,
  selectNativeSession,
  useNativeSession,
  useNativeSessionSelection,
} from "../../state/neopiNativeSessions";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import { SidebarInset } from "../ui/sidebar";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { isElectron } from "../../env";
import { NeoPiJournalContent } from "./NeoPiJournalContent";
import { useCreateNativeSession } from "./NativeSessionSidebar";
import { NativeSessionTree } from "./NativeSessionTree";
import { NativeCommandOutput } from "./NativeCommandOutput";
import { NeoPiTerminalHandoff } from "./NeoPiTerminalHandoff";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  useComposerThreadDraft,
  type ComposerImageAttachment,
  type ComposerFileAttachment,
} from "../../composerDraftStore";
import { useComposerHandleContext } from "../../composerHandleContext";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { useRightPanelStore } from "../../rightPanelStore";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { ChatComposer, type ChatComposerHandle } from "../chat/ChatComposer";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { createPageScrollController } from "../chat/pageScrollController";
import { NativeSessionWorkspacePanels } from "./NativeSessionWorkspacePanels";
import { consumeNativeDraft, prepareNativePrompt } from "./neopiNativeComposer";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";

type Request = ReturnType<typeof useNativeSession>["request"];
const answeredDialogs = new Map<string, Set<string>>();
const consumedEditors = new Map<string, string>();

export function NativeSessionWorkspace() {
  const target = useNativeSessionSelection((state) => state.target);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      {target ? (
        <NativeSessionView key={nativeSessionKey(target)} target={target} />
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
      <WorkspacePageHeader electron={isElectron} />
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

export function NativeSessionView({ target }: { target: NativeSessionTarget }) {
  const { feed, session, conversation, request, loading, error } = useNativeSession(target);
  const close = useAtomCommand(nativeSessionAtoms.close, { reportFailure: false });
  const key = nativeSessionKey(target);
  const draft = useComposerThreadDraft(target);
  const draftStore = useComposerDraftStore;
  const settings = useEnvironmentSettings(target.environmentId);
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const fileAttachmentBytes =
    serverConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const terminalOpen = useTerminalUiStateStore(
    (value) => selectThreadTerminalUiState(value.terminalUiStateByThreadKey, target).terminalOpen,
  );
  const promptRef = useRef(draft.prompt);
  const imagesRef = useRef<ComposerImageAttachment[]>([]);
  const filesRef = useRef<ComposerFileAttachment[]>([]);
  const terminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const timelineHostRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<LegendListRef | null>(null);
  const followRevisionRef = useRef(conversation.revision);
  followRevisionRef.current = conversation.revision;
  const followRowsRef = useRef<readonly NativeTranscriptRow[]>([]);
  const submissionFollow = useMemo(
    () =>
      createNativeSubmissionFollow({
        scheduleFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (frame) => cancelAnimationFrame(frame),
        readLayout: () => {
          const list = timelineRef.current;
          const viewport = list?.getScrollableNode() as HTMLElement | undefined;
          if (!list || !viewport) return null;
          const rows = followRowsRef.current;
          const last = rows.at(-1);
          const state = list.getState();
          const measured =
            !!last &&
            state.indexByKey(last.id) === state.data.length - 1 &&
            state.sizes.has(last.id);
          return {
            measured,
            atEnd: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1,
            revision: JSON.stringify([
              last?.id,
              followRevisionRef.current,
              state.sizes.get(last?.id ?? ""),
              viewport.scrollHeight,
              viewport.clientHeight,
              viewport.scrollTop,
            ]),
          };
        },
        scrollToEnd: () => {
          void timelineRef.current?.scrollToEnd({ animated: false });
        },
      }),
    [],
  );
  const cancelSubmissionFollow = useCallback(() => {
    if (!submissionFollow.cancel()) return;
    // LegendList may still have a pending estimated-index scroll. Supersede it
    // before applying the user's navigation, as the stock timeline does.
    const list = timelineRef.current;
    const viewport = list?.getScrollableNode() as HTMLElement | undefined;
    if (viewport) void list?.scrollToOffset({ offset: viewport.scrollTop, animated: false });
  }, [submissionFollow]);
  useEffect(() => cancelSubmissionFollow, [cancelSubmissionFollow]);
  const submit = useCallback<Request>(
    async (command, attachments) => {
      if (command.type !== "prompt") {
        cancelSubmissionFollow();
        return request(command, attachments);
      }
      cancelSubmissionFollow();
      const generation = submissionFollow.begin();
      try {
        const result = await request(command, attachments);
        submissionFollow.accept(generation);
        return result;
      } catch (cause) {
        submissionFollow.reject(generation);
        throw cause;
      }
    },
    [request, cancelSubmissionFollow, submissionFollow],
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
        getContainer: () =>
          timelineHostRef.current?.querySelector<HTMLElement>(".overflow-auto") ?? null,
        getScrollPaddingBottomPx: () => 0,
        onScrollStart: cancelSubmissionFollow,
      }),
    [cancelSubmissionFollow],
  );
  useEffect(() => () => pageScroll.dispose(), [pageScroll]);
  const [debug, setDebug] = useState(false);
  const [tree, setTree] = useState(false);
  const [models, setModels] = useState(false);
  const [sending, setSending] = useState(false);
  const [paging, setPaging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, unknown>>({});
  const [commands, setCommands] = useState<readonly Record<string, unknown>[]>([]);
  const [dismissed, setDismissed] = useState(() => answeredDialogs.get(key) ?? new Set<string>());
  useEffect(() => {
    if (session) setState(session.state);
  }, [session]);
  useEffect(() => {
    if (session && session.ref.sessionFile !== target.ref.sessionFile)
      selectNativeSession({ environmentId: target.environmentId, ref: session.ref });
  }, [session, target.environmentId, target.ref.sessionFile]);
  const loadOlder = async () => {
    cancelSubmissionFollow();
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
  useEffect(() => {
    if (!feed.connected) return;
    let active = true;
    void request({ type: "get_available_commands" })
      .then((value) => {
        const items = nativeRecord(value).commands;
        if (active && Array.isArray(items)) setCommands(items.map(nativeRecord));
      })
      .catch((cause) => {
        if (active) setLocalError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [feed.connected, request]);
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
  const send = useCallback(async () => {
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
      await submit(
        {
          type: "prompt",
          message: prompt.message,
          ...((nativeSessionAtoms.cached(target)?.busy ?? feed.busy)
            ? { streamingBehavior: "followUp" }
            : {}),
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
  }, [target, feed.connected, feed.busy, submit, composerRef, focusComposer]);
  const rows = useMemo(
    () => nativeTranscriptRows({ conversation, commandOutputs: feed.commandOutputs }, debug),
    [conversation, feed.commandOutputs, debug],
  );
  followRowsRef.current = rows;
  useEffect(() => {
    if (!feed.connected) cancelSubmissionFollow();
    else submissionFollow.changed();
  }, [rows, feed.connected, submissionFollow, cancelSubmissionFollow]);
  const renderEntry = useCallback(
    ({ item }: { item: NativeTranscriptRow }) =>
      item.kind === "command" ? (
        <article
          className="mx-auto w-full max-w-(--chat-max-width) px-5 py-4"
          aria-label="Command output"
        >
          <NativeCommandOutput text={item.text} />
        </article>
      ) : (
        <article
          className="mx-auto w-full max-w-(--chat-max-width) px-5 py-4"
          data-native-entry-id={item.entry.id}
        >
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {journalEntryLabel(item.entry)}
          </p>
          <NeoPiJournalContent
            entry={item.entry}
            environmentId={target.environmentId}
            nativeRef={session?.ref ?? target.ref}
            cwd={session?.cwd}
          />
        </article>
      ),
    [target.environmentId, target.ref, session?.ref, session?.cwd],
  );
  const promptHistory = useMemo(
    () =>
      conversation.entries.flatMap((entry) => {
        const message = nativeRecord(entry.message);
        if (entry.type !== "message" || message.role !== "user") return [];
        const text =
          typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .map((part) => nativeRecord(part))
                  .flatMap((part) =>
                    part.type === "text" && typeof part.text === "string" ? [part.text] : [],
                  )
                  .join("\n")
              : "";
        return [{ id: entry.id, role: "user", text }];
      }),
    [conversation.entries],
  );
  const model = nativeRecord(state.model);
  const nativeCommands = useMemo(
    () =>
      commands.flatMap((command) =>
        typeof command.name === "string"
          ? [
              {
                name: command.name,
                ...(typeof command.description === "string"
                  ? { description: command.description }
                  : {}),
              },
            ]
          : [],
      ),
    [commands],
  );
  const interrupt = useCallback(() => {
    void execute({ type: "abort" }).catch((cause) => setLocalError(String(cause)));
  }, [execute]);
  const dialog = feed.dialogs.find(
    (item) => typeof item.id === "string" && !dismissed.has(item.id),
  );
  return (
    <>
      <WorkspacePageHeader electron={isElectron}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm">
            {String(state.sessionName ?? "Native conversation")}
          </span>
          <span className="truncate text-xs text-muted-foreground">{session?.cwd}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setTree(true)}>
          Session tree
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            cancelSubmissionFollow();
            setDebug((value) => !value);
          }}
          aria-pressed={debug}
        >
          Debug
        </Button>
        <NeoPiTerminalHandoff target={target} connected={feed.connected} />
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void close({ environmentId: target.environmentId, input: { ref: target.ref } }).then(
              (result) => {
                if (result._tag === "Failure")
                  setLocalError(String(squashAtomCommandFailure(result)));
                else selectNativeSession(null);
              },
            )
          }
        >
          Disconnect session
        </Button>
      </WorkspacePageHeader>
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
        onOpenTree={() => setTree(true)}
        onOpenModels={() => setModels((value) => !value)}
        onInterrupt={interrupt}
        busy={feed.busy}
      >
        <div role="status" className="shrink-0 px-5 py-1 text-xs text-muted-foreground">
          {feed.connected
            ? feed.busy
              ? "Working"
              : session?.attachment === "terminal"
                ? "Attached to terminal"
                : "Ready"
            : loading
              ? "Connecting…"
              : "Reconnecting · showing cached conversation"}
        </div>
        {error || localError ? (
          <p role="alert" className="shrink-0 px-5 py-1 text-xs text-destructive">
            {localError ?? error}
          </p>
        ) : null}
        <div
          ref={timelineHostRef}
          className="flex min-h-0 flex-1 flex-col"
          onWheelCapture={cancelSubmissionFollow}
          onKeyDownCapture={(event) => {
            if (
              ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
            )
              cancelSubmissionFollow();
          }}
          onPointerDownCapture={cancelSubmissionFollow}
        >
          <LegendList
            ref={timelineRef}
            data={rows}
            keyExtractor={(entry) => entry.id}
            renderItem={renderEntry}
            estimatedItemSize={160}
            recycleItems
            maintainVisibleContentPosition
            maintainScrollAtEnd={{ animated: false }}
            maintainScrollAtEndThreshold={0.1}
            onItemSizeChanged={submissionFollow.changed}
            onLayout={submissionFollow.changed}
            onLoad={submissionFollow.changed}
            onScroll={submissionFollow.changed}
            ListHeaderComponent={
              conversation.cursor ? (
                <div className="p-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={paging}
                    onClick={() => void loadOlder()}
                  >
                    Load earlier messages
                  </Button>
                </div>
              ) : null
            }
            className="min-h-0 flex-1 overflow-auto"
          />
        </div>
        <div
          ref={setComposerElement}
          className="shrink-0 border-t px-4 pb-4 pt-2"
          data-slot="composer-shell"
        >
          {Object.values(feed.notices)
            .filter(Boolean)
            .map((notice, index) => (
              <p key={index} className="mb-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {notice}
              </p>
            ))}
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
            onSend={(event) => {
              event?.preventDefault();
              void send();
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
              modelLabel: String(model.name ?? model.id ?? "Choose native model"),
              displayState:
                [
                  state.thinkingLevel,
                  typeof state.chatMode === "string" ? `Chat: ${state.chatMode}` : null,
                ]
                  .filter((value) => typeof value === "string")
                  .join(" · ") || null,
              commands: nativeCommands,
              promptHistory,
              modelPickerOpen: models,
              onOpenModelPicker: () => setModels(true),
              onOpenSessionTree: () => setTree(true),
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
            }}
          />
        </div>
      </NativeSessionWorkspacePanels>
      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
      {models ? (
        <NativeSessionModelDialog
          request={execute}
          onClose={() => setModels(false)}
          onReturnFocus={focusComposer}
        />
      ) : null}
      {tree ? (
        <NativeSessionTree
          target={target}
          request={execute}
          onClose={() => setTree(false)}
          onReturnFocus={focusComposer}
        />
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
    </>
  );
}

export function NativeSessionModelDialog({
  request,
  onClose,
  onReturnFocus,
}: {
  request: Request;
  onClose: () => void;
  onReturnFocus?: () => void;
}) {
  const [catalog, setCatalog] = useState<ReturnType<typeof nativeCatalogModels>>([]);
  const [roles, setRoles] = useState<readonly Record<string, unknown>[]>([]);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([request({ type: "get_available_models" }), request({ type: "get_roles" })])
      .then(([models, result]) => {
        if (!active) return;
        setCatalog(nativeCatalogModels(models));
        const items = nativeRecord(result).roles;
        if (Array.isArray(items)) setRoles(items.map(nativeRecord));
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [request]);
  const select = async (command: Record<string, unknown> & { type: string }) => {
    setPending(true);
    try {
      await request(command);
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        finalFocus={
          onReturnFocus
            ? () => {
                onReturnFocus();
                return false;
              }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>Session model</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-4">
          <Input
            aria-label="Search native models and roles"
            placeholder="Search models and roles"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="max-h-80 overflow-auto">
            {roles
              .filter(
                (role) =>
                  role.hidden !== true &&
                  `${role.name} ${role.id}`.toLowerCase().includes(query.toLowerCase()),
              )
              .map((role) => (
                <div key={String(role.id)}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => void select({ type: "set_role", role: role.id })}
                  >
                    {String(role.alias ?? role.id)}
                  </Button>
                </div>
              ))}
            {catalog
              .filter((model) =>
                `${model.name} ${model.provider}/${model.id}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((model) => (
                <div key={`${model.provider}/${model.id}`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      void select({
                        type: "set_model",
                        provider: model.provider,
                        modelId: model.id,
                      })
                    }
                  >
                    {model.name} · {model.provider}
                  </Button>
                </div>
              ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
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
