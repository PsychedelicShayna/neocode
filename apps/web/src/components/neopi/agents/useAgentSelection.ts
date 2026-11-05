import type { AgentHubAgent, AgentHubSource } from "@t3tools/client-runtime/neopi-native-agent-hub";
import { useCallback } from "react";

import { selectAgentView, useAgentViewStore } from "./agentViewStore";

/**
 * The expanded agent, shared by the panel and the hub. Null until the user picks one,
 * and again once they click it a second time.
 */
export function useAgentSelection(source: AgentHubSource, viewKey: string) {
  const view = useAgentViewStore(selectAgentView(viewKey));
  const dispatch = useAgentViewStore((store) => store.dispatch);
  const selected: AgentHubAgent | null =
    source.agents.find((agent) => agent.id === view.selectedId) ?? null;
  const select = useCallback(
    (id: string) => dispatch(viewKey, { type: "select", id }),
    [dispatch, viewKey],
  );
  const toggle = useCallback(
    (id: string) => dispatch(viewKey, { type: "toggle", id }),
    [dispatch, viewKey],
  );
  const open = useCallback(
    (id: string) => dispatch(viewKey, { type: "open", id }),
    [dispatch, viewKey],
  );
  return { selected, select, toggle, open };
}
