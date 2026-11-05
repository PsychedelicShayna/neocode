import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { EnvironmentId, NeoPiNativeSessionRef, ProviderInstanceId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useState } from "react";
import { AppState, Pressable, ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { useEnvironments } from "../../state/environments";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { nativeSessionAtoms } from "../../state/neopiNativeSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { NeoPiModelsEntry } from "./NeoPiModelsScreen";

export function useOpenNativeSession() {
  const navigation = useNavigation();
  const open = useAtomCommand(nativeSessionAtoms.open, { reportFailure: false });
  return useCallback(
    async (
      environmentId: EnvironmentId,
      input: { providerInstanceId: ProviderInstanceId; sessionFile?: string; cwd?: string },
    ) => {
      const response = await open({ environmentId, input });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      navigation.navigate("NativeSession", { environmentId, ...response.value.ref });
      return { environmentId, ref: response.value.ref };
    },
    [open, navigation],
  );
}

export function NativeSessionBrowser({
  environmentId,
  onOpenSettings,
  onOpenEnvironments,
}: {
  environmentId?: EnvironmentId;
  onOpenSettings?: () => void;
  onOpenEnvironments?: () => void;
}) {
  const { environments } = useEnvironments();
  const configs = useServerConfigs();
  const open = useOpenNativeSession();
  const navigation = useNavigation();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const legacy = useThreadShells().filter(
    (thread) => !environmentId || thread.environmentId === environmentId,
  );
  const filtered = environments.filter(
    (environment) => !environmentId || environment.environmentId === environmentId,
  );
  const create = async (id: EnvironmentId, providerInstanceId: ProviderInstanceId) => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      await open(id, { providerInstanceId });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setCreating(false);
    }
  };
  return (
    <View className="flex-1 bg-screen">
      <View className="flex-row flex-wrap gap-2 px-4 py-2">
        <MaterialButton
          label="Settings"
          tone="text"
          onPress={onOpenSettings ?? (() => navigation.navigate("SettingsSheet"))}
        />
        <MaterialButton
          label="Connections"
          tone="text"
          onPress={onOpenEnvironments ?? (() => navigation.navigate("Connections"))}
        />
      </View>
      <View className="px-4 py-2">
        <TextInput
          accessibilityLabel="Search sessions"
          placeholder="Search sessions"
          value={query}
          onChangeText={setQuery}
          className="min-h-12 rounded-xl bg-card px-4 text-foreground"
        />
        {error ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </View>
      <ScrollView contentContainerClassName="gap-3 px-4 pb-6">
        {filtered.map((environment) => (
          <View key={environment.environmentId} className="gap-2">
            <Text className="text-sm font-t3-medium text-foreground-muted">
              {environment.label}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {configs
                .get(environment.environmentId)
                ?.providers.filter(
                  (provider) =>
                    provider.driver === "neopi" &&
                    provider.enabled &&
                    provider.availability !== "unavailable",
                )
                .map((provider) => (
                  <MaterialButton
                    key={provider.instanceId}
                    label={
                      configs
                        .get(environment.environmentId)
                        ?.providers.filter((item) => item.driver === "neopi" && item.enabled)
                        .length === 1
                        ? "New thread"
                        : `New thread · ${provider.displayName ?? provider.instanceId}`
                    }
                    disabled={creating}
                    onPress={() => void create(environment.environmentId, provider.instanceId)}
                  />
                ))}
              <NeoPiModelsEntry environmentId={environment.environmentId} />
            </View>
            <NativeSessionRows environmentId={environment.environmentId} query={query} />
          </View>
        ))}
        {!filtered.length ? (
          <Text className="text-foreground-muted">
            Connect an environment to start a conversation.
          </Text>
        ) : null}
        {legacy.length ? (
          <View className="gap-2">
            <Text className="text-sm text-foreground-muted">
              Saved workspaces and legacy history
            </Text>
            {legacy
              .filter((thread) => thread.title.toLowerCase().includes(query.toLowerCase()))
              .map((thread) => (
                <MaterialButton
                  key={`${thread.environmentId}:${thread.id}`}
                  label={thread.title}
                  tone="text"
                  onPress={() =>
                    navigation.navigate("Thread", {
                      environmentId: thread.environmentId,
                      threadId: thread.id,
                    })
                  }
                />
              ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function NativeSessionRows({
  environmentId,
  query,
}: {
  environmentId: EnvironmentId;
  query: string;
}) {
  const result = useEnvironmentQuery(nativeSessionAtoms.list({ environmentId, input: {} }));
  const refresh = result.refresh;
  useFocusEffect(
    useCallback(() => {
      // Re-read native owners when returning from another client or terminal.
      refresh();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => subscription.remove();
    }, [refresh]),
  );
  const open = useOpenNativeSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (ref: NeoPiNativeSessionRef) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await open(environmentId, ref);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <View className="gap-1">
      {result.error || error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error ?? result.error}
        </Text>
      ) : null}
      {result.data?.diagnostics.map((item, index) => (
        <Text key={index} className="text-xs text-foreground-muted">
          {item.message}
        </Text>
      ))}
      {result.data?.sessions
        .filter((session) =>
          `${session.title ?? ""} ${session.firstMessage} ${session.cwd}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .map((session) => {
          const disabled = session.owner.kind === "process" && !session.owner.attachable;
          return (
            <Pressable
              key={`${session.ref.providerInstanceId}:${session.ref.sessionFile}`}
              accessibilityRole="button"
              disabled={pending || disabled}
              accessibilityState={{ disabled: pending || disabled }}
              onPress={() => void choose(session.ref)}
              className="gap-1 border-b border-border-subtle py-3"
            >
              <Text className="font-t3-medium text-foreground">
                {session.title ?? (session.firstMessage || "New session")}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {session.cwd}
                {disabled ? " · In use" : session.owner.kind === "process" ? " · Terminal" : ""}
              </Text>
            </Pressable>
          );
        })}
      {!result.data && result.isPending ? (
        <Text className="text-foreground-muted">Reading sessions…</Text>
      ) : null}
    </View>
  );
}
