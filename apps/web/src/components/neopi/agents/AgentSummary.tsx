import {
  summarizeAgentHub,
  type AgentHubAgent,
} from "@t3tools/client-runtime/neopi-native-agent-hub";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { formatCost } from "./agentFormat";

/** Counts by status, then totals. Totals NeoPi has not reported are left out, never shown as zero. */
export function AgentSummary({
  agents,
  className,
}: {
  agents: readonly AgentHubAgent[];
  className?: string;
}) {
  const summary = useMemo(() => summarizeAgentHub(agents), [agents]);
  const counts = [
    { label: "working", value: summary.working, className: "text-info-foreground" },
    { label: "idle", value: summary.idle, className: "" },
    { label: "done", value: summary.done, className: "text-success-foreground" },
    { label: "failed", value: summary.failed, className: "text-destructive-foreground" },
    { label: "stopped", value: summary.stopped, className: "" },
  ].filter((count) => count.value > 0);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground",
        className,
      )}
    >
      <span>
        {summary.total} {summary.total === 1 ? "agent" : "agents"}
      </span>
      {counts.map((count) => (
        <span key={count.label} className={count.className}>
          {count.value} {count.label}
        </span>
      ))}
      <span className="tabular-nums">Σ {formatSubagentTokenCount(summary.tokens)} tok</span>
      {summary.toolUses > 0 ? <span className="tabular-nums">{summary.toolUses} tools</span> : null}
      {summary.requests > 0 ? <span className="tabular-nums">{summary.requests} req</span> : null}
      {summary.cost !== null ? (
        <span className="tabular-nums">{formatCost(summary.cost)}</span>
      ) : null}
    </div>
  );
}
