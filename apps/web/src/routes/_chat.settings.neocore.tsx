import { createFileRoute } from "@tanstack/react-router";
import { ProviderInstanceId } from "@t3tools/contracts";

import { NeoCoreSettingsPanel } from "../components/neopi/NeoCoreSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsNeoCoreRoute() {
  const target = Route.useSearch();
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to configure NeoPi.`
          : "Connect an environment to configure NeoPi."}
      </p>
    );
  }
  return (
    <NeoCoreSettingsPanel
      environmentId={environment.environmentId}
      {...(target.instanceId ? { instanceId: target.instanceId } : {})}
    />
  );
}

export const Route = createFileRoute("/_chat/settings/neocore")({
  validateSearch: (raw: Record<string, unknown>) =>
    typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {},
  component: SettingsNeoCoreRoute,
});
