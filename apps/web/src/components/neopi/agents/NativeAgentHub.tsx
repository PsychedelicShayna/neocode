import { Bot, XIcon } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { AgentActions } from "./AgentActions";
import { AgentDetail } from "./AgentDetail";
import { AgentRoster } from "./AgentRoster";
import { AgentSummary } from "./AgentSummary";
import { useAgentSelection } from "./useAgentSelection";
import { useAgentHubSource } from "./useNativeAgentHubSource";

/**
 * The full-screen Agent Hub: summary on top, roster on the left, the expanded agent's
 * details and transcript preview on the right. Click an agent to expand it and again to
 * collapse it; arrows or j/k move, Enter or the Open button opens it, Esc returns.
 */
export function NativeAgentHub({ viewKey, onClose }: { viewKey: string; onClose: () => void }) {
  const source = useAgentHubSource();
  const { selected, select, toggle, open } = useAgentSelection(source, viewKey);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The roster takes focus itself when there is one; an empty hub still needs Esc to work.
    if (source.agents.length === 0) rootRef.current?.focus();
  }, [source.agents.length]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="region"
      aria-label="Agent Hub"
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
        <Bot aria-hidden className="size-4 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-sm font-medium">Agent Hub</h2>
          <AgentSummary agents={source.agents} />
        </div>
        <Button size="xs" variant="ghost" onClick={onClose}>
          <XIcon aria-hidden />
          Close
          <Kbd>Esc</Kbd>
        </Button>
      </header>
      {source.agents.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm font-medium">No agents in this session</p>
          <p className="max-w-80 text-xs text-muted-foreground">
            Subagents NeoPi spawns for this session appear here while they run and after they
            finish.
          </p>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-border/60">
            <AgentRoster
              autoFocus
              agents={source.agents}
              selectedId={selected?.id ?? null}
              onSelect={select}
              onToggle={toggle}
              onOpen={open}
            />
          </div>
          <div className="min-h-0 overflow-y-auto">
            {selected === null ? (
              <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
                Select an agent to see its details and transcript.
              </div>
            ) : (
              <AgentDetail
                agent={selected}
                source={source}
                previewCount={16}
                className="mx-auto max-w-3xl p-5"
                actions={<AgentActions agent={selected} source={source} onOpen={open} />}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
