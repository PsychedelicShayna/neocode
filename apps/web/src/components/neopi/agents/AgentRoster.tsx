import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { AgentHubAgent } from "@t3tools/client-runtime/neopi-native-agent-hub";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { elapsedBetween, formatCost } from "./agentFormat";

const STATUS_VISUALS: Record<AgentHubAgent["status"], { dot: string; label: string }> = {
  pending: { dot: "bg-info", label: "Working" },
  running: { dot: "bg-info", label: "Working" },
  waiting: { dot: "bg-info", label: "Waiting" },
  idle: { dot: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dot: "bg-success", label: "Completed" },
  failed: { dot: "bg-destructive", label: "Failed" },
  cancelled: { dot: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dot: "bg-muted-foreground/60", label: "Disconnected" },
};

export const agentStatusLabel = (status: AgentHubAgent["status"]) => STATUS_VISUALS[status].label;

export function AgentStatusDot({ status }: { status: AgentHubAgent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dot)}
    />
  );
}

/** Live agents tick through DOM writes, so a running roster commits no React renders per second. */
export function AgentElapsed({
  agent,
  className,
}: {
  agent: Pick<AgentHubAgent, "live" | "startedAt" | "completedAt">;
  className?: string;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const { live, startedAt } = agent;
  useEffect(() => {
    if (!live || !startedAt) return;
    const update = () => {
      if (textRef.current) textRef.current.textContent = elapsedBetween(startedAt, null);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);
  if (!startedAt) return null;
  return (
    <span ref={textRef} className={cn("tabular-nums", className)}>
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

/** Model, effort and fast mode as one compact chip line; absent facts are left out. */
export function agentModelText(agent: AgentHubAgent): string | null {
  const label = formatSubagentModelLabel(agent.model, agent.effort);
  const fast = agent.fast?.enabled ? "fast" : null;
  return [label, fast].filter((part): part is string => part !== null).join(" · ") || null;
}

export function agentMetricsText(agent: AgentHubAgent): string {
  return [
    agent.tokens !== null ? `${formatSubagentTokenCount(agent.tokens)} tok` : "— tok",
    agent.toolUses !== null ? `${agent.toolUses} tools` : null,
    agent.requests !== null ? `${agent.requests} req` : null,
    agent.cost !== null ? formatCost(agent.cost) : null,
    agent.runs > 1 ? `run ${agent.runs}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function AgentRow({
  agent,
  selected,
  onToggle,
}: {
  agent: AgentHubAgent;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const model = agentModelText(agent);
  return (
    <div
      ref={ref}
      id={`agent-row-${agent.id}`}
      role="option"
      aria-selected={selected}
      aria-expanded={selected}
      data-agent-row
      onClick={() => onToggle(agent.id)}
      className={cn(
        "grid h-[4.5rem] shrink-0 cursor-pointer grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1.125rem] items-center gap-x-2 rounded-lg border border-border/50 bg-card/30 px-2.5 py-1.5 hover:bg-accent/40",
        selected && "border-border bg-accent/70 hover:bg-accent/70",
      )}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <AgentStatusDot status={agent.status} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{agent.title}</span>
        <span
          className="shrink-0 text-2xs text-muted-foreground/70"
          title={`${agent.identity.label} · ${agent.identity.pronouns}`}
        >
          {agent.identity.label}
        </span>
        {role ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 text-3xs text-muted-foreground">
            {role}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right text-2xs text-muted-foreground/80">
        <AgentElapsed agent={agent} />
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {agent.activity ?? agent.task ?? STATUS_VISUALS[agent.status].label}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate text-2xs tabular-nums text-muted-foreground/70">
        {[model, agentMetricsText(agent)].filter(Boolean).join(" · ")}
      </span>
      <span className="sr-only">{STATUS_VISUALS[agent.status].label}</span>
    </div>
  );
}

/**
 * The selectable roster. A click expands an agent's detail and a second click
 * collapses it; arrow keys or j/k move the expanded agent, Home/End jump, and Enter
 * opens it. Roster rows keep three fixed lines so live data never changes their height.
 */
export function AgentRoster({
  agents,
  selectedId,
  onSelect,
  onToggle,
  onOpen,
  autoFocus = false,
  className,
}: {
  agents: readonly AgentHubAgent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) listRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = agents.findIndex((agent) => agent.id === selectedId);
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "j")
      next = Math.min(agents.length - 1, index + 1);
    else if (event.key === "ArrowUp" || event.key === "k") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = agents.length - 1;
    else if (event.key === "Enter" && selectedId !== null) {
      event.preventDefault();
      onOpen(selectedId);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    const agent = agents[next];
    if (agent) onSelect(agent.id);
  };
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Agents"
      aria-activedescendant={selectedId === null ? undefined : `agent-row-${selectedId}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn("flex flex-col gap-1.5 p-2 outline-none", className)}
    >
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          selected={agent.id === selectedId}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}
