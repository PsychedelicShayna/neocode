import { createFileRoute, redirect } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

export const Route = createFileRoute("/_chat/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  beforeLoad: ({ search }) => {
    const environment = search.machine ?? search.environmentId;
    throw redirect({
      to: "/models",
      search: {
        ...(environment ? { environment } : {}),
        ...(search.instanceId ? { instance: search.instanceId } : {}),
      },
      replace: true,
    });
  },
});
