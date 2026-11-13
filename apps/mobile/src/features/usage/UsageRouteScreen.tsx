import { type RouteProp, useIsFocused, useRoute } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useWorkspaceSettledContentWidth } from "../layout/workspace-content-width";
import { useServerConfigs } from "../../state/entities";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { NativeStatsView } from "./NativeStatsView";
import { useRefreshLimits } from "./UsageLimitsSection";
import { UsageLimitsSection } from "./UsageLimitsPooled";
import { toggleUsageEnvironment } from "./usageEnvironmentSelection";

const TABS = [
  { value: "usage", label: "NeoPi stats" },
  { value: "limits", label: "Limits" },
] as const;
type UsageTab = (typeof TABS)[number]["value"];

const WIDE_WIDTH = 600;
const MAX_CONTENT_WIDTH = 1080;

export function UsageRouteScreen(props: { readonly workspace?: boolean }) {
  const route = useRoute<RouteProp<{ Usage: { tab?: string } | undefined }, "Usage">>();
  return <UsageScreen workspace={props.workspace} tabParam={route.params?.tab} />;
}

function UsageScreen(props: {
  readonly workspace?: boolean;
  readonly tabParam: string | undefined;
}) {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const [selection, setSelection] = useState(() => ({
    params: props.tabParam,
    tab: (props.tabParam === "usage" ? "usage" : "limits") as UsageTab,
  }));
  if (selection.params !== props.tabParam)
    setSelection({
      params: props.tabParam,
      tab: props.tabParam === "usage" ? "usage" : "limits",
    });
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const [selectedStatsKey, setSelectedStatsKey] = useState<string | null>(null);
  const { connectedEnvironments: environments } = useRemoteConnectionStatus();
  const configs = useServerConfigs();
  const limits = useRefreshLimits(selectedEnvironmentIds, focused && selection.tab === "limits");
  const targets = environments.flatMap((environment) =>
    (configs.get(environment.environmentId)?.providers ?? [])
      .filter((provider) => provider.driver === "neopi" && provider.enabled)
      .map((provider) => ({
        key: `${environment.environmentId}:${provider.instanceId}`,
        environmentId: environment.environmentId,
        instanceId: provider.instanceId,
        label: `${environment.environmentLabel} · ${provider.displayName ?? "NeoPi"}`,
        connected: environment.isEnabled && environment.connectionState === "connected",
      })),
  );
  // Once chosen, a disappearing target must not silently show another environment's statistics.
  const target =
    selectedStatsKey === null
      ? targets[0]
      : targets.find((entry) => entry.key === selectedStatsKey);
  const [measuredWidth, setWidth] = useState(0);
  const width = useWorkspaceSettledContentWidth() ?? measuredWidth;
  const wide = width >= WIDE_WIDTH;
  return (
    <SettingsScreen title="Usage" workspaceRoot={props.workspace}>
      <View className="gap-3 px-5 py-3">
        <SegmentedControl
          options={TABS}
          selected={selection.tab}
          onSelect={(tab) => setSelection({ params: props.tabParam, tab })}
          role="tab"
        />
      </View>
      {selection.tab === "limits" ? (
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          contentContainerClassName="gap-6 px-5 pt-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
          refreshControl={
            <RefreshControl
              refreshing={limits.refreshing}
              onRefresh={() => void limits.refresh()}
            />
          }
        >
          <View className="w-full gap-6 self-center" style={{ maxWidth: MAX_CONTENT_WIDTH }}>
            <View className="gap-2">
              <Text className="text-sm text-foreground-muted">Quota environments</Text>
              <ScrollView
                horizontal
                contentContainerClassName="gap-2"
                showsHorizontalScrollIndicator={false}
              >
                <Button
                  label="All environments"
                  tone={selectedEnvironmentIds === null ? "primary" : "secondary"}
                  onPress={() => setSelectedEnvironmentIds(null)}
                />
                {environments.map((environment) => (
                  <Button
                    key={environment.environmentId}
                    label={environment.environmentLabel}
                    tone={
                      selectedEnvironmentIds === null ||
                      selectedEnvironmentIds.has(environment.environmentId)
                        ? "primary"
                        : "secondary"
                    }
                    onPress={() =>
                      setSelectedEnvironmentIds((current) =>
                        toggleUsageEnvironment(current, environments, environment.environmentId),
                      )
                    }
                  />
                ))}
              </ScrollView>
            </View>
            <UsageLimitsSection
              now={limits.now}
              failedLabels={limits.failedLabels}
              selectedEnvironmentIds={selectedEnvironmentIds}
              wide={wide}
            />
          </View>
        </ScreenScrollView>
      ) : (
        <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
          <View className="gap-2 px-5 pb-3">
            <Text className="text-sm text-foreground-muted">
              Native statistics for one environment and NeoPi runtime. Sessions, traces, indexing
              and calculations come from NeoPi.
            </Text>
            <ScrollView
              horizontal
              contentContainerClassName="gap-2"
              showsHorizontalScrollIndicator={false}
            >
              {targets.map((entry) => (
                <Button
                  key={entry.key}
                  label={entry.label}
                  tone={target?.key === entry.key ? "primary" : "secondary"}
                  onPress={() => setSelectedStatsKey(entry.key)}
                />
              ))}
            </ScrollView>
          </View>
          {!target ? (
            <Text accessibilityRole="alert" className="px-5 text-foreground-muted">
              {selectedStatsKey
                ? "The selected native stats runtime is no longer available. Choose another runtime explicitly."
                : "Connect an environment with an enabled NeoPi runtime to open native stats."}
            </Text>
          ) : !target.connected ? (
            <Text accessibilityRole="alert" className="px-5 text-foreground-muted">
              The selected environment is disconnected. Reconnect to open its native stats.
            </Text>
          ) : focused ? (
            <NativeStatsView
              key={target.key}
              environmentId={target.environmentId}
              instanceId={target.instanceId}
            />
          ) : null}
        </View>
      )}
    </SettingsScreen>
  );
}
