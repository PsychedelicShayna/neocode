import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import type { EnvironmentId, NeoPiModelsTarget, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";
import { setNeoPiThemePalette } from "../../hooks/useTheme";
import { useFollowNeoPiTheme } from "../../neopiThemePreference";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { neopiThemesWatch } from "../../state/neopiThemes";
import { neoPiThemeColors } from "../../themePalette";
import { resolveThreadRouteTarget } from "../../threadRoutes";

export function NeoPiThemeSync() {
  const params = useParams({ strict: false });
  const route = resolveThreadRouteTarget(params);
  const routeEnvironment = route?.kind === "server" ? route.threadRef.environmentId : null;
  const routeThread = route?.kind === "server" ? route.threadRef.threadId : null;
  const [previousThread, setPreviousThread] = useState<ScopedThreadRef | null>(null);
  useEffect(() => {
    if (routeEnvironment && routeThread) setPreviousThread({ environmentId: routeEnvironment, threadId: routeThread });
  }, [routeEnvironment, routeThread]);
  const threadRef = route?.kind === "server" ? route.threadRef : previousThread;
  const thread = useThreadShell(threadRef);
  const primary = usePrimaryEnvironmentId();
  const environmentId = threadRef?.environmentId ?? primary;
  const configs = useServerConfigs();
  const config = environmentId ? configs.get(environmentId) : null;
  const instanceId = thread?.session?.providerInstanceId ?? thread?.modelSelection.instanceId;
  const provider = config?.providers.find(entry => entry.driver === "neopi" && entry.instanceId === instanceId)
    ?? config?.providers.find(entry => entry.driver === "neopi" && entry.enabled);
  const follow = useFollowNeoPiTheme();
  useEffect(() => {
    if (!follow || !environmentId || !provider) setNeoPiThemePalette(null);
  }, [follow, environmentId, provider]);
  if (!follow || !environmentId || !provider) return null;
  return <ConnectedThemeSync environmentId={environmentId} target={{ providerInstanceId: provider.instanceId, ...(thread ? { projectId: thread.projectId } : {}) }} />;
}

function ConnectedThemeSync({ environmentId, target }: { environmentId: EnvironmentId; target: NeoPiModelsTarget }) {
  const result = useAtomValue(neopiThemesWatch({ environmentId, input: { target } }));
  const value = AsyncResult.isSuccess(result) ? result.value : null;
  const palette = useMemo(() => value ? {
    dark: neoPiThemeColors("dark", value.selection.dark.colors),
    light: neoPiThemeColors("light", value.selection.light.colors),
  } : null, [value]);
  useEffect(() => {
    setNeoPiThemePalette(palette);
    return () => setNeoPiThemePalette(null);
  }, [palette]);
  return null;
}
