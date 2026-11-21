import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import * as Schema from "effect/Schema";
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { NativeManagedTuiView } from "../NativeSessionTerminal";

import { AgentActions } from "./AgentActions";
import { AgentDetail } from "./AgentDetail";
import { AgentRoster } from "./AgentRoster";
import { AgentSummary } from "./AgentSummary";
import { useAgentSelection } from "./useAgentSelection";
import { useAgentHubSource } from "./useNativeAgentHubSource";

const decodeAdvisorHistory = Schema.decodeUnknownSync(
  Schema.Struct({
    subagents: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        kind: Schema.String,
        displayName: Schema.String,
      }),
    ),
  }),
);

interface MonitorOptions {
  readonly target: NativeSessionTarget;
  readonly cwd: string;
  readonly request: (command: Record<string, unknown> & { type: string }) => Promise<unknown>;
}

/**
 * The agents right-panel surface: the roster, and below it the expanded agent's facts
 * and transcript preview. Click an agent to expand it and again to collapse it; open
 * its own view with the Open button, or with Enter once it is expanded.
 */
export function NativeAgentsPanel({
  viewKey,
  monitor,
}: {
  viewKey: string;
  monitor?: MonitorOptions | undefined;
}) {
  const source = useAgentHubSource();
  const { selected, select, toggle, open } = useAgentSelection(source, viewKey);
  const [monitorView, setMonitorView] = useState<{
    agentId: string;
    viewId: string;
    label: string;
  } | null>(null);
  const request = monitor?.request;
  const [advisorHistory, setAdvisorHistory] = useState<
    { rows: ReadonlyArray<{ id: string; displayName: string }> } | { error: string } | null
  >(null);
  useEffect(() => {
    if (!request) return;
    let mounted = true;
    void request({ type: "get_subagent_history", includeAdvisors: true })
      .then((result) => {
        if (!mounted) return;
        const { subagents } = decodeAdvisorHistory(result);
        setAdvisorHistory({ rows: subagents.filter((row) => row.kind === "advisor") });
      })
      .catch(() => {
        if (mounted) setAdvisorHistory({ error: "Could not list NeoPi advisors." });
      });
    return () => {
      mounted = false;
    };
  }, [request]);

  const showMonitor = (agentId: string, label: string) => {
    // getRandomValues also works when this remote web client is served over HTTP.
    const viewId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    setMonitorView({ agentId, viewId, label });
  };
  if (monitor && monitorView) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <span className="truncate text-sm font-medium">{monitorView.label}</span>
          <Button size="xs" variant="outline" onClick={() => setMonitorView(null)}>
            Hide monitor
          </Button>
        </div>
        <NativeManagedTuiView
          target={monitor.target}
          cwd={monitor.cwd}
          monitor={monitorView}
          onSessionExited={() => setMonitorView(null)}
        />
      </div>
    );
  }
  const advisors = monitor && advisorHistory && "rows" in advisorHistory ? advisorHistory.rows : [];
  const advisorError =
    monitor && advisorHistory && "error" in advisorHistory ? advisorHistory.error : null;
  if (source.agents.length === 0 && advisors.length === 0 && !advisorError)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          {source.rosterWarning ??
            "When this session spawns subagents, they show up here with live status, activity and token usage."}
        </p>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {source.rosterWarning ? (
        <p role="status" className="shrink-0 px-3 py-2 text-xs text-muted-foreground">
          {source.rosterWarning}
        </p>
      ) : null}
      <AgentSummary
        agents={source.agents}
        className="shrink-0 border-b border-border/60 px-3 py-1.5"
      />
      <div
        className={
          selected === null
            ? "min-h-0 flex-1 overflow-y-auto"
            : "max-h-[45%] min-h-[5.5rem] shrink-0 overflow-y-auto border-b border-border/60"
        }
      >
        {advisorError ? (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            {advisorError}
          </p>
        ) : null}
        {advisors.length > 0 ? (
          <section aria-label="Advisors" className="border-b border-border/60 px-3 py-2">
            <h3 className="text-xs font-medium text-muted-foreground">Advisors</h3>
            <ul>
              {advisors.map((advisor) => (
                <li key={advisor.id} className="flex items-center justify-between gap-2 py-1">
                  <span className="truncate text-sm">{advisor.displayName}</span>
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={`Monitor ${advisor.displayName} (view only)`}
                    onClick={() => showMonitor(advisor.id, advisor.displayName)}
                  >
                    Monitor
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <AgentRoster
          agents={source.agents}
          selectedId={selected?.id ?? null}
          onSelect={select}
          onToggle={toggle}
          onOpen={open}
        />
      </div>
      {selected === null ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AgentDetail
            agent={selected}
            source={source}
            previewCount={6}
            actions={
              <>
                {monitor ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => showMonitor(selected.id, selected.title)}
                  >
                    Monitor
                  </Button>
                ) : null}
                <AgentActions agent={selected} source={source} onOpen={open} />
              </>
            }
          />
        </div>
      )}
    </div>
  );
}
