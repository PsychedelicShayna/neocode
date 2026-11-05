import { Bot } from "lucide-react";

import { AgentActions } from "./AgentActions";
import { AgentDetail } from "./AgentDetail";
import { AgentRoster } from "./AgentRoster";
import { AgentSummary } from "./AgentSummary";
import { useAgentSelection } from "./useAgentSelection";
import { useAgentHubSource } from "./useNativeAgentHubSource";

/**
 * The agents right-panel surface: the roster, and below it the expanded agent's facts
 * and transcript preview. Click an agent to expand it and again to collapse it; open
 * its own view with the Open button, or with Enter once it is expanded.
 */
export function NativeAgentsPanel({ viewKey }: { viewKey: string }) {
  const source = useAgentHubSource();
  const { selected, select, toggle, open } = useAgentSelection(source, viewKey);
  if (source.agents.length === 0)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this session spawns subagents, they show up here with live status, activity and token
          usage.
        </p>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
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
            actions={<AgentActions agent={selected} source={source} onOpen={open} />}
          />
        </div>
      )}
    </div>
  );
}
