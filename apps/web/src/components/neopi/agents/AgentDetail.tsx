import {
  agentContextFill,
  type AgentHubAgent,
  type AgentHubSource,
} from "@t3tools/client-runtime/neopi-native-agent-hub";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { useMemo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { AgentElapsed, AgentStatusDot, agentStatusLabel } from "./AgentRoster";
import { formatCost, previewLines } from "./agentFormat";
import { useAgentTranscript } from "./useAgentTranscript";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-3xs font-medium uppercase tracking-wider text-muted-foreground/70">
        {label}
      </dt>
      <dd className="truncate text-xs tabular-nums">{children}</dd>
    </div>
  );
}

function ContextMeter({ agent }: { agent: AgentHubAgent }) {
  const fill = agentContextFill(agent);
  if (fill === null || agent.contextTokens === null || agent.contextWindow === null) return null;
  const percent = Math.round(fill * 100);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-3xs font-medium uppercase tracking-wider text-muted-foreground/70">
        <span>Context</span>
        <span className="font-mono normal-case tabular-nums">
          {formatSubagentTokenCount(agent.contextTokens)} /{" "}
          {formatSubagentTokenCount(agent.contextWindow)} · {percent}%
        </span>
      </div>
      <div
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            percent >= 90 ? "bg-destructive" : percent >= 70 ? "bg-warning" : "bg-info",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

const PREVIEW_LABEL = { user: "You", assistant: "Agent", tool: "Tool", note: "Note" } as const;

function TranscriptPreview({
  source,
  agent,
  lines,
}: {
  source: AgentHubSource;
  agent: AgentHubAgent;
  lines: number;
}) {
  const { rows, loading, error } = useAgentTranscript(source, agent);
  const preview = useMemo(() => previewLines(rows, lines), [rows, lines]);
  return (
    <section className="flex min-h-0 flex-col gap-1.5 rounded-lg border border-border/50 bg-card/30 p-2.5">
      <h3 className="text-3xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Transcript
      </h3>
      {error ? (
        <p className="text-xs text-destructive-foreground">{error}</p>
      ) : preview.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {loading ? "Reading transcript…" : "Nothing in this agent's transcript yet."}
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {preview.map((line) => (
            <li key={line.id} className="flex gap-2 text-xs">
              <span className="w-10 shrink-0 pt-px text-3xs uppercase text-muted-foreground/60">
                {PREVIEW_LABEL[line.kind]}
              </span>
              <span
                className={cn(
                  "line-clamp-4 min-w-0 whitespace-pre-wrap break-words",
                  line.kind === "tool" && "font-mono text-2xs text-muted-foreground",
                  line.kind === "user" && "text-foreground/80",
                  line.error && "text-destructive-foreground",
                )}
              >
                {line.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Facts, context, recent activity and a transcript preview for one agent. */
export function AgentDetail({
  agent,
  source,
  previewCount,
  actions,
  className,
}: {
  agent: AgentHubAgent;
  source: AgentHubSource;
  previewCount: number;
  actions?: ReactNode;
  className?: string;
}) {
  const model = formatSubagentModelLabel(agent.model, null);
  return (
    <div className={cn("flex flex-col gap-3 p-3", className)}>
      <header className="flex items-start gap-2">
        <span className="pt-1.5">
          <AgentStatusDot status={agent.status} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium [overflow-wrap:anywhere]">{agent.title}</span>
          <span className="flex items-center gap-2 text-2xs text-muted-foreground">
            <span>{agentStatusLabel(agent.status)}</span>
            <span>
              · {agent.identity.label} ({agent.identity.pronouns})
            </span>
            {agent.role ? <span>· {agent.role}</span> : null}
            <AgentElapsed agent={agent} />
          </span>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-border/50 bg-card/30 p-2.5">
        <Fact label="Model">{model ?? "—"}</Fact>
        <Fact label="Effort">{agent.effort ?? "—"}</Fact>
        <Fact label="Fast">{agent.fast === null ? "—" : agent.fast.enabled ? "on" : "off"}</Fact>
        <Fact label="Runs">{agent.runs}</Fact>
        <Fact label="Tokens">
          {agent.tokens !== null ? formatSubagentTokenCount(agent.tokens) : "—"}
        </Fact>
        <Fact label="Requests">{agent.requests ?? "—"}</Fact>
        <Fact label="Tools">{agent.toolUses ?? "—"}</Fact>
        <Fact label="Cost">{agent.cost !== null ? formatCost(agent.cost) : "—"}</Fact>
      </dl>
      <ContextMeter agent={agent} />
      {agent.task ? (
        <section className="flex flex-col gap-1 rounded-lg border border-border/50 bg-card/30 p-2.5">
          <h3 className="text-3xs font-medium uppercase tracking-wider text-muted-foreground/70">
            Task
          </h3>
          <p className="max-h-28 overflow-y-auto whitespace-pre-wrap text-xs text-foreground/90 [overflow-wrap:anywhere]">
            {agent.task}
          </p>
        </section>
      ) : null}
      {agent.activity || agent.recentTools.length > 0 ? (
        <section className="flex flex-col gap-1 rounded-lg border border-border/50 bg-card/30 p-2.5">
          <h3 className="text-3xs font-medium uppercase tracking-wider text-muted-foreground/70">
            {agent.live ? "Now" : "Outcome"}
          </h3>
          {agent.activity ? (
            <p
              className={cn(
                "line-clamp-6 whitespace-pre-wrap text-xs [overflow-wrap:anywhere]",
                agent.status === "failed" && "text-destructive-foreground",
              )}
            >
              {agent.activity}
            </p>
          ) : null}
          {agent.recentTools.length > 0 ? (
            <ul className="flex flex-col gap-0.5 rounded-md bg-muted/40 p-1.5 font-mono text-2xs text-muted-foreground">
              {agent.recentTools.slice(-5).map((tool, index) => (
                <li
                  key={`${index}:${tool.tool}`}
                  className={cn("truncate", tool.isError && "text-destructive-foreground")}
                >
                  ▸ {tool.tool}
                  {tool.args ? ` ${tool.args}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <TranscriptPreview source={source} agent={agent} lines={previewCount} />
    </div>
  );
}
