import { nativeSessionIdentityKey } from "@t3tools/shared/agentNames";
import {
  nativeAgentHubAgents,
  NATIVE_ROSTER_UNAVAILABLE_NOTE,
  SUBAGENT_MODEL_CAPABILITY,
  type AgentHubModelSelector,
  type AgentHubSource,
} from "@t3tools/client-runtime/neopi-native-agent-hub";
import {
  nativeSessionKey,
  type NativeSessionFeed,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { createContext, use, useCallback, useEffect, useMemo, type ReactNode } from "react";

import { nativeSessionAtoms, type useNativeSession } from "../../../state/neopiNativeSessions";
import { selectAgentView, useAgentViewStore } from "./agentViewStore";
type Request = ReturnType<typeof useNativeSession>["request"];

const AgentHubSourceContext = createContext<AgentHubSource | null>(null);

export function AgentHubSourceProvider({
  source,
  children,
}: {
  source: AgentHubSource;
  children: ReactNode;
}) {
  return <AgentHubSourceContext value={source}>{children}</AgentHubSourceContext>;
}

export function useAgentHubSource(): AgentHubSource {
  const source = use(AgentHubSourceContext);
  if (!source) throw new Error("Agent hub views render inside a native session.");
  return source;
}

/** The current native session's subagents as an Agent Hub source. */
export function useNativeAgentHubSource({
  target,
  feed,
  request,
}: {
  target: NativeSessionTarget;
  feed: NativeSessionFeed;
  request: Request;
}): AgentHubSource {
  const key = nativeSessionKey(target);
  const sessionId = feed.session?.sessionId;
  const sessionFile = target.ref.sessionFile;
  const agents = useMemo(
    () =>
      nativeAgentHubAgents(
        feed.agents,
        feed.agentTicks,
        nativeSessionIdentityKey({ sessionId, sessionFile }),
      ),
    [feed.agents, feed.agentTicks, sessionId, sessionFile],
  );
  const rosterWarning = feed.agentsNote ? NATIVE_ROSTER_UNAVAILABLE_NOTE : null;
  const modelControlUnavailable = feed.session?.capabilities.includes(SUBAGENT_MODEL_CAPABILITY)
    ? null
    : "This NeoPi cannot change a running agent's model yet.";
  // Model, effort and fast changes emit no frame; a re-read folds them into the roster.
  const refresh = useCallback(() => request({ type: "get_subagents" }), [request]);
  const readTranscript = useCallback(
    (subagentId: string, fromByte: number) =>
      request({ type: "get_subagent_messages", subagentId, fromByte }),
    [request],
  );
  const steer = useCallback(
    async (subagentId: string, message: string) => {
      await request({ type: "steer_subagent", subagentId, message });
    },
    [request],
  );
  const setEffort = useCallback(
    async (subagentId: string, level: string) => {
      await request({ type: "set_subagent_thinking_level", subagentId, level });
      await refresh();
    },
    [request, refresh],
  );
  const setFast = useCallback(
    async (subagentId: string, enabled: boolean) => {
      await request({ type: "set_subagent_fast", subagentId, enabled });
      await refresh();
    },
    [request, refresh],
  );
  const setModel = useCallback(
    async (subagentId: string, selector: AgentHubModelSelector) => {
      await request({
        type: "set_subagent_model",
        subagentId,
        ...(selector.kind === "role"
          ? { selector: `@${selector.role.replace(/^@/, "")}` }
          : { provider: selector.provider, modelId: selector.modelId }),
      });
      await refresh();
    },
    [request, refresh],
  );
  const cancel = useCallback(
    async (subagentId: string) => {
      await request({ type: "cancel_subagent", subagentId });
    },
    [request],
  );

  // An open child view adds that child to the session's demand; the server
  // raises NeoPi's subscription for it. Without its run token it cannot be named.
  const openChild = useAgentViewStore((store) => {
    const view = selectAgentView(key)(store);
    return view.mode === "agent" ? view.selectedId : null;
  });
  const rosterEntry = openChild
    ? feed.observation.entities.get(`roster:${openChild}`)?.value
    : undefined;
  const childRunToken = rosterEntry?.class === "roster" ? rosterEntry.value.runToken : undefined;
  useEffect(() => {
    if (openChild === null || typeof childRunToken !== "string") return;
    return nativeSessionAtoms.holdDemand(target, [
      { kind: "child", childId: openChild, runToken: childRunToken },
    ]);
    // `target` is read for the key it is part of.
  }, [key, openChild, childRunToken]);

  return useMemo(
    () => ({
      key,
      agents,
      rosterWarning,
      modelControlUnavailable,
      readTranscript,
      steer,
      setEffort,
      setFast,
      setModel,
      cancel,
    }),
    [
      key,
      agents,
      rosterWarning,
      modelControlUnavailable,
      readTranscript,
      steer,
      setEffort,
      setFast,
      setModel,
      cancel,
    ],
  );
}
