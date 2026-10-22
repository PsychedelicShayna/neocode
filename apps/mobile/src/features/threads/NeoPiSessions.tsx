import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, NeoPiSessionSummary, ScopedThreadRef } from "@t3tools/contracts";
import { filterNeoPiSessions, neopiSessionRowState } from "@t3tools/client-runtime/neopi-sessions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { useProjects, useThreadShell } from "../../state/entities";
import {
  neopiSessionConfiguration,
  neopiSessionList,
  neopiSessionResume,
} from "../../state/neopiSessions";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { NativeModal as SessionModal } from "./NativeNeoPiControls";
import { NeoPiModelsEntry } from "./NeoPiModelsScreen";

export function NeoPiSessionBrowser({
  environmentId,
  disabled = false,
}: {
  environmentId: EnvironmentId;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MaterialButton
        label="Resume NeoPi session"
        disabled={disabled}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <SessionBrowser environmentId={environmentId} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function SessionBrowser({
  environmentId,
  onClose,
}: {
  environmentId: EnvironmentId;
  onClose: () => void;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const contextProject = projects[0];
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  const navigation = useNavigation();
  const resume = useAtomCommand(neopiSessionResume, { reportFailure: false });
  const result = useEnvironmentQuery(
    contextProject
      ? neopiSessionList({
          environmentId,
          input: { projectId: contextProject.id, scope: "all" },
        })
      : null,
  );
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    result.refresh();
  }, [result.refresh]);
  const close = () => {
    active.current = false;
    onClose();
  };
  async function select(session: NeoPiSessionSummary) {
    if (!contextProject || inFlight.current || neopiSessionRowState(session).disabledReason) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await resume({
        environmentId,
        input: {
          providerInstanceId: session.providerInstanceId,
          sessionFile: session.sessionFile,
          // The server resolves the native cwd and existing binding, not the selected folder.
          projectId: session.projectId ?? contextProject.id,
        },
      });
      if (!active.current) return;
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      close();
      navigation.navigate("Thread", { environmentId, threadId: response.value.threadId });
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error ? cause.message : "The native session could not be resumed.",
        );
    } finally {
      inFlight.current = false;
      if (active.current) setPending(false);
    }
  }
  const available = result.data?.status === "available" ? result.data : null;
  const message = !contextProject
    ? "Add a project in this environment before discovering native sessions."
    : (result.error ?? (result.data?.status === "unavailable" ? result.data.reason : null));
  return (
    <SessionModal title="NeoPi sessions" onClose={close}>
      <View className="gap-3 px-4 pb-3">
        <Text className="text-sm text-foreground-muted">
          All native project folders on this environment. Resume preserves the native session and
          its folder.
        </Text>
        <TextInput
          accessibilityLabel="Search NeoPi sessions"
          value={query}
          onChangeText={setQuery}
          placeholder="Search sessions"
          className="min-h-12 rounded-xl bg-card px-4 text-foreground"
        />
        <MaterialButton
          label={result.isPending ? "Refreshing…" : "Refresh"}
          disabled={pending || result.isPending || !contextProject}
          onPress={result.refresh}
        />
        {pending ? (
          <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
            Resuming native session… Closing this view does not cancel a resume already sent.
          </Text>
        ) : null}
        {message || error ? (
          <Text accessibilityRole="alert" selectable className="text-sm text-danger-foreground">
            {error ?? message}
          </Text>
        ) : null}
        {result.data?.diagnostics.map((diagnostic, index) => (
          <Text
            key={`${diagnostic.providerInstanceId}:${index}`}
            selectable
            className="text-sm text-foreground-muted"
          >
            {diagnostic.providerInstanceId}: {diagnostic.message}
          </Text>
        ))}
      </View>
      <FlatList
        data={
          message || result.isPending ? [] : filterNeoPiSessions(available?.sessions ?? [], query)
        }
        keyExtractor={(session) => `${session.providerInstanceId}:${session.sessionFile}`}
        ListEmptyComponent={
          <Text className="px-4 py-3 text-foreground-muted">
            {result.isPending
              ? "Reading native sessions…"
              : message
                ? "Discovery unavailable."
                : "No matching native sessions."}
          </Text>
        }
        renderItem={({ item }) => {
          const row = neopiSessionRowState(item);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: pending || row.disabledReason !== null }}
              disabled={pending || row.disabledReason !== null}
              onPress={() => void select(item)}
              className="gap-1 border-b border-border-subtle px-4 py-4 active:bg-subtle"
            >
              <Text className="text-base font-t3-medium text-foreground">{row.title}</Text>
              <Text selectable className="text-sm text-foreground-muted">
                {item.cwd}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {row.ownerLabel} · {item.messageCount} messages
              </Text>
              {row.disabledReason ? (
                <Text className="text-sm text-danger-foreground">{row.disabledReason}</Text>
              ) : null}
            </Pressable>
          );
        }}
      />
    </SessionModal>
  );
}

export function NeoPiSessionConfiguration({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [open, setOpen] = useState(false);
  const thread = useThreadShell(threadRef);
  const instanceId = thread?.session?.providerInstanceId ?? thread?.modelSelection.instanceId;
  return (
    <View className="flex-row flex-wrap items-center px-4 py-1">
      <MaterialButton
        label="NeoPi session configuration"
        tone="text"
        onPress={() => setOpen(true)}
      />
      {instanceId ? (
        <NeoPiModelsEntry
          environmentId={threadRef.environmentId}
          target={{
            providerInstanceId: instanceId,
            threadId: threadRef.threadId,
            ...(thread ? { projectId: thread.projectId } : {}),
          }}
        />
      ) : null}
      {open ? <ConfigurationSnapshot threadRef={threadRef} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

function ConfigurationSnapshot({
  threadRef,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const result = useEnvironmentQuery(
    neopiSessionConfiguration({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  useEffect(() => {
    result.refresh();
  }, [result.refresh]);
  const snapshot =
    !result.error && !result.isPending && result.data?.status === "available" ? result.data : null;
  return (
    <SessionModal title="NeoPi session configuration" onClose={onClose}>
      <ScrollView contentContainerClassName="gap-4 px-4 pb-6">
        <Text className="text-sm text-foreground-muted">
          Native session snapshot. Refresh to read model, effort and role changes. Open Models from
          the chat header to edit native role definitions, scoped effort rules and
          inference-provider accounts.
        </Text>
        <MaterialButton label="Refresh" disabled={result.isPending} onPress={result.refresh} />
        {result.isPending ? (
          <Text className="text-foreground-muted">Reading native configuration…</Text>
        ) : result.error ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {result.error}
          </Text>
        ) : result.data?.status === "unavailable" ? (
          <Text accessibilityRole="alert" className="text-foreground-muted">
            {result.data.reason}
          </Text>
        ) : null}
        {snapshot ? (
          <>
            <Text selectable className="text-foreground">
              Session: {snapshot.sessionId}
              {"\n"}Ownership:{" "}
              {snapshot.attachment === "terminal"
                ? "Terminal-owned, NeoCode attached"
                : "NeoCode-owned"}
              {"\n"}Model:{" "}
              {snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "Not reported"}
              {"\n"}Effort: {snapshot.thinkingLevel ?? "Not reported"}
              {"\n"}Active role: {snapshot.activeRole ?? "Not reported"}
              {"\n"}Observed: {snapshot.observedAt}
            </Text>
            <Text accessibilityRole="header" className="text-base font-t3-medium text-foreground">
              Model roles
            </Text>
            {snapshot.roles.status === "unsupported" ? (
              <Text className="text-foreground-muted">{snapshot.roles.reason}</Text>
            ) : snapshot.roles.items.length === 0 ? (
              <Text className="text-foreground-muted">No model roles reported.</Text>
            ) : (
              snapshot.roles.items.map((role) => (
                <View key={role.id} className="gap-1 border-b border-border-subtle pb-3">
                  <Text className="font-t3-medium text-foreground">
                    {role.name} · {role.alias}
                    {role.hidden ? " · Hidden from picker" : ""}
                  </Text>
                  <Text selectable className="text-sm text-foreground-muted">
                    Selector: {role.configured ?? "Not configured"}
                    {"\n"}Fallbacks: {role.patterns.join(", ") || "Not reported"}
                    {"\n"}Resolution:{" "}
                    {role.resolved
                      ? `${role.resolved.provider}/${role.resolved.modelId} · ${role.resolved.thinkingLevel ?? "No effort reported"}`
                      : "Unresolved"}
                  </Text>
                </View>
              ))
            )}
          </>
        ) : null}
      </ScrollView>
    </SessionModal>
  );
}
