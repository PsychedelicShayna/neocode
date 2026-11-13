import { useIsFocused, useNavigation } from "@react-navigation/native";
import { workspaceResourceId } from "@t3tools/client-runtime/environment";
import {
  nativeValueItems,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import {
  deriveWorkflowGroups,
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { resetRootStack } from "../../lib/root-stack-reset";
import { settingsNavigationState } from "../settings/settings-navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { deviceEnvironment } from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { threadDevicePreviews } from "../devices/threadDevicePreviews";
import { NativeModal } from "./NativeNeoPiControls";
import {
  useHardwareKeyboardCommand,
  type HardwareKeyboardCommand,
} from "../keyboard/hardwareKeyboardCommands";
import { useOpenNativeSession } from "./NativeSessionBrowser";

const workspaceCommands = ["newTask", "files", "terminal", "review"] as const;
const newSessionCommand = ["newTask"] as const;
const noWorkspaceCommands = [] as const;

/** Mobile has file/web-document previews and device streams, not Electron browser tabs. */
export function NativeSessionWorkspaceControls({
  target,
  cwd,
  agentCount,
  onOpenAgents,
  onError,
}: {
  target: NativeSessionTarget;
  cwd: string | null;
  agentCount: number;
  onOpenAgents: () => void;
  onError: (message: string) => void;
}) {
  const navigation = useNavigation();
  const devices = useEnvironmentQuery(
    deviceEnvironment.state({ environmentId: target.environmentId, input: {} }),
  );
  const previews = threadDevicePreviews(devices.data, workspaceResourceId(target));
  const focused = useIsFocused();
  const open = useOpenNativeSession();
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const createSession = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      await open(target.environmentId, {
        providerInstanceId: target.ref.providerInstanceId,
        ...(cwd === null ? {} : { cwd }),
      });
    } catch (cause) {
      onError(String(cause));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [cwd, onError, open, target]);
  const openFiles = useCallback(() => {
    if (cwd !== null)
      navigation.navigate("ThreadFiles", {
        environmentId: target.environmentId,
        nativeRef: target.ref,
        cwd,
        projectName: cwd,
      });
  }, [cwd, navigation, target]);
  const openTerminal = useCallback(() => {
    if (cwd !== null) navigation.navigate("ThreadTerminal", { target, cwd });
  }, [cwd, navigation, target]);
  const openReview = useCallback(() => {
    if (cwd !== null) navigation.navigate("ThreadReview", { target, cwd });
  }, [cwd, navigation, target]);
  const handleCommand = useCallback(
    (command: HardwareKeyboardCommand) => {
      if (!focused) return false;
      if (command === "newTask") {
        void createSession();
        return true;
      }
      if (cwd === null) return false;
      if (command === "files") openFiles();
      else if (command === "terminal") openTerminal();
      else if (command === "review") openReview();
      else return false;
      return true;
    },
    [cwd, focused, openFiles, openTerminal, openReview, createSession],
  );
  useHardwareKeyboardCommand(
    focused ? (cwd !== null ? workspaceCommands : newSessionCommand) : noWorkspaceCommands,
    handleCommand,
  );
  return (
    <ScrollView horizontal contentContainerClassName="items-center gap-2">
      <Button
        label={creating ? "Creating…" : "New session"}
        tone="text"
        disabled={creating}
        onPress={() => void createSession()}
      />
      <Button label="Terminal" tone="text" disabled={cwd === null} onPress={openTerminal} />
      <Button label="Files" tone="text" disabled={cwd === null} onPress={openFiles} />
      <Button label="Review changes" tone="text" disabled={cwd === null} onPress={openReview} />
      <Button
        label={`Agents${agentCount ? ` · ${agentCount}` : ""}`}
        tone="text"
        onPress={onOpenAgents}
      />
      {previews.length ? (
        <Button
          label={`Devices · ${previews.length}`}
          tone="text"
          onPress={() => navigation.navigate("ThreadDevicePreview", { target })}
        />
      ) : null}
      <Button
        label="Settings"
        tone="text"
        onPress={() =>
          resetRootStack(navigation, (state) => settingsNavigationState(state, undefined))
        }
      />
      <Button label="Connections" tone="text" onPress={() => navigation.navigate("Connections")} />
    </ScrollView>
  );
}

/** Consumes the real native roster directly, never SQL activities or inferred execution settings. */
export function NativeSessionAgents({
  agents,
  onClose,
}: {
  agents: readonly RuntimeSubagent[];
  onClose: () => void;
}) {
  const model = useMemo(() => {
    const workflows = deriveWorkflowGroups(agents);
    const grouped = workflows.flatMap((group) => [
      group.workflow,
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedMembers,
    ]);
    const groupedIds = new Set(grouped.map((agent) => agent.id));
    const rows = [...grouped, ...agents.filter((agent) => !groupedIds.has(agent.id))];
    const workers = rows.filter((agent) => agent.kind !== "workflow");
    return {
      rows,
      liveCount: workers.filter((agent) => isActiveSubagentStatus(agent.status)).length,
      settledCount: workers.filter((agent) => isTerminalSubagentStatus(agent.status)).length,
      totalTokens: workers.reduce((total, agent) => total + (agent.usage?.totalTokens ?? 0), 0),
    };
  }, [agents]);
  return (
    <NativeModal title="Agents" onClose={onClose}>
      <ScrollView className="flex-1" contentContainerClassName="px-4 pb-4">
        <Text className="text-sm text-foreground-muted">
          {model.liveCount} active · {model.settledCount} settled ·{" "}
          {formatTokens(model.totalTokens)} tokens
        </Text>
        {model.rows.length === 0 ? (
          <Text className="text-foreground-muted">No agents observed in this session.</Text>
        ) : null}
        {model.rows.map((agent) => (
          <View key={agent.id} className="gap-1 border-b border-border py-3">
            <Text className="font-t3-medium text-foreground">{agent.title}</Text>
            <Text className="text-xs text-foreground-muted">
              {[agent.status, agent.role, agent.model, agent.effort].filter(Boolean).join(" · ")}
            </Text>
            {agent.usage ? (
              <Text className="text-xs text-foreground-muted">
                {formatTokens(agent.usage.totalTokens)} tokens
                {agent.usage.toolUses !== undefined ? ` · ${agent.usage.toolUses} tools` : ""}
                {agent.usage.durationMs !== undefined
                  ? ` · ${(agent.usage.durationMs / 1000).toFixed(1)}s`
                  : ""}
              </Text>
            ) : null}
            {agent.progress ? (
              <Text selectable className="text-sm text-foreground">
                {agent.progress}
              </Text>
            ) : null}
            {agent.lastToolName ? (
              <Text className="text-xs text-foreground-muted">{agent.lastToolName}</Text>
            ) : null}
            {nativeValueItems(agent.recentActivity).map(({ value: activity, key }) => (
              <Text key={key} selectable className="text-xs text-foreground-muted">
                {activity.summary}
              </Text>
            ))}
            {agent.result ? (
              <Text selectable className="text-sm text-foreground">
                {agent.result}
              </Text>
            ) : null}
            {agent.error ? (
              <Text selectable className="text-sm text-danger-foreground">
                {agent.error}
              </Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </NativeModal>
  );
}
