import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { workspaceKey } from "@t3tools/client-runtime/environment";
import {
  NATIVE_COMMAND_COMPLETIONS_CAPABILITY,
  deferNativeEditorText,
  executeNativeSessionCommand,
  nativeCatalogModels,
  nativeCommandCompletions,
  nativeDisconnectLabel,
  nativeValueItems,
  nativeOwnerNotice,
  nativeRecord,
  nativeSessionKey,
  nativeSlashArgument,
  nativeSlashCommands,
  nativeTranscriptRows,
  type NativeCommandCompletion,
  type NativeSessionTarget,
  type NativeSlashCommand,
  type NativeTranscriptRow,
} from "@t3tools/client-runtime/neopi-native-sessions";
import {
  interruptNativeQueuedInput,
  takeNativeQueuedInput,
} from "@t3tools/client-runtime/neopi-native-queue";
import { journalEntryLabel } from "@t3tools/client-runtime/neopi-journal";
import { createNativeSubmissionFollow } from "@t3tools/client-runtime/neopi-submission-follow";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { AppBar } from "../../components/ui/AppBar";
import {
  nativeSessionAtoms,
  useNativeSession,
  useNativeSessionReconnect,
} from "../../state/neopiNativeSessions";
import { useNativeComposerState } from "../../state/use-native-composer-state";
import {
  composerDraftsAtom,
  getComposerDraftSnapshot,
  relocateComposerDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { restoreNativeMobileQueuedDraft } from "../../state/native-queued-draft";
import { NativeSessionComposer } from "./NativeSessionComposer";
import {
  NativeSessionWorkspaceControls,
  NativeSessionAgents,
} from "./NativeSessionWorkspaceControls";
import { NativeField, NativeModal, NativeError } from "./NativeNeoPiControls";
import { NeoPiJournalContent } from "./NeoPiJournalContent";
import { NativeCommandOutput } from "./NativeCommandOutput";
import { NativeSessionMobileTree } from "./NativeSessionMobileTree";
import { NeoPiModelsEntry } from "./NeoPiModelsScreen";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

type Params = { environmentId: string; providerInstanceId: string; sessionFile: string };
type Request = ReturnType<typeof useNativeSession>["request"];
const answered = new Map<string, Set<string>>();
const editors = new Map<string, string>();
export function NativeSessionScreen({ route }: StaticScreenProps<Params>) {
  const target = useMemo(
    () => ({
      environmentId: EnvironmentId.make(route.params.environmentId),
      ref: {
        providerInstanceId: ProviderInstanceId.make(route.params.providerInstanceId),
        sessionFile: route.params.sessionFile,
      },
    }),
    [route.params.environmentId, route.params.providerInstanceId, route.params.sessionFile],
  );
  return <NativeSessionBody key={nativeSessionKey(target)} target={target} />;
}
function createNativeMobileTimeline() {
  let list: FlatList<NativeTranscriptRow> | null = null;
  let rows: readonly NativeTranscriptRow[] = [];
  let revision = 0;
  const layout = { height: 0, viewport: 0, offset: 0 };
  const measuredRows = new Map<string, number>();
  const scrollToEnd = () => list?.scrollToEnd({ animated: false });
  const follow = createNativeSubmissionFollow({
    scheduleFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (frame) => cancelAnimationFrame(frame),
    readLayout: () => {
      const last = rows.at(-1);
      return {
        measured: !!last && measuredRows.has(last.id) && layout.viewport > 0,
        atEnd: layout.height - layout.viewport - layout.offset <= 1,
        revision: JSON.stringify([
          last?.id,
          revision,
          measuredRows.get(last?.id ?? ""),
          layout.height,
          layout.viewport,
          layout.offset,
        ]),
      };
    },
    scrollToEnd,
  });
  return {
    follow,
    scrollToEnd,
    setList: (value: FlatList<NativeTranscriptRow> | null) => {
      list = value;
    },
    setEntries: (value: readonly NativeTranscriptRow[], nextRevision: number) => {
      rows = value;
      revision = nextRevision;
    },
    setViewportHeight: (height: number) => {
      layout.viewport = height;
      follow.changed();
    },
    setContentHeight: (height: number) => {
      layout.height = height;
      follow.changed();
    },
    setLayout: (height: number, viewport: number, offset: number) => {
      layout.height = height;
      layout.viewport = viewport;
      layout.offset = offset;
      follow.changed();
    },
    measureRow: (id: string, height: number) => {
      measuredRows.set(id, height);
      follow.changed();
    },
  };
}

function NativeSessionBody({ target }: { target: NativeSessionTarget }) {
  const { feed, request, error } = useNativeSession(target);
  const nearEndRef = useRef(false);
  const [
    {
      follow: submissionFollow,
      scrollToEnd: scrollTimelineToEnd,
      setList: setTimelineList,
      setEntries: setTimelineEntries,
      setViewportHeight,
      setContentHeight,
      setLayout: setTimelineLayout,
      measureRow,
    },
  ] = useState(createNativeMobileTimeline);
  const cancelSubmissionFollow = useCallback(() => {
    submissionFollow.cancel();
  }, [submissionFollow]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release any scheduled native scroll frame on unmount.
  useEffect(() => cancelSubmissionFollow, [cancelSubmissionFollow]);
  const reconnect = useNativeSessionReconnect(target);
  const submit = useCallback<Request>(
    async (command, attachments) => {
      if (command.type === "prompt" && !nativeSessionAtoms.cached(target)?.connected)
        await reconnect();
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
    [request, cancelSubmissionFollow, submissionFollow, reconnect, target],
  );
  const composer = useNativeComposerState({
    target,
    request: submit,
    // A reconnecting session holds sends on the server; an orphaned one takes them by
    // starting an owner first (see `submit`).
    connected: feed.connected || feed.ownerLoss === "orphaned",
  });
  const close = useAtomCommand(nativeSessionAtoms.close, { reportFailure: false });
  const [paging, setPaging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectNow = useCallback(() => {
    setReconnecting(true);
    setLocalError(null);
    void reconnect()
      .catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setReconnecting(false));
  }, [reconnect]);
  const ownerNotice = nativeOwnerNotice(feed.ownerLoss, feed.session?.attachment);
  const [editorNotice, setEditorNotice] = useState<{ id: string; text: string } | null>(null);
  const [models, setModels] = useState(false);
  const [tree, setTree] = useState(false);
  const [debug, setDebug] = useState(false);
  const [agents, setAgents] = useState(false);
  const state = feed.session?.state ?? {};
  const [commandCatalog, setCommandCatalog] = useState<{
    revision: number;
    commands: readonly NativeSlashCommand[];
  } | null>(null);
  const commands =
    commandCatalog?.revision === feed.commandsRevision ? commandCatalog.commands : [];
  const [completions, setCompletions] = useState<{
    readonly command: string;
    readonly prefix: string;
    readonly items: readonly NativeCommandCompletion[];
  } | null>(null);
  const key = nativeSessionKey(target);
  const [dismissed, setDismissed] = useState(() => answered.get(key) ?? new Set<string>());
  const navigation = useNavigation();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Native navigation blur cancels the pending scroll frame.
  useEffect(
    () => navigation.addListener("blur", cancelSubmissionFollow),
    [navigation, cancelSubmissionFollow],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Relocate the persisted draft before replacing a moved native route.
  useEffect(() => {
    const movedRef = feed.movedTo ?? feed.session?.ref;
    if (!movedRef || movedRef.sessionFile === target.ref.sessionFile) return;
    let active = true;
    void relocateComposerDraft(
      composer.key,
      workspaceKey({ environmentId: target.environmentId, ref: movedRef }),
    ).then(
      () => {
        if (active)
          navigation.dispatch(
            StackActions.replace("NativeSession", {
              environmentId: target.environmentId,
              ...movedRef,
            }),
          );
      },
      (cause) => {
        if (active) setLocalError(String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [feed.movedTo, feed.session?.ref, target, composer.key, navigation]);
  const loadOlder = async () => {
    cancelSubmissionFollow();
    nearEndRef.current = false;
    if (paging || !feed.conversation.cursor) return;
    setPaging(true);
    try {
      await request({
        type: "get_entries_page",
        scope: "branch",
        direction: "backward",
        limit: 128,
        cursor: feed.conversation.cursor,
      });
    } catch (cause) {
      setLocalError(String(cause));
    } finally {
      setPaging(false);
    }
  };
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
  const argument = nativeSlashArgument(composer.draft.text);
  const argumentCommand =
    argument &&
    feed.session?.capabilities.includes(NATIVE_COMMAND_COMPLETIONS_CAPABILITY) &&
    commands.some(
      (command) => command.name === argument.command || command.aliases?.includes(argument.command),
    )
      ? argument.command
      : null;
  const argumentPrefix = argumentCommand ? (argument?.prefix ?? "") : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Debounce native completion requests and cancel superseded answers.
  useEffect(() => {
    if (argumentCommand === null || argumentPrefix === null) return;
    let active = true;
    const timer = setTimeout(() => {
      void request({
        type: "get_command_completions",
        command: argumentCommand,
        prefix: argumentPrefix,
      })
        .then((value) => {
          if (active)
            setCompletions({
              command: argumentCommand,
              prefix: argumentPrefix,
              items: nativeCommandCompletions(value, argumentPrefix),
            });
        })
        .catch(() => {
          if (active)
            setCompletions({ command: argumentCommand, prefix: argumentPrefix, items: [] });
        });
    }, 80);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [argumentCommand, argumentPrefix, request]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe persisted draft availability before applying native editor text.
  useEffect(() => {
    const editor = feed.editor;
    if (!editor || editors.get(key) === editor.id) return;
    let active = true;
    let cancel = () => {};
    void waitForComposerDraftsLoaded()
      .then(() => {
        if (!active || editors.get(key) === editor.id) return;
        cancel = deferNativeEditorText({
          hasDraft: () => {
            const draft = getComposerDraftSnapshot(composer.key);
            return !!(draft.text || draft.attachments.length || draft.context?.records.length);
          },
          apply: () => {
            editors.set(key, editor.id);
            setEditorNotice(null);
            setComposerDraftText(composer.key, editor.text);
          },
          subscribe: (changed) => appAtomRegistry.subscribe(composerDraftsAtom, changed),
          onDeferred: () =>
            setEditorNotice({
              id: editor.id,
              text: "Draft kept. NeoPi's editor text will be inserted after you clear or send your draft.",
            }),
        });
      })
      .catch((cause) => {
        if (active) setLocalError(String(cause));
      });
    return () => {
      active = false;
      cancel();
    };
  }, [feed.editor, key, composer.key]);
  const execute = useCallback<Request>(
    async (command, attachments) => {
      setLocalError(null);
      return executeNativeSessionCommand({
        command,
        submit: () => submit(command, attachments),
        readState: () => request({ type: "get_state" }),
        onRefreshError: setLocalError,
      });
    },
    [request, submit],
  );
  const removeQueued = useCallback(
    (queued: { text: string; lane: "steering" | "followUp" }) => {
      void takeNativeQueuedInput(request, queued)
        .then(async (restoration) => {
          if (restoration === null) {
            setLocalError("That queued message has already been dispatched.");
            return;
          }
          const notice = await restoreNativeMobileQueuedDraft(target, restoration);
          if (notice) setLocalError(notice);
        })
        .catch((cause) => setLocalError(String(cause)));
    },
    [request, target],
  );
  const interrupt = useCallback(() => {
    void interruptNativeQueuedInput(request, feed.session?.capabilities ?? [])
      .then(async (restoration) => {
        const notice = await restoreNativeMobileQueuedDraft(target, restoration);
        if (notice) setLocalError(notice);
      })
      .catch((cause) => setLocalError(String(cause)));
  }, [request, target, feed.session?.capabilities]);
  const rows = useMemo(
    () =>
      nativeTranscriptRows(
        { conversation: feed.conversation, commandOutputs: feed.commandOutputs },
        debug,
      ),
    [feed.conversation, feed.commandOutputs, debug],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The native scroll controller reads only committed rows and layout.
  useLayoutEffect(() => {
    setTimelineEntries(rows, feed.conversation.revision);
    if (!feed.connected) cancelSubmissionFollow();
    else submissionFollow.changed();
  }, [
    rows,
    feed.conversation.revision,
    feed.connected,
    setTimelineEntries,
    submissionFollow,
    cancelSubmissionFollow,
  ]);
  const model = nativeRecord(state.model);
  const suggestions =
    composer.draft.text.startsWith("/") &&
    !composer.draft.text.includes(" ") &&
    !composer.draft.text.includes("\n")
      ? commands
          .filter((command) => `/${command.name}`.startsWith(composer.draft.text))
          .slice(0, 10)
      : [];
  const argumentSuggestions =
    argumentCommand &&
    completions?.command === argumentCommand &&
    completions.prefix === argumentPrefix
      ? completions.items.filter((item) => item.value !== argumentPrefix).slice(0, 10)
      : [];
  const dialog = feed.dialogs.find(
    (dialog) => typeof dialog.id === "string" && !dismissed.has(dialog.id),
  );
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-screen"
    >
      <AppBar
        title={String(state.sessionName ?? "Conversation")}
        onBack={() => navigation.dispatch(StackActions.popTo("Home"))}
        actions={[
          {
            accessibilityLabel: "Session tree",
            icon: "arrow.triangle.branch",
            onPress: () => setTree(true),
          },
        ]}
      />
      {ownerNotice ? (
        <View className="gap-1 px-4 py-1">
          <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
            {ownerNotice.text}
          </Text>
          {ownerNotice.action ? (
            <Button
              label={ownerNotice.action}
              tone="text"
              disabled={reconnecting}
              onPress={reconnectNow}
            />
          ) : null}
        </View>
      ) : !feed.connected || feed.busy ? (
        <Text accessibilityLiveRegion="polite" className="px-4 py-1 text-xs text-foreground-muted">
          {feed.connected ? "Working" : "Reconnecting · showing cached conversation"}
        </Text>
      ) : null}
      <View className="px-4">
        <NativeError message={localError ?? error} />
      </View>
      {editorNotice && editorNotice.id === feed.editor?.id ? (
        <Text accessibilityLiveRegion="polite" className="px-4 py-1 text-xs text-foreground-muted">
          {editorNotice.text}
        </Text>
      ) : null}
      <FlatList
        ref={setTimelineList}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onTouchStart={cancelSubmissionFollow}
        onLayout={({ nativeEvent }) => setViewportHeight(nativeEvent.layout.height)}
        onScrollBeginDrag={() => {
          cancelSubmissionFollow();
          nearEndRef.current = false;
        }}
        onScroll={({ nativeEvent }) => {
          setTimelineLayout(
            nativeEvent.contentSize.height,
            nativeEvent.layoutMeasurement.height,
            nativeEvent.contentOffset.y,
          );
          nearEndRef.current =
            nativeEvent.contentSize.height -
              nativeEvent.layoutMeasurement.height -
              nativeEvent.contentOffset.y <=
            nativeEvent.layoutMeasurement.height * 0.1;
        }}
        scrollEventThrottle={16}
        onContentSizeChange={(_, height) => {
          setContentHeight(height);
          if (nearEndRef.current) scrollTimelineToEnd();
        }}
        data={rows}
        keyExtractor={(entry) => entry.id}
        ListHeaderComponent={
          feed.conversation.cursor ? (
            <Button
              label="Load earlier messages"
              tone="text"
              disabled={paging}
              onPress={() => void loadOlder()}
            />
          ) : undefined
        }
        renderItem={({ item }) =>
          item.kind === "command" ? (
            <View
              className="px-4 py-3"
              accessibilityLabel="Command output"
              onLayout={({ nativeEvent }) => measureRow(item.id, nativeEvent.layout.height)}
            >
              <NativeCommandOutput text={item.text} />
            </View>
          ) : (
            <View
              className="gap-2 px-4 py-3"
              onLayout={({ nativeEvent }) => measureRow(item.id, nativeEvent.layout.height)}
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                {journalEntryLabel(item.entry)}
              </Text>
              <NeoPiJournalContent
                entry={item.entry}
                environmentId={target.environmentId}
                nativeRef={feed.session?.ref ?? target.ref}
                cwd={feed.session?.cwd ?? null}
              />
            </View>
          )
        }
      />
      <View className="gap-2 border-t border-border px-4 py-3">
        {[
          ...feed.queue.steering.map((text, index) => ({ lane: "steering" as const, text, index })),
          ...feed.queue.followUp.map((text, index) => ({ lane: "followUp" as const, text, index })),
        ].map((queued) => (
          <View
            key={`${queued.lane}:${queued.index}`}
            className="flex-row items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2"
          >
            <Text className="flex-1 text-sm text-foreground-muted" numberOfLines={2}>
              {upgradeLegacyContextMessage(queued.text).text || "Queued message"}
            </Text>
            {queued.lane === "steering" && queued.index < feed.queue.liveSteered ? (
              <Text className="text-xs text-foreground-muted">Sending</Text>
            ) : (
              <Button label="Cancel" tone="text" onPress={() => removeQueued(queued)} />
            )}
          </View>
        ))}
        {Object.entries(feed.notices)
          .filter(([, notice]) => Boolean(notice))
          .map(([id, notice]) => (
            <Text key={id} className="text-xs text-foreground-muted">
              {notice}
            </Text>
          ))}
        <NativeSessionComposer
          target={target}
          cwd={feed.session?.cwd ?? null}
          composer={composer}
          busy={feed.busy}
          commands={suggestions}
          argumentCommand={argumentCommand}
          argumentSuggestions={argumentSuggestions}
          attachment={feed.session?.attachment}
          workspaceControls={
            <NativeSessionWorkspaceControls
              target={target}
              cwd={feed.session?.cwd ?? null}
              agentCount={feed.agents.length}
              onOpenAgents={() => setAgents(true)}
              onError={setLocalError}
            />
          }
          onStop={interrupt}
        />
        <View className="flex-row flex-wrap items-center gap-2">
          <Button
            label={String(model.name ?? model.id ?? "Choose model")}
            tone="text"
            onPress={() => setModels(true)}
          />
          <Button
            label={debug ? "Hide debug" : "Debug"}
            tone="text"
            onPress={() => {
              cancelSubmissionFollow();
              nearEndRef.current = false;
              setDebug((value) => !value);
            }}
          />
        </View>
        <NeoPiModelsEntry environmentId={target.environmentId} target={target.ref} />
        {feed.ownerLoss === "detached" || feed.ownerLoss === "orphaned" ? (
          <Button
            label="Reconnect session"
            tone="text"
            disabled={reconnecting}
            onPress={reconnectNow}
          />
        ) : (
          // Stays on this screen: the feed shows the session as detached, with a way back.
          <Button
            label={nativeDisconnectLabel(feed.session?.attachment)}
            tone="text"
            onPress={() =>
              void close({ environmentId: target.environmentId, input: { ref: target.ref } }).then(
                (result) => {
                  if (result._tag === "Failure")
                    setLocalError(String(squashAtomCommandFailure(result)));
                },
              )
            }
          />
        )}
      </View>
      {agents ? (
        <NativeSessionAgents agents={feed.agents} onClose={() => setAgents(false)} />
      ) : null}
      {models ? (
        <NativeMobileModels
          request={execute}
          rolesSupported={feed.session?.capabilities.includes("get_roles") ?? false}
          onClose={() => setModels(false)}
        />
      ) : null}
      {tree ? (
        <NativeSessionMobileTree target={target} request={execute} onClose={() => setTree(false)} />
      ) : null}
      {dialog ? (
        <NativeMobileDialog
          key={String(dialog.id)}
          dialog={dialog}
          request={request}
          onAnswered={() => {
            const next = new Set(dismissed).add(String(dialog.id));
            answered.set(key, next);
            setDismissed(next);
          }}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

export function NativeMobileModels({
  request,
  rolesSupported,
  onClose,
}: {
  request: Request;
  rolesSupported: boolean;
  onClose: () => void;
}) {
  const [models, setModels] = useState<ReturnType<typeof nativeCatalogModels>>([]);
  const [roleResult, setRoleResult] = useState<{
    request: Request;
    roles: readonly Record<string, unknown>[];
    error: string | null;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roles = rolesSupported && roleResult?.request === request ? roleResult.roles : [];
  const rolesError = rolesSupported && roleResult?.request === request ? roleResult.error : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Query the open session's native catalog and discard replies after closing.
  useEffect(() => {
    let active = true;
    void request({ type: "get_available_models" })
      .then((value) => {
        if (active) setModels(nativeCatalogModels(value));
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [request]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Capability-gated native roles belong to this open picker request.
  useEffect(() => {
    if (!rolesSupported) return;
    let active = true;
    void request({ type: "get_roles" })
      .then((value) => {
        const items = nativeRecord(value).roles;
        if (active)
          setRoleResult({
            request,
            roles: Array.isArray(items) ? items.map(nativeRecord) : [],
            error: null,
          });
      })
      .catch((cause) => {
        if (active)
          setRoleResult({ request, roles: [], error: `Could not load roles: ${String(cause)}` });
      });
    return () => {
      active = false;
    };
  }, [request, rolesSupported]);
  const choose = async (command: Record<string, unknown> & { type: string }) => {
    if (pending) return;
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
    <NativeModal title="Session model" onClose={onClose}>
      <View className="gap-3 px-4 pb-3">
        <NativeField label="Search models and roles" value={query} onChange={setQuery} />
        <NativeError message={error} />
        <NativeError message={rolesError} />
        {!rolesSupported ? (
          <Text className="text-sm text-foreground-muted">
            Role selection is unavailable for this NeoPi session.
          </Text>
        ) : null}
      </View>
      <FlatList
        data={models.filter((model) =>
          `${model.name} ${model.provider}/${model.id}`.toLowerCase().includes(query.toLowerCase()),
        )}
        keyExtractor={(model) => `${model.provider}/${model.id}`}
        ListHeaderComponent={
          <View className="px-4">
            {(rolesSupported ? roles : [])
              .filter(
                (role) =>
                  role.hidden !== true &&
                  `${role.alias} ${role.name}`.toLowerCase().includes(query.toLowerCase()),
              )
              .map((role) => (
                <Button
                  key={String(role.id)}
                  label={String(role.alias ?? role.id)}
                  disabled={pending}
                  tone="text"
                  onPress={() => void choose({ type: "set_role", role: role.id })}
                />
              ))}
          </View>
        }
        renderItem={({ item }) => (
          <View className="px-4 py-1">
            <Button
              label={`${item.name} · ${item.provider}`}
              disabled={pending}
              tone="text"
              onPress={() =>
                void choose({ type: "set_model", provider: item.provider, modelId: item.id })
              }
            />
          </View>
        )}
      />
    </NativeModal>
  );
}

function NativeMobileDialog({
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
  const respond = async (fields: Record<string, unknown>) => {
    if (pending) return;
    setPending(true);
    try {
      await request({ type: responseType, id: dialog.id, ...fields });
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
    <NativeModal
      title={String(dialog.title ?? (toolApproval ? `Allow ${dialog.toolName}?` : "NeoPi asks"))}
      onClose={() => void cancel()}
    >
      <ScrollView contentContainerClassName="gap-3 px-4 pb-6">
        <NativeError message={error} />
        {dialog.message ? <Text className="text-foreground">{String(dialog.message)}</Text> : null}
        {toolApproval ? (
          <>
            {typeof dialog.reason === "string" ? (
              <Text className="text-foreground">{dialog.reason}</Text>
            ) : null}
            <Text selectable className="font-mono text-xs text-foreground">
              {JSON.stringify(dialog.args, null, 2)}
            </Text>
            {Array.isArray(dialog.details)
              ? nativeValueItems(dialog.details).map(({ key, value: detail }) => (
                  <Text key={key} className="text-foreground">
                    {String(detail)}
                  </Text>
                ))
              : null}
            {Array.isArray(dialog.safetyChecks)
              ? nativeValueItems(dialog.safetyChecks).map(({ key, value: item }) => {
                  const check = nativeRecord(item);
                  return (
                    <Text key={key} accessibilityRole="alert" className="text-danger-foreground">
                      {String(check.message ?? check.code ?? check.id)}
                    </Text>
                  );
                })
              : null}
            <Button
              label="Deny"
              tone="secondary"
              disabled={pending}
              onPress={() => void respond({ decision: "deny" })}
            />
            {!Array.isArray(dialog.safetyChecks) || dialog.safetyChecks.length === 0 ? (
              <Button
                label="Allow for session"
                tone="secondary"
                disabled={pending}
                onPress={() => void respond({ decision: "allow_session" })}
              />
            ) : null}
            <Button
              label="Allow once"
              disabled={pending}
              onPress={() => void respond({ decision: "allow_once" })}
            />
          </>
        ) : null}
        {planProposal ? (
          <>
            <Text selectable className="text-foreground">
              {String(dialog.planMarkdown ?? "")}
            </Text>
            <NativeField label="Plan feedback" multiline value={value} onChange={setValue} />
            <Button
              label="Refine"
              tone="secondary"
              disabled={pending}
              onPress={() => void respond({ decision: "refine", feedback: value })}
            />
            <Button
              label="Approve plan"
              disabled={pending}
              onPress={() => void respond({ decision: "approve" })}
            />
          </>
        ) : null}
        {dialog.method === "select" && Array.isArray(dialog.options)
          ? nativeValueItems(dialog.options).map(({ key, value: option }) => (
              <Button
                key={key}
                label={String(option)}
                disabled={pending}
                tone="secondary"
                onPress={() => void respond({ value: option })}
              />
            ))
          : null}
        {dialog.method === "confirm" ? (
          <>
            <Button
              label="Yes"
              disabled={pending}
              onPress={() => void respond({ confirmed: true })}
            />
            <Button
              label="No"
              disabled={pending}
              tone="secondary"
              onPress={() => void respond({ confirmed: false })}
            />
          </>
        ) : null}
        {dialog.method === "input" || dialog.method === "editor" ? (
          <>
            <NativeField
              label={String(dialog.title ?? "Answer")}
              value={value}
              onChange={setValue}
              secret={dialog.secret === true}
              multiline={dialog.method === "editor"}
            />
            <Button label="Submit" disabled={pending} onPress={() => void respond({ value })} />
          </>
        ) : null}
        {questions.map((question) => {
          const id = String(question.id);
          const answer = answers[id] ?? { selectedOptions: [], customInput: "" };
          return (
            <View key={id} className="gap-2">
              <Text className="font-t3-medium text-foreground">{String(question.question)}</Text>
              {nativeValueItems(Array.isArray(question.options) ? question.options : []).map(
                ({ key, value: item }) => {
                  const option = nativeRecord(item);
                  const label = String(option.label);
                  const description =
                    typeof option.description === "string" ? option.description.trim() : "";
                  return (
                    <View key={key} className="gap-1">
                      <Button
                        label={`${answer.selectedOptions.includes(label) ? "✓ " : ""}${label}`}
                        tone="secondary"
                        disabled={pending}
                        onPress={() =>
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
                      {description ? (
                        <Text className="text-sm text-foreground-muted">{description}</Text>
                      ) : null}
                    </View>
                  );
                },
              )}
              <NativeField
                label="Other answer"
                value={answer.customInput}
                onChange={(customInput) =>
                  setAnswers({ ...answers, [id]: { ...answer, customInput } })
                }
              />
            </View>
          );
        })}
        {dialog.method === "ask" ? (
          <Button
            label="Submit answers"
            disabled={pending}
            onPress={() =>
              void respond({
                answers: questions.map((question) => ({
                  id: question.id,
                  ...(answers[String(question.id)] ?? { selectedOptions: [], customInput: "" }),
                })),
              })
            }
          />
        ) : null}
        <Button label="Cancel" tone="text" disabled={pending} onPress={() => void cancel()} />
      </ScrollView>
    </NativeModal>
  );
}
