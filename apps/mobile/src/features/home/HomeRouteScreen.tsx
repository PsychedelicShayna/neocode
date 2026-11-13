import { uuidv4 } from "../../lib/uuid";
import { ThreadUndoNotice } from "./ThreadUndoNotice";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Platform, View } from "react-native";
import { Button } from "../../components/ui/Button";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { NativeSessionBrowser } from "../threads/NativeSessionBrowser";
import { APP_BASE_NAME } from "../../lib/mobileBranding";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  pickableProjectGroups,
  resolveScratchProjectScopeKey,
} from "@t3tools/client-runtime/state/project-grouping";

import { useProjects } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { useHomeListOptions } from "./home-list-options";
import { useAtomValueWhileVisible, useHomeRouteVisible } from "./home-route-visibility";
import { buildHomeProjectScopes } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { openSettings } from "../settings/settings-navigation";
import { useSelectWorkspaceTab } from "../layout/workspace/useSelectWorkspaceTab";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { WorkspaceListHeader } from "../layout/workspace/WorkspaceListHeader";
import { buildHomeListFilterMenuItems } from "./home-list-filter-menu";

export function HomeRouteScreen() {
  const [showSavedThreads, setShowSavedThreads] = useState(false);
  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: showSavedThreads }} />
      <View className="flex-1">
        {showSavedThreads ? (
          <>
            <View className="px-4 py-2">
              <Button
                label="Native sessions"
                tone="text"
                onPress={() => setShowSavedThreads(false)}
              />
            </View>
            <SavedThreadsScreen />
          </>
        ) : (
          <NativeSessionBrowser onOpenLegacyHistory={() => setShowSavedThreads(true)} />
        )}
      </View>
    </>
  );
}

function SavedThreadsScreen() {
  const { primarySidebarSearchQuery, setPrimarySidebarSearchQuery, startNewTask } =
    useAdaptiveWorkspaceLayout();
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  // Stop rebuilding the streaming thread list while Thread covers Home.
  const visible = useHomeRouteVisible();
  const threads = useAtomValueWhileVisible(
    environmentThreadShells.navigationThreadShellsAtom,
    visible,
  );
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const selectTab = useSelectWorkspaceTab();
  const workspace = useWorkspaceTabs();
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const searchQuery =
    Platform.OS === "android"
      ? primarySidebarSearchQuery
      : (workspace?.state.tabs.threads.query ?? localSearchQuery);
  const setSearchQuery = (query: string) => {
    if (Platform.OS === "android") setPrimarySidebarSearchQuery(query);
    else if (workspace) workspace.dispatch({ type: "query", query, tab: "threads" });
    else setLocalSearchQuery(query);
  };
  const handleSelectThread = (thread: EnvironmentThreadShell) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: String(thread.environmentId), threadId: String(thread.id) },
    });
  const selectThreadRoute = (params: ReactNavigation.RootParamList["Thread"]) =>
    selectDetail({ name: "Thread", params });
  const handleNewThreadOnBranch = (thread: EnvironmentThreadShell) => {
    selectThreadRoute({
      draft: {
        requestId: uuidv4(),
        environmentId: String(thread.environmentId),
        projectId: String(thread.projectId),
        branch: thread.branch,
        worktreePath: thread.worktreePath,
      },
    });
  };

  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
    unsettleThread,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } =
    usePendingTaskListActions(selectThreadRoute);
  const connectionStateByEnvironmentId = new Map(
    workspaceEnvironments.map(
      (environment) => [environment.environmentId, environment.connectionState] as const,
    ),
  );
  const environments = Arr.sort(
    Object.values(savedConnectionsById).map((connection) => ({
      environmentId: connection.environmentId,
      label: connection.environmentLabel,
      connectionState: connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
    })),
    Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
  );
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const {
    options: listOptions,
    setSelectedEnvironmentId,
    setSelectedProjectKey,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  // A legacy per-environment scratch key resolves here on every render; the stored
  // value is only rewritten when the user picks a filter.
  const resolvedProjectKey = resolveScratchProjectScopeKey(
    listOptions.selectedProjectKey,
    projects,
    {
      sidebarProjectGroupingMode: listOptions.projectGroupingMode,
      sidebarProjectGroupingOverrides: {},
    },
  );
  const projectFilterOptions = useMemo(
    () =>
      pickableProjectGroups(
        buildHomeProjectScopes({
          projects,
          environmentId: selectedEnvironmentId,
          projectGroupingMode: listOptions.projectGroupingMode,
        }),
      ).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentId],
  );
  const selectedProjectKey = projectFilterOptions.some(
    (project) => project.key === resolvedProjectKey,
  )
    ? resolvedProjectKey
    : null;

  return (
    <AndroidHomeFabLayout onStartNewTask={startNewTask}>
      <>
        <WorkspaceListHeader
          accessibilityLabel={`${APP_BASE_NAME}, Saved threads`}
          onOpenEnvironments={() => openSettings(navigation, "SettingsEnvironments")}
          search={{
            value: searchQuery,
            onChangeText: setSearchQuery,
            placeholder: "Search",
            accessibilityLabel: "Search threads",
          }}
          filter={{
            customized: selectedEnvironmentId !== null || selectedProjectKey !== null,
            items: buildHomeListFilterMenuItems({
              environments,
              projects: projectFilterOptions,
              selectedEnvironmentId,
              selectedProjectKey,
              onEnvironmentChange: setSelectedEnvironmentId,
              onProjectChange: setSelectedProjectKey,
            }),
          }}
        />

        <HomeScreen
          catalogState={catalogState}
          environments={environments}
          onAddConnection={() => openSettings(navigation, "SettingsEnvironmentNew")}
          onArchiveThread={archiveThread}
          onDeleteThread={confirmDeleteThread}
          onSettleThread={settleThread}
          onSnoozeThread={snoozeThread}
          onUnsnoozeThread={unsnoozeThread}
          onUnsettleThread={unsettleThread}
          onPinThread={pinThread}
          onUnpinThread={unpinThread}
          onSetThreadAutoSettle={setThreadAutoSettle}
          onMoveThread={moveThread}
          onRenameThread={renameThread}
          onRegenerateThreadTitle={regenerateThreadTitle}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenSettings={() => selectTab("settings")}
          onSearchQueryChange={setSearchQuery}
          onSelectThread={handleSelectThread}
          onSelectPendingTask={openPendingTask}
          onDeletePendingTask={confirmDeletePendingTask}
          onNewThreadOnBranch={handleNewThreadOnBranch}
          onNewThreadInProject={(project) => {
            selectThreadRoute({
              draft: {
                requestId: uuidv4(),
                environmentId: String(project.environmentId),
                projectId: String(project.id),
                title: project.title,
              },
            });
          }}
          onStartNewTask={startNewTask}
          pendingTasks={pendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={projects}
          projectSortOrder={listOptions.projectSortOrder}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          threads={threads}
        />
        <ThreadUndoNotice visible={visible} />
      </>
    </AndroidHomeFabLayout>
  );
}
