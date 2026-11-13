import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useThreadShell } from "../../state/entities";
import { neopiSessionConfiguration } from "../../state/neopiSessions";
import { useEnvironmentQuery } from "../../state/query";
import { NativeModal as SessionModal } from "./NativeNeoPiControls";
import { NeoPiModelsEntry } from "./NeoPiModelsScreen";
import { NativeSessionBrowser } from "./NativeSessionBrowser";

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
      <Button label="Resume NeoPi session" disabled={disabled} onPress={() => setOpen(true)} />
      {open ? (
        <SessionModal title="Sessions" onClose={() => setOpen(false)}>
          <NativeSessionBrowser environmentId={environmentId} />
        </SessionModal>
      ) : null}
    </>
  );
}

export function NeoPiSessionConfiguration({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [open, setOpen] = useState(false);
  const thread = useThreadShell(threadRef);
  const instanceId = thread?.modelSelection.instanceId;
  return (
    <View className="flex-row flex-wrap items-center px-4 py-1">
      <Button label="NeoPi session configuration" tone="text" onPress={() => setOpen(true)} />
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
        <Button label="Refresh" disabled={result.isPending} onPress={result.refresh} />
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
