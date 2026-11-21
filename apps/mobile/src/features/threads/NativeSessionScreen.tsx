import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { workspaceKey } from "@t3tools/client-runtime/environment";
import { NATIVE_ROSTER_UNAVAILABLE_NOTE } from "@t3tools/client-runtime/neopi-native-agent-hub";
import {
  NATIVE_COMMAND_COMPLETIONS_CAPABILITY,
  deferNativeEditorText,
  executeNativeSessionCommand,
  nativeCatalogModels,
  nativeCommandCompletions,
  nativeCommandNeedsTerminal,
  nativeDisconnectLabel,
  nativeInboxLossWarnings,
  NATIVE_RUN_PAUSE_LABELS,
  nativeObservationNotice,
  nativeOwnerNotice,
  nativeRecord,
  nativeSessionKey,
  nativeSlashArgument,
  nativeSlashCommands,
  nativeTranscriptRows,
  type NativeCommandCompletion,
  type NativeSessionFeed,
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
import {
  nativeAskProgress,
  selectNativeSessionDialog,
  stepNativeAsk,
  type NativeAsk,
  type NativeAskAction,
  type NativeAskDraft,
} from "@t3tools/client-runtime/neopi-native-ask";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
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
import { NativeSessionForm } from "./NativeSessionForm";
import {
  NativeSessionWorkspaceControls,
  NativeSessionAgents,
} from "./NativeSessionWorkspaceControls";
import { NativeField, NativeModal, NativeError } from "./NativeNeoPiControls";
import { NeoPiJournalContent } from "./NeoPiJournalContent";
import { NativeCommandOutput } from "./NativeCommandOutput";
import { NativeSessionMobileTree } from "./NativeSessionMobileTree";
import { FloatingWorkingControl } from "./floating-working-control";
import { NeoPiModelsEntry } from "./NeoPiModelsScreen";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

type Params = { environmentId: string; providerInstanceId: string; sessionFile: string };
type Request = ReturnType<typeof useNativeSession>["request"];
const answered = new Map<string, Set<string>>();
const editors = new Map<string, string>();

const ATTRIBUTED_BUBBLE = {
  nit: {
    surface: "bg-adaptive-emerald-500-a12-a16",
    text: "text-adaptive-emerald-700-300",
    severity: "Nit",
  },
  concern: { surface: "bg-warning", text: "text-warning-foreground", severity: "Concern" },
  blocker: { surface: "bg-danger", text: "text-danger-foreground", severity: "Blocker" },
  irc: {
    surface: "bg-adaptive-sky-500-a12-a16",
    text: "text-adaptive-sky-700-300",
    severity: null,
  },
} as const;

function AttributedNativeBubble({
  row,
}: {
  row: Extract<NativeTranscriptRow, { kind: "advisor" | "irc" }>;
}) {
  const tone = ATTRIBUTED_BUBBLE[row.kind === "irc" ? "irc" : row.severity];
  return (
    <View
      className={`max-w-[90%] self-start gap-1 rounded-2xl rounded-bl-sm px-3 py-2 ${tone.surface}`}
    >
      <Text accessibilityRole="header" className={`text-xs font-t3-medium ${tone.text}`}>
        {tone.severity ? `${row.label} ${tone.severity}` : row.label}
      </Text>
      <Text selectable className="text-sm text-foreground">
        {row.text}
      </Text>
    </View>
  );
}

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
/**
 * The transcript rows, derived from the rows this screen showed last, so a row
 * keeps its key (and its open toggles) when a streaming message gains its first
 * call. The last result is kept in state and re-derived during render when an
 * input changes, the pattern React gives for state from previous renders.
 */
function useTranscriptRows(
  conversation: NativeSessionFeed["conversation"],
  commandOutputs: NativeSessionFeed["commandOutputs"],
  ircMessages: NativeSessionFeed["observation"]["ircMessages"],
  debug: boolean,
): readonly NativeTranscriptRow[] {
  const [shown, setShown] = useState(() => ({
    conversation,
    commandOutputs,
    ircMessages,
    debug,
    rows: nativeTranscriptRows(
      { conversation, commandOutputs, observation: { ircMessages } },
      debug,
    ),
  }));
  if (
    shown.conversation === conversation &&
    shown.commandOutputs === commandOutputs &&
    shown.ircMessages === ircMessages &&
    shown.debug === debug
  )
    return shown.rows;
  const next = {
    conversation,
    commandOutputs,
    ircMessages,
    debug,
    rows: nativeTranscriptRows(
      { conversation, commandOutputs, observation: { ircMessages } },
      debug,
      shown.rows,
    ),
  };
  setShown(next);
  return next.rows;
}
function NativeSessionBody({ target }: { target: NativeSessionTarget }) {
  const { feed, request, error } = useNativeSession(target);
  const timelineRef = useRef<FlatList<NativeTranscriptRow>>(null);
  const nearEndRef = useRef(false);
  const [showScrollToEnd, setShowScrollToEnd] = useState(false);
  const { themeAppearance } = useAppearancePreferences();
  const followRevisionRef = useRef(feed.conversation.revision);
  followRevisionRef.current = feed.conversation.revision;
  const followRowsRef = useRef<readonly NativeTranscriptRow[]>([]);
  const layoutRef = useRef({ height: 0, viewport: 0, offset: 0 });
  const measuredRowsRef = useRef(new Map<string, number>());
  const submissionFollow = useMemo(
    () =>
      createNativeSubmissionFollow({
        scheduleFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (frame) => cancelAnimationFrame(frame),
        readLayout: () => {
          const last = followRowsRef.current.at(-1);
          const layout = layoutRef.current;
          return {
            measured: !!last && measuredRowsRef.current.has(last.id) && layout.viewport > 0,
            atEnd: layout.height - layout.viewport - layout.offset <= 1,
            revision: JSON.stringify([
              last?.id,
              followRevisionRef.current,
              measuredRowsRef.current.get(last?.id ?? ""),
              layout.height,
              layout.viewport,
              layout.offset,
            ]),
          };
        },
        scrollToEnd: () => timelineRef.current?.scrollToEnd({ animated: false }),
      }),
    [],
  );
  const cancelSubmissionFollow = useCallback(() => {
    submissionFollow.cancel();
  }, [submissionFollow]);
  useEffect(() => cancelSubmissionFollow, [cancelSubmissionFollow]);
  const updateScrollToEndVisibility = () => {
    const { height, viewport, offset } = layoutRef.current;
    const atEnd = height - viewport - offset <= viewport * 0.1;
    if (viewport > 0) setShowScrollToEnd(!atEnd);
    return atEnd;
  };
  const reconnect = useNativeSessionReconnect(target);
  const ownerlessRef = useRef(false);
  ownerlessRef.current = !feed.connected;
  const submit = useCallback<Request>(
    async (command, attachments) => {
      // Nothing owns the session: take it over first, so the prompt lands in a live one.
      if (command.type === "prompt" && ownerlessRef.current) await reconnect();
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
  const composer = useNativeComposerState({
    target,
    request: submit,
    // A reconnecting session holds sends on the server; an orphaned one takes them by
    // starting an owner first (see `submit`).
    connected: feed.connected || feed.ownerLoss === "orphaned",
    busy: feed.busy,
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
  const observationNotice = nativeObservationNotice(feed);
  const rosterWarning = feed.agentsNote ? NATIVE_ROSTER_UNAVAILABLE_NOTE : null;
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const [models, setModels] = useState(false);
  const [tree, setTree] = useState(false);
  const [debug, setDebug] = useState(false);
  const [agents, setAgents] = useState(false);
  const [state, setState] = useState<Record<string, unknown>>({});
  const [commands, setCommands] = useState<readonly NativeSlashCommand[]>([]);
  const [completions, setCompletions] = useState<{
    readonly command: string;
    readonly prefix: string;
    readonly items: readonly NativeCommandCompletion[];
  } | null>(null);
  const key = nativeSessionKey(target);
  const [dismissed, setDismissed] = useState(() => answered.get(key) ?? new Set<string>());
  const navigation = useNavigation();
  useEffect(
    () => navigation.addListener("blur", cancelSubmissionFollow),
    [navigation, cancelSubmissionFollow],
  );
  useEffect(() => {
    if (feed.session) setState(feed.session.state);
  }, [feed.session]);
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
  useEffect(() => {
    const editor = feed.editor;
    setEditorNotice(null);
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
            setEditorNotice(
              "Draft kept. NeoPi's editor text will be inserted after you clear or send your draft.",
            ),
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
        onState: setState,
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
  const rows = useTranscriptRows(
    feed.conversation,
    feed.commandOutputs,
    feed.observation.ircMessages,
    debug,
  );
  const callIdsByRow = useMemo(
    () =>
      new Map(
        rows.map((row) => {
          const content = row.kind === "entry" ? nativeRecord(row.entry.message).content : null;
          const calls = Array.isArray(content)
            ? content.flatMap((value) => {
                const block = nativeRecord(value);
                return block.type === "toolCall" && typeof block.id === "string" ? [block.id] : [];
              })
            : [];
          return [row.id, calls];
        }),
      ),
    [rows],
  );
  const losses = useMemo(
    () =>
      nativeInboxLossWarnings(feed.observation.inbox, new Set([...callIdsByRow.values()].flat())),
    [feed.observation.inbox, callIdsByRow],
  );
  followRowsRef.current = rows;
  useEffect(() => {
    if (!feed.connected) cancelSubmissionFollow();
    else submissionFollow.changed();
  }, [rows, feed.connected, submissionFollow, cancelSubmissionFollow]);
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
  const obligation = useMemo(
    () => selectNativeSessionDialog(feed.dialogs, dismissed),
    [feed.dialogs, dismissed],
  );
  const markAnswered = (id: string) => {
    const next = new Set(answered.get(key)).add(id);
    answered.set(key, next);
    setDismissed(next);
  };
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-screen"
    >
      <ScreenHeader
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
            <MaterialButton
              label={ownerNotice.action}
              tone="text"
              disabled={reconnecting}
              onPress={reconnectNow}
            />
          ) : null}
        </View>
      ) : observationNotice || feed.busy || feed.runPause ? (
        <Text accessibilityLiveRegion="polite" className="px-4 py-1 text-xs text-foreground-muted">
          {observationNotice?.text ??
            (feed.runPause ? NATIVE_RUN_PAUSE_LABELS[feed.runPause] : "Working")}
        </Text>
      ) : null}
      {losses.general.length > 0 ? (
        <ScrollView
          className="max-h-24 shrink-0 px-4 py-1"
          accessibilityLabel="Live records not kept"
        >
          {losses.general.map((warning) => (
            <Text key={warning.key} className="text-xs text-warning-foreground">
              {warning.text}
            </Text>
          ))}
        </ScrollView>
      ) : null}
      <View className="px-4">
        <NativeError message={localError ?? error} />
      </View>
      {editorNotice ? (
        <Text accessibilityLiveRegion="polite" className="px-4 py-1 text-xs text-foreground-muted">
          {editorNotice}
        </Text>
      ) : null}
      <FlatList
        ref={timelineRef}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onTouchStart={cancelSubmissionFollow}
        onLayout={({ nativeEvent }) => {
          layoutRef.current.viewport = nativeEvent.layout.height;
          submissionFollow.changed();
          if (!nearEndRef.current) updateScrollToEndVisibility();
        }}
        onScrollBeginDrag={() => {
          cancelSubmissionFollow();
          nearEndRef.current = false;
        }}
        onScroll={({ nativeEvent }) => {
          layoutRef.current = {
            height: nativeEvent.contentSize.height,
            viewport: nativeEvent.layoutMeasurement.height,
            offset: nativeEvent.contentOffset.y,
          };
          submissionFollow.changed();
          nearEndRef.current = updateScrollToEndVisibility();
        }}
        scrollEventThrottle={16}
        onContentSizeChange={(_, height) => {
          layoutRef.current.height = height;
          submissionFollow.changed();
          if (nearEndRef.current) timelineRef.current?.scrollToEnd({ animated: false });
          else updateScrollToEndVisibility();
        }}
        data={rows}
        keyExtractor={(entry) => entry.id}
        ListHeaderComponent={
          feed.conversation.cursor ? (
            <MaterialButton
              label="Load earlier messages"
              tone="text"
              disabled={paging}
              onPress={() => void loadOlder()}
            />
          ) : null
        }
        renderItem={({ item }) => (
          <View
            className={item.kind === "entry" ? "gap-2 px-4 py-3" : "px-4 py-3"}
            accessibilityLabel={item.kind === "command" ? "Command output" : undefined}
            onLayout={({ nativeEvent }) => {
              measuredRowsRef.current.set(item.id, nativeEvent.layout.height);
              submissionFollow.changed();
            }}
          >
            {item.kind === "command" ? (
              <NativeCommandOutput text={item.text} />
            ) : item.kind !== "entry" ? (
              <AttributedNativeBubble row={item} />
            ) : (
              <>
                <Text className="text-xs font-t3-medium text-foreground-muted">
                  {journalEntryLabel(item.entry)}
                </Text>
                <NeoPiJournalContent
                  entry={item.entry}
                  environmentId={target.environmentId}
                  nativeRef={feed.session?.ref ?? target.ref}
                  cwd={feed.session?.cwd ?? null}
                />
                {(callIdsByRow.get(item.id) ?? []).flatMap((callId) =>
                  (losses.byToolCall.get(callId) ?? []).map((warning) => (
                    <Text key={warning.key} className="text-xs text-warning-foreground">
                      {warning.text}
                    </Text>
                  )),
                )}
              </>
            )}
          </View>
        )}
      />
      {obligation?.kind === "ask" ? (
        <NativeMobileAsk
          key={obligation.id}
          ask={obligation}
          request={request}
          onAnswered={() => markAnswered(obligation.id)}
        />
      ) : null}
      {obligation?.kind === "form" ? (
        <NativeSessionForm
          key={obligation.id}
          form={obligation}
          respond={async (response) => {
            await request(response);
            markAnswered(obligation.id);
          }}
        />
      ) : null}
      <View className="gap-2 border-t border-border px-4 py-3">
        <FloatingWorkingControl
          colorScheme={themeAppearance}
          status={null}
          devicePreview={null}
          showScrollToEnd={showScrollToEnd}
          onScrollToEnd={() => {
            nearEndRef.current = true;
            timelineRef.current?.scrollToEnd({ animated: false });
          }}
        />
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
              <MaterialButton label="Cancel" tone="text" onPress={() => removeQueued(queued)} />
            )}
          </View>
        ))}
        {Object.values(feed.notices)
          .filter(Boolean)
          .map((notice, index) => (
            <Text key={index} className="text-xs text-foreground-muted">
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
          <MaterialButton
            label={String(model.name ?? model.id ?? "Choose model")}
            tone="text"
            onPress={() => setModels(true)}
          />
          <MaterialButton
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
          <MaterialButton
            label="Reconnect session"
            tone="text"
            disabled={reconnecting}
            onPress={reconnectNow}
          />
        ) : (
          // Stays on this screen: the feed shows the session as detached, with a way back.
          <MaterialButton
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
        <NativeSessionAgents
          agents={feed.agents}
          rosterWarning={rosterWarning}
          observationNotice={observationNotice?.text}
          onClose={() => setAgents(false)}
        />
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
      {obligation?.kind === "modal" ? (
        <NativeMobileDialog
          key={obligation.id}
          dialog={obligation.dialog}
          request={request}
          onAnswered={() => markAnswered(obligation.id)}
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
  const [roles, setRoles] = useState<readonly Record<string, unknown>[]>([]);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);
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
  useEffect(() => {
    let active = true;
    setRoles([]);
    setRolesError(null);
    if (rolesSupported) {
      void request({ type: "get_roles" })
        .then((value) => {
          const items = nativeRecord(value).roles;
          if (active && Array.isArray(items)) setRoles(items.map(nativeRecord));
        })
        .catch((cause) => {
          if (active) setRolesError(`Could not load roles: ${String(cause)}`);
        });
    }
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
                <MaterialButton
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
            <MaterialButton
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

function NativeMobileAsk({
  ask,
  request,
  onAnswered,
}: {
  ask: NativeAsk;
  request: Request;
  onAnswered: () => void;
}) {
  const draftRef = useRef<NativeAskDraft>(undefined);
  const [draft, setDraft] = useState<NativeAskDraft>();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    activeQuestion: question,
    questionIndex,
    selectedOptionValues,
    customAnswer,
    canAdvance,
    isLastQuestion,
  } = nativeAskProgress(ask, draft);

  const dispatch = async (action: NativeAskAction) => {
    if (inFlight.current) return;
    const next = stepNativeAsk(ask, draftRef.current, action);
    draftRef.current = next.draft;
    setDraft(next.draft);
    if (!next.response) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await request(next.response);
      onAnswered();
    } catch (cause) {
      setError(String(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <ScrollView
      key={question.id}
      className="grow-0 border-t border-border bg-card"
      style={{ maxHeight: "40%" }}
      contentContainerClassName="gap-2 px-4 py-3"
      keyboardShouldPersistTaps="handled"
    >
      <NativeError message={error} />
      <Text className="text-xs text-foreground-muted">
        {question.header} · {questionIndex + 1}/{ask.questions.length}
      </Text>
      <Text className="font-t3-medium text-foreground">{question.question}</Text>
      {question.options.map(({ label, description, preview, recommended }) => {
        const selected = selectedOptionValues.includes(label);
        return (
          <View key={label} className="gap-1">
            <MaterialButton
              label={`${selected ? "✓ " : ""}${label}${recommended ? " (Recommended)" : ""}`}
              tone={selected ? "primary" : "secondary"}
              disabled={pending}
              onPress={() => void dispatch({ type: "option", questionId: question.id, label })}
            />
            {description ? (
              <Text className="text-sm text-foreground-muted">{description}</Text>
            ) : null}
            {preview ? (
              <Text className="font-mono text-xs text-foreground-muted">{preview}</Text>
            ) : null}
          </View>
        );
      })}
      <NativeField
        label="Other answer"
        value={customAnswer}
        disabled={pending}
        onChange={(text) => void dispatch({ type: "custom", questionId: question.id, text })}
      />
      <View className="flex-row flex-wrap items-center gap-2">
        <MaterialButton
          label="Dismiss"
          tone="text"
          disabled={pending}
          onPress={() => void dispatch({ type: "dismiss" })}
        />
        {questionIndex > 0 ? (
          <MaterialButton
            label="Previous"
            tone="secondary"
            disabled={pending}
            onPress={() => void dispatch({ type: "previous" })}
          />
        ) : null}
        <MaterialButton
          label={isLastQuestion ? "Submit answers" : "Next"}
          disabled={pending || !canAdvance}
          onPress={() => void dispatch({ type: "advance", questionId: question.id })}
        />
      </View>
    </ScrollView>
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
              ? dialog.details.map((detail, index) => (
                  <Text key={index} className="text-foreground">
                    {String(detail)}
                  </Text>
                ))
              : null}
            {Array.isArray(dialog.safetyChecks)
              ? dialog.safetyChecks.map((item, index) => {
                  const check = nativeRecord(item);
                  return (
                    <Text key={index} accessibilityRole="alert" className="text-danger-foreground">
                      {String(check.message ?? check.code ?? check.id)}
                    </Text>
                  );
                })
              : null}
            <MaterialButton
              label="Deny"
              tone="secondary"
              disabled={pending}
              onPress={() => void respond({ decision: "deny" })}
            />
            {!Array.isArray(dialog.safetyChecks) || dialog.safetyChecks.length === 0 ? (
              <MaterialButton
                label="Allow for session"
                tone="secondary"
                disabled={pending}
                onPress={() => void respond({ decision: "allow_session" })}
              />
            ) : null}
            <MaterialButton
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
            <MaterialButton
              label="Refine"
              tone="secondary"
              disabled={pending}
              onPress={() => void respond({ decision: "refine", feedback: value })}
            />
            <MaterialButton
              label="Approve plan"
              disabled={pending}
              onPress={() => void respond({ decision: "approve" })}
            />
          </>
        ) : null}
        {dialog.method === "select" && Array.isArray(dialog.options)
          ? dialog.options.map((option, index) => (
              <MaterialButton
                key={index}
                label={String(option)}
                disabled={pending}
                tone="secondary"
                onPress={() => void respond({ value: option })}
              />
            ))
          : null}
        {dialog.method === "confirm" ? (
          <>
            <MaterialButton
              label="Yes"
              disabled={pending}
              onPress={() => void respond({ confirmed: true })}
            />
            <MaterialButton
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
            <MaterialButton
              label="Submit"
              disabled={pending}
              onPress={() => void respond({ value })}
            />
          </>
        ) : null}
        <MaterialButton
          label="Cancel"
          tone="text"
          disabled={pending}
          onPress={() => void cancel()}
        />
      </ScrollView>
    </NativeModal>
  );
}
