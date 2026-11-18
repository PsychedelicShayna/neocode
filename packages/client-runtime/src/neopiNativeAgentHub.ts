import type { NeoPiJournalEntry } from "@t3tools/contracts";
import { agentIdentity, type AgentIdentity } from "@t3tools/shared/agentNames";
import { journalRecord } from "./neopiJournal.ts";
import type { NativeSubagent, NativeSubagentFacts } from "./neopiNativeSubagents.ts";
import { isActiveSubagentStatus, type RuntimeSubagentStatus } from "./state/subagentRuntime.ts";

/**
 * One agent as the Agent Hub shows it. The hub knows nothing about native
 * sessions: a source (the current session today, a NeoCore daemon listing
 * agents across instances later) maps its own agents into this shape.
 */
export interface AgentHubAgent {
  /** Unique within its source. */
  readonly id: string;
  /** Its name and designation, drawn from the id so it is the same on every client. */
  readonly identity: AgentIdentity;
  readonly title: string;
  readonly role: string | null;
  /**
   * `interrupted` with `unobservedSince` set means finished while no view
   * watched, outcome unknown: show and count it as finished, never as interrupted.
   */
  readonly status: RuntimeSubagentStatus;
  /** When the last view left, for a child that finished unseen; null otherwise. */
  readonly unobservedSince: number | null;
  /** Working: the agent is running or waiting, so steering and live controls apply. */
  readonly live: boolean;
  readonly model: string | null;
  readonly effort: string | null;
  readonly fast: { readonly enabled: boolean; readonly active: boolean } | null;
  readonly task: string | null;
  /** What it is doing now, or how it ended. */
  readonly activity: string | null;
  readonly tokens: number | null;
  readonly toolUses: number | null;
  readonly requests: number | null;
  readonly cost: number | null;
  readonly contextTokens: number | null;
  readonly contextWindow: number | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
  /** Settled-step counter; changes when its transcript has grown. */
  readonly ticks: number;
  readonly runs: number;
  readonly recentTools: NativeSubagentFacts["recentTools"];
}

export interface AgentHubSource {
  /** Identifies this source, and so its transcripts, among every source the hub can show. */
  readonly key: string;
  readonly agents: readonly AgentHubAgent[];
  /** Present only when NeoPi refused the requested live roster subscription. */
  readonly rosterWarning?: string | null;
  /** Why the model control is unavailable; `null` when NeoPi can change a child's model. */
  readonly modelControlUnavailable: string | null;
  /** Rejects with the harness message. `fromByte` is the previous result's `nextByte`. */
  readTranscript(agentId: string, fromByte: number): Promise<unknown>;
  steer(agentId: string, message: string): Promise<void>;
  setEffort(agentId: string, level: string): Promise<void>;
  setFast(agentId: string, enabled: boolean): Promise<void>;
  setModel(agentId: string, selector: AgentHubModelSelector): Promise<void>;
  cancel(agentId: string): Promise<void>;
}

export const NATIVE_ROSTER_UNAVAILABLE_NOTE =
  "Live agent updates are unavailable from this session's NeoPi. The list is as of the last refresh.";

export type AgentHubModelSelector =
  | { readonly kind: "role"; readonly role: string }
  | { readonly kind: "model"; readonly provider: string; readonly modelId: string };

/** Capability NeoPi advertises once `set_subagent_model` exists. */
export const SUBAGENT_MODEL_CAPABILITY = "set_subagent_model";

/**
 * `sessionKey` is the parent session's identity key: agent ids can be as plain
 * as `worker`, so each child's name draws from its parent's key and its own id.
 */
export function nativeAgentHubAgents(
  agents: readonly NativeSubagent[],
  ticks: Readonly<Record<string, number>>,
  sessionKey: string,
): readonly AgentHubAgent[] {
  return [...agents]
    .filter((agent) => agent.kind === "subagent")
    .sort(
      (a, b) =>
        a.firstSeenAt.localeCompare(b.firstSeenAt) ||
        (a.agentIndex ?? 0) - (b.agentIndex ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .map((agent) => {
      const facts = agent.native.facts;
      return {
        id: agent.id,
        identity: agentIdentity(`${sessionKey}#${agent.id}`),
        title: agent.title,
        role: agent.role,
        status: agent.status,
        unobservedSince: agent.native.unobservedSince,
        live: isActiveSubagentStatus(agent.status),
        model: agent.model,
        effort: agent.effort,
        fast: facts.fast,
        task: facts.task,
        activity: isActiveSubagentStatus(agent.status)
          ? (agent.progress ?? agent.result ?? agent.error)
          : (agent.error ?? agent.result ?? agent.progress),
        tokens: agent.usage?.totalTokens ?? null,
        toolUses: agent.usage?.toolUses ?? null,
        requests: facts.requests,
        cost: facts.cost,
        contextTokens: facts.contextTokens,
        contextWindow: facts.contextWindow,
        startedAt: agent.startedAt,
        completedAt: agent.completedAt,
        updatedAt: agent.updatedAt,
        ticks: ticks[agent.id] ?? 0,
        runs: agent.activationCount,
        recentTools: facts.recentTools,
      };
    });
}

export interface AgentHubSummary {
  readonly total: number;
  readonly working: number;
  readonly idle: number;
  readonly done: number;
  readonly failed: number;
  readonly stopped: number;
  readonly tokens: number;
  /** Null until at least one agent reports a cost. */
  readonly cost: number | null;
  readonly toolUses: number;
  readonly requests: number;
}

export function summarizeAgentHub(agents: readonly AgentHubAgent[]): AgentHubSummary {
  let working = 0;
  let idle = 0;
  let done = 0;
  let failed = 0;
  let stopped = 0;
  let tokens = 0;
  let cost: number | null = null;
  let toolUses = 0;
  let requests = 0;
  for (const agent of agents) {
    if (agent.live) working++;
    else if (agent.status === "idle") idle++;
    // Finished unseen counts as done (outcome unknown), never as stopped.
    else if (agent.status === "completed" || agent.unobservedSince !== null) done++;
    else if (agent.status === "failed") failed++;
    else stopped++;
    tokens += agent.tokens ?? 0;
    toolUses += agent.toolUses ?? 0;
    requests += agent.requests ?? 0;
    if (agent.cost !== null) cost = (cost ?? 0) + agent.cost;
  }
  return {
    total: agents.length,
    working,
    idle,
    done,
    failed,
    stopped,
    tokens,
    cost,
    toolUses,
    requests,
  };
}

/** Context fill in [0, 1], or null when NeoPi has not reported both numbers. */
export function agentContextFill(agent: AgentHubAgent): number | null {
  if (agent.contextTokens === null || agent.contextWindow === null || agent.contextWindow <= 0)
    return null;
  return Math.min(1, agent.contextTokens / agent.contextWindow);
}

/** A child transcript read so far; `nextByte` is the cursor for the next incremental read. */
export interface AgentTranscript {
  readonly agentId: string;
  readonly entries: readonly NeoPiJournalEntry[];
  readonly nextByte: number;
}

/**
 * Folds one `get_subagent_messages` result into the transcript read so far.
 * A reset (the file shrank) starts over; a chunk that does not continue from
 * the cursor is a stale reply and changes nothing.
 */
export function foldAgentTranscript(
  previous: AgentTranscript | null,
  agentId: string,
  result: unknown,
): AgentTranscript | null {
  const chunk = journalRecord(result);
  const { fromByte, nextByte, entries } = chunk;
  if (typeof fromByte !== "number" || typeof nextByte !== "number" || !Array.isArray(entries))
    return previous;
  const base = previous?.agentId === agentId ? previous : null;
  const reset = chunk.reset === true || base === null;
  if (!reset && base !== null && fromByte !== base.nextByte) return base;
  const kept = reset ? [] : base!.entries;
  const seen = new Set(kept.map((entry) => entry.id));
  const added: NeoPiJournalEntry[] = [];
  for (const value of entries) {
    const entry = journalRecord(value);
    // The header record opens every session file; it is not conversation.
    if (
      typeof entry.id !== "string" ||
      typeof entry.type !== "string" ||
      typeof entry.timestamp !== "string" ||
      entry.type === "session" ||
      seen.has(entry.id)
    )
      continue;
    seen.add(entry.id);
    added.push({
      ...entry,
      id: entry.id,
      type: entry.type,
      timestamp: entry.timestamp,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
    });
  }
  return {
    agentId,
    entries: added.length === 0 && !reset ? kept : [...kept, ...added],
    nextByte,
  };
}
