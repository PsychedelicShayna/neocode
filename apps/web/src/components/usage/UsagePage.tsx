import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { isElectron } from "../../env";
import { useEscapeToGoBack, useNavigateBack } from "../../hooks/useNavigateBack";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { nativeStatsRequest } from "../../state/neopiStats";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  connectNativeStatsPort,
  type NativeStatsTransportInput,
} from "@t3tools/client-runtime/neopi-stats-bridge";
import { randomUUID } from "../../lib/utils";

/** The native app owns ranges, calculations, traces, loading and indexing. */
export function UsagePage() {
  useEscapeToGoBack();
  const navigateBack = useNavigateBack();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const primary = useAtomValue(primaryEnvironmentIdAtom);
  const [selectedEnvironment, setSelectedEnvironment] = useState<EnvironmentId | null>(null);
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const environmentId = selectedEnvironment ?? primary ?? presentations.keys().next().value ?? null;
  const presentation = environmentId === null ? undefined : presentations.get(environmentId);
  const runtimes =
    presentation?.serverConfig?.providers.filter((provider) => provider.driver === "neopi") ?? [];
  const runtime =
    runtimes.find((provider) => provider.instanceId === selectedInstance) ??
    runtimes.find((provider) => provider.enabled) ??
    runtimes[0];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="text-sm font-medium">Stats</h1>
          <div className="no-drag flex min-w-0 flex-1 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={navigateBack}>
              Back
            </Button>
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
              <SelectTrigger aria-label="Stats environment" size="compact">
                <SelectValue>
                  {presentation?.entry.target.label ?? "Choose environment"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {Array.from(presentations, ([id, item]) => (
                  <SelectItem key={id} value={id}>
                    {item.entry.target.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {runtimes.length > 1 ? (
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
            <div className="ml-auto">
              <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
                Reconnect
              </Button>
            </div>
          </div>
        </WorkspacePageHeader>
        {environmentId !== null &&
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
      </div>
    </SidebarInset>
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
