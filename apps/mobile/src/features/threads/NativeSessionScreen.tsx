import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  NATIVE_COMMAND_COMPLETIONS_CAPABILITY,
  nativeCatalogModels,
  nativeCommandCompletions,
  nativeCommandNeedsTerminal,
  nativeDisconnectLabel,
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
import { journalEntryLabel } from "@t3tools/client-runtime/neopi-journal";
import { createNativeSubmissionFollow } from "@t3tools/client-runtime/neopi-submission-follow";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import {
  nativeSessionAtoms,
  useNativeSession,
  useNativeSessionReconnect,
} from "../../state/neopiNativeSessions";
import { useNativeComposerState } from "../../state/use-native-composer-state";
import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
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
function NativeSessionBody({ target }: { target: NativeSessionTarget }) {
  const { feed, request, error } = useNativeSession(target);
  const timelineRef = useRef<FlatList<NativeTranscriptRow>>(null);
  const nearEndRef = useRef(false);
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
  const [models, setModels] = useState(false);
  const [tree, setTree] = useState(false);
  const [debug, setDebug] = useState(false);
  const [agents, setAgents] = useState(false);
  const [state, setState] = useState<Record<string, unknown>>({});
  const [commands, setCommands] = useState<readonly NativeSlashCommand[]>([]);
  const [completions, setCompletions] = useState<{
    readonly command: string;
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
    if (feed.session && feed.session.ref.sessionFile !== target.ref.sessionFile)
      navigation.dispatch(
        StackActions.replace("NativeSession", {
          environmentId: target.environmentId,
          ...feed.session.ref,
        }),
      );
  }, [feed.session, target.environmentId, target.ref.sessionFile, navigation]);
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
              items: nativeCommandCompletions(value, argumentPrefix),
            });
        })
        .catch(() => {
          if (active) setCompletions({ command: argumentCommand, items: [] });
        });
    }, 80);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [argumentCommand, argumentPrefix, request]);
  useEffect(() => {
    const editor = feed.editor;
    if (!editor || editors.get(key) === editor.id) return;
    let active = true;
    void waitForComposerDraftsLoaded()
      .then(() => {
        if (!active || editors.get(key) === editor.id) return;
        editors.set(key, editor.id);
        const draft = getComposerDraftSnapshot(composer.key);
        if (!draft.text && !draft.attachments.length && !draft.context?.records.length)
          setComposerDraftText(composer.key, editor.text);
      })
      .catch((cause) => {
        if (active) setLocalError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [feed.editor, key, composer.key]);
  const execute = useCallback<Request>(
    async (command, attachments) => {
      const result = await submit(command, attachments);
      if (command.type !== "prompt" && command.type !== "extension_ui_response")
        setState(nativeRecord(await request({ type: "get_state" })));
      return result;
    },
    [request, submit],
  );
  const rows = useMemo(
    () =>
      nativeTranscriptRows(
        { conversation: feed.conversation, commandOutputs: feed.commandOutputs },
        debug,
      ),
    [feed.conversation, feed.commandOutputs, debug],
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
    argumentCommand && completions?.command === argumentCommand
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
      ) : !feed.connected || feed.busy ? (
        <Text accessibilityLiveRegion="polite" className="px-4 py-1 text-xs text-foreground-muted">
          {feed.connected ? "Working" : "Reconnecting · showing cached conversation"}
        </Text>
      ) : null}
      <View className="px-4">
        <NativeError message={localError ?? error} />
      </View>
      <FlatList
        ref={timelineRef}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onTouchStart={cancelSubmissionFollow}
        onLayout={({ nativeEvent }) => {
          layoutRef.current.viewport = nativeEvent.layout.height;
          submissionFollow.changed();
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
          nearEndRef.current =
            nativeEvent.contentSize.height -
              nativeEvent.layoutMeasurement.height -
              nativeEvent.contentOffset.y <=
            nativeEvent.layoutMeasurement.height * 0.1;
        }}
        scrollEventThrottle={16}
        onContentSizeChange={(_, height) => {
          layoutRef.current.height = height;
          submissionFollow.changed();
          if (nearEndRef.current) timelineRef.current?.scrollToEnd({ animated: false });
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
        renderItem={({ item }) =>
          item.kind === "command" ? (
            <View
              className="px-4 py-3"
              accessibilityLabel="Command output"
              onLayout={({ nativeEvent }) => {
                measuredRowsRef.current.set(item.id, nativeEvent.layout.height);
                submissionFollow.changed();
              }}
            >
              <NativeCommandOutput text={item.text} />
            </View>
          ) : (
            <View
              className="gap-2 px-4 py-3"
              onLayout={({ nativeEvent }) => {
                measuredRowsRef.current.set(item.id, nativeEvent.layout.height);
                submissionFollow.changed();
              }}
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
              <MaterialButton
                label="Cancel"
                tone="text"
                onPress={() =>
                  void execute({
                    type: "remove_queued_message",
                    message: queued.text,
                    queue: queued.lane,
                  }).catch((cause) => setLocalError(String(cause)))
                }
              />
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
        {suggestions.length ? (
          <ScrollView horizontal>
            {suggestions.map((command) => (
              <MaterialButton
                key={command.name}
                label={[
                  `/${command.name}`,
                  command.input?.hint,
                  nativeCommandNeedsTerminal(command, feed.session?.attachment)
                    ? "· terminal only"
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" ")}
                tone="text"
                onPress={() => composer.setText(`/${command.name} `)}
              />
            ))}
          </ScrollView>
        ) : null}
        {argumentCommand && argumentSuggestions.length ? (
          <ScrollView horizontal>
            {argumentSuggestions.map((item) => (
              <MaterialButton
                key={item.value}
                label={item.label}
                tone="text"
                onPress={() => {
                  composer.setText(`/${argumentCommand} ${item.value}`);
                  if (item.submitsCommand) void composer.send();
                }}
              />
            ))}
          </ScrollView>
        ) : null}
        <NativeSessionWorkspaceControls
          target={target}
          cwd={feed.session?.cwd ?? null}
          agentCount={feed.agents.length}
          onOpenAgents={() => setAgents(true)}
          onError={setLocalError}
        />
        <NativeSessionComposer
          target={target}
          cwd={feed.session?.cwd ?? null}
          composer={composer}
          busy={feed.busy}
          onStop={() =>
            void execute({ type: "abort" }).catch((cause) => setLocalError(String(cause)))
          }
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
        <NativeSessionAgents agents={feed.agents} onClose={() => setAgents(false)} />
      ) : null}
      {models ? <NativeMobileModels request={execute} onClose={() => setModels(false)} /> : null}
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

function NativeMobileModels({ request, onClose }: { request: Request; onClose: () => void }) {
  const [models, setModels] = useState<ReturnType<typeof nativeCatalogModels>>([]);
  const [roles, setRoles] = useState<readonly Record<string, unknown>[]>([]);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([request({ type: "get_available_models" }), request({ type: "get_roles" })])
      .then(([models, roles]) => {
        if (!active) return;
        setModels(nativeCatalogModels(models));
        const items = nativeRecord(roles).roles;
        if (Array.isArray(items)) setRoles(items.map(nativeRecord));
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [request]);
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
      </View>
      <FlatList
        data={models.filter((model) =>
          `${model.name} ${model.provider}/${model.id}`.toLowerCase().includes(query.toLowerCase()),
        )}
        keyExtractor={(model) => `${model.provider}/${model.id}`}
        ListHeaderComponent={
          <View className="px-4">
            {roles
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
        {questions.map((question) => {
          const id = String(question.id);
          const answer = answers[id] ?? { selectedOptions: [], customInput: "" };
          return (
            <View key={id} className="gap-2">
              <Text className="font-t3-medium text-foreground">{String(question.question)}</Text>
              {(Array.isArray(question.options) ? question.options : []).map((item, index) => {
                const option = nativeRecord(item);
                const label = String(option.label);
                return (
                  <MaterialButton
                    key={index}
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
                );
              })}
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
          <MaterialButton
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
