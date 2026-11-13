import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { nativeStatsRequest } from "../../state/neopiStats";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { UsageLimitsSection } from "./UsageLimits";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";
import { serverEnvironment } from "../../state/server";
import {
  connectNativeStatsPort,
  type NativeStatsTransportInput,
} from "@t3tools/client-runtime/neopi-stats-bridge";
import { randomUUID } from "../../lib/utils";

/** The native app owns ranges, calculations, traces, loading and indexing. */
export function UsagePage() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const primary = useAtomValue(primaryEnvironmentIdAtom);
  const [view, setView] = useState<"stats" | "limits">("stats");
  const [selectedEnvironment, setSelectedEnvironment] = useState<EnvironmentId | null>(null);
  const [selectedLimitEnvironments, setSelectedLimitEnvironments] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const preferredEnvironment = selectedEnvironment ?? primary;
  const environmentId =
    preferredEnvironment !== null && presentations.has(preferredEnvironment)
      ? preferredEnvironment
      : (presentations.keys().next().value ?? null);
  const presentation = environmentId === null ? undefined : presentations.get(environmentId);
  const runtimes =
    presentation?.serverConfig?.providers.filter((provider) => provider.driver === "neopi") ?? [];
  const runtime =
    runtimes.find((provider) => provider.instanceId === selectedInstance) ??
    runtimes.find((provider) => provider.enabled) ??
    runtimes[0];
  return (
    <AppRouteModal label="Usage">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b ps-5 pe-2 py-2">
        <h1 className="text-sm font-medium">Usage</h1>
        {view === "limits" ? (
          <Menu>
            <MenuTrigger render={<Button variant="outline" size="sm" />}>
              {selectedLimitEnvironments === null
                ? "All environments"
                : `${selectedLimitEnvironments.size} environments`}
            </MenuTrigger>
            <MenuPopup>
              <MenuCheckboxItem
                checked={selectedLimitEnvironments === null}
                closeOnClick={false}
                onCheckedChange={(checked) =>
                  setSelectedLimitEnvironments(checked ? null : new Set())
                }
              >
                All environments
              </MenuCheckboxItem>
              <MenuSeparator />
              {Array.from(presentations, ([id, item]) => (
                <MenuCheckboxItem
                  key={id}
                  checked={selectedLimitEnvironments === null || selectedLimitEnvironments.has(id)}
                  closeOnClick={false}
                  onCheckedChange={(checked) =>
                    setSelectedLimitEnvironments((previous) => {
                      const next = new Set(previous ?? presentations.keys());
                      if (checked) next.add(id);
                      else next.delete(id);
                      return next;
                    })
                  }
                >
                  {item.entry.target.label}
                </MenuCheckboxItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : (
          <Select
            value={environmentId ?? ""}
            onValueChange={(value) => {
              const entry = Array.from(presentations.keys()).find((id) => id === value);
              if (entry) {
                setSelectedEnvironment(entry);
                setSelectedInstance(null);
              }
            }}
          >
            <SelectTrigger aria-label="Usage environment" size="compact">
              <SelectValue>{presentation?.entry.target.label ?? "Choose environment"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {Array.from(presentations, ([id, item]) => (
                <SelectItem key={id} value={id}>
                  {item.entry.target.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        {view === "stats" && runtimes.length > 1 ? (
          <Select value={runtime?.instanceId ?? ""} onValueChange={setSelectedInstance}>
            <SelectTrigger aria-label="Stats NeoPi runtime" size="compact">
              <SelectValue>{runtime?.displayName ?? runtime?.instanceId}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {runtimes.map((provider) => (
                <SelectItem key={provider.instanceId} value={provider.instanceId}>
                  {provider.displayName ?? provider.instanceId}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <div className="ms-auto">
          <ToggleGroup
            aria-label="Usage view"
            variant="segmented"
            value={[view]}
            onValueChange={(next) => {
              if (next[0] === "stats" || next[0] === "limits") setView(next[0]);
            }}
          >
            <Toggle value="stats">Stats</Toggle>
            <Toggle value="limits">Subscription limits</Toggle>
          </ToggleGroup>
        </div>
        {view === "stats" ? (
          <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
            Reconnect
          </Button>
        ) : null}
        <AppRouteModalClose />
      </header>
      {view === "limits" ? (
        <SubscriptionLimits selectedEnvironmentIds={selectedLimitEnvironments} />
      ) : environmentId !== null &&
        presentation?.connection.phase === "connected" &&
        runtime?.enabled &&
        runtime.installed ? (
        <NativeStatsFrame
          key={`${environmentId}/${runtime.instanceId}/${revision}`}
          environmentId={environmentId}
          instanceId={runtime.instanceId}
        />
      ) : (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          {presentation?.connection.error ??
            "Connect an environment with an enabled NeoPi runtime to open its native stats."}
        </p>
      )}
    </AppRouteModal>
  );
}

function SubscriptionLimits({
  selectedEnvironmentIds,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders);
  const [hiddenProviders, setHiddenProviders] = useState<ReadonlySet<UsageProviderKind>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const refresh = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await Promise.all(
        Array.from(presentations, ([id, presentation]) => {
          if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(id)) return;
          if (presentation.connection.phase !== "connected") return;
          return refreshUsageLimits(id, () => refreshProviders({ environmentId: id, input: {} }));
        }),
      );
    } finally {
      setNow(Date.now());
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-end gap-2">
          <Menu>
            <MenuTrigger render={<Button variant="outline" size="sm" />}>
              {hiddenProviders.size === 0
                ? "All providers"
                : `${PROVIDER_ORDER.length - hiddenProviders.size} providers`}
            </MenuTrigger>
            <MenuPopup>
              <MenuCheckboxItem
                checked={hiddenProviders.size === 0}
                closeOnClick={false}
                onCheckedChange={(checked) =>
                  setHiddenProviders(new Set(checked ? [] : PROVIDER_ORDER))
                }
              >
                All providers
              </MenuCheckboxItem>
              <MenuSeparator />
              {PROVIDER_ORDER.map((provider) => (
                <MenuCheckboxItem
                  key={provider}
                  checked={!hiddenProviders.has(provider)}
                  closeOnClick={false}
                  onCheckedChange={(checked) =>
                    setHiddenProviders((previous) => {
                      const next = new Set(previous);
                      if (checked) next.delete(provider);
                      else next.add(provider);
                      return next;
                    })
                  }
                >
                  {PROVIDER_PRESENTATION[provider].label}
                </MenuCheckboxItem>
              ))}
            </MenuPopup>
          </Menu>
          <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? "Refreshing…" : "Refresh limits"}
          </Button>
        </div>
        <UsageLimitsSection
          selectedEnvironmentIds={selectedEnvironmentIds}
          hiddenProviders={hiddenProviders}
          now={now}
        />
      </div>
    </ScrollArea>
  );
}

function NativeStatsFrame({
  environmentId,
  instanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string;
}) {
  const request = useAtomCommand(nativeStatsRequest, { reportFailure: false, reportDefect: false });
  const frame = useRef<HTMLIFrameElement>(null);
  const [document, setDocument] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the hosted dashboard's message ports and cancels its view on unmount
  useEffect(() => {
    const viewId = randomUUID();
    const lifetime = new AbortController();
    let clientReadyTimeout: ReturnType<typeof setTimeout> | undefined;
    const execute = async (input: NativeStatsTransportInput) => {
      const result = await request({ environmentId, input: { instanceId, viewId, ...input } });
      return AsyncResult.isSuccess(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== "null" ||
        event.ports.length !== 1
      )
        return;
      if (typeof event.data !== "object" || event.data?.type !== "neopi-stats-request") return;
      clearTimeout(clientReadyTimeout);
      setStarted(true);
      const port = event.ports[0]!;
      connectNativeStatsPort(event.data, port, execute, lifetime.signal);
    };
    window.addEventListener("message", onMessage);
    void execute({
      path: "/embed",
      method: "GET",
      signal: lifetime.signal,
      consume: async (response) => {
        const html = await response.text();
        if (!response.ok) throw new Error("Native stats could not be opened.");
        if (!lifetime.signal.aborted) {
          setDocument(html);
          clientReadyTimeout = setTimeout(() => {
            setError("The native dashboard did not start. Reconnect to try again.");
          }, 30_000);
        }
      },
    }).then((ok) => {
      if (!ok && !lifetime.signal.aborted)
        setError(
          "Native stats could not be opened. Check the environment connection and update the selected NeoPi runtime.",
        );
    });
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(clientReadyTimeout);
      lifetime.abort();
      void execute({
        path: "/",
        method: "DELETE",
        signal: new AbortController().signal,
        consume: async () => {},
      });
    };
  }, [environmentId, instanceId, request]);
  if (error)
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        {error}
      </p>
    );
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {!started ? (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          Starting the native stats dashboard…
        </p>
      ) : null}
      <iframe
        ref={frame}
        title="NeoPi stats, sessions and traces"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={document ?? undefined}
        className="min-h-0 w-full flex-1 border-0"
      />
    </div>
  );
}
