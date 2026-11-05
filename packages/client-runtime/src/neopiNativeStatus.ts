/**
 * What a native workspace's status bar shows, projected from NeoPi's `get_state`
 * snapshot and the feed's lifecycle frames. NeoPi stays authoritative: nothing
 * here estimates a value NeoPi did not report.
 */
import { isActiveSubagentStatus, type RuntimeSubagent } from "./state/subagentRuntime.ts";
import type { NativeSubagent } from "./neopiNativeSubagents.ts";

const nonnegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/**
 * Share of prompt tokens served from cache, as NeoPi's TUI computes it:
 * `cacheRead / (input + cacheRead + cacheWrite)`. Null while nothing was ever
 * read from cache, so providers without prompt caching show no rate.
 */
export function cacheHitPercent(usage: Readonly<Record<string, unknown>>): number | null {
  const cacheRead = nonnegative(usage.cacheRead);
  if (!cacheRead) return null;
  const prompt = (nonnegative(usage.input) ?? 0) + cacheRead + (nonnegative(usage.cacheWrite) ?? 0);
  return (cacheRead / prompt) * 100;
}

export interface NativeStatusFacts {
  readonly model: string | null;
  readonly thinkingLevel: string | null;
  readonly cacheHitPercent: number | null;
  readonly tokensPerSecond: number | null;
  readonly context: {
    readonly percent: number;
    readonly tokens: number | null;
    readonly contextWindow: number;
  } | null;
  /** Journal cost including completed subagents; `partial` while advisor spend is not yet restored. */
  readonly cost: { readonly amount: number; readonly partial: boolean } | null;
  /** Reported only by a NeoPi that advertises `status_facts`. */
  readonly hostname: string | null;
  /** NeoPi's own running-job count; absent before `status_facts`. */
  readonly runningJobCount: number | null;
}

export function nativeStatusFacts(state: Readonly<Record<string, unknown>>): NativeStatusFacts {
  const model = record(state.model);
  const name = text(model.name) ?? text(model.id);
  const usage = record(state.sessionUsage);
  const context = record(state.contextUsage);
  const contextWindow = nonnegative(context.contextWindow);
  const percent = nonnegative(context.percent);
  const cost = nonnegative(usage.cost);
  const advisorCost = nonnegative(usage.advisorCost);
  const advisorReady = usage.advisorCostState === "ready" && advisorCost !== null;
  return {
    model: name?.startsWith("Claude ") ? name.slice(7) : name,
    thinkingLevel: text(state.thinkingLevel),
    cacheHitPercent: cacheHitPercent(usage),
    tokensPerSecond: nonnegative(state.tokensPerSecond) || null,
    context:
      contextWindow !== null && contextWindow > 0 && percent !== null
        ? { percent, tokens: nonnegative(context.tokens), contextWindow }
        : null,
    cost:
      cost === null
        ? null
        : { amount: cost + (advisorReady ? advisorCost : 0), partial: !advisorReady },
    hostname: text(state.hostname),
    runningJobCount: nonnegative(state.runningJobCount),
  };
}

/**
 * Time the agent was actually working: the sum of `agent_start`→`agent_end`
 * windows, plus the open one. Idle time between turns never accumulates.
 */
export interface NativeActivity {
  readonly accumulatedMs: number;
  /** Epoch ms the open window started; null while idle. */
  readonly openedAt: number | null;
}

export const EMPTY_NATIVE_ACTIVITY: NativeActivity = { accumulatedMs: 0, openedAt: null };

export function openNativeActivity(activity: NativeActivity, at: number): NativeActivity {
  return activity.openedAt === null ? { ...activity, openedAt: at } : activity;
}

export function closeNativeActivity(activity: NativeActivity, at: number): NativeActivity {
  return activity.openedAt === null
    ? activity
    : {
        accumulatedMs: activity.accumulatedMs + Math.max(0, at - activity.openedAt),
        openedAt: null,
      };
}

export function nativeActiveMs(activity: NativeActivity, now: number): number {
  return (
    activity.accumulatedMs + (activity.openedAt === null ? 0 : Math.max(0, now - activity.openedAt))
  );
}

/**
 * A fresh `get_state`: NeoPi's `activeTimeMs` (when it reports one) replaces
 * what the frames added up, since it also covers time before this client
 * attached. A running turn continues from now.
 */
export function observeNativeActivity(
  activity: NativeActivity,
  state: Readonly<Record<string, unknown>>,
  busy: boolean,
  at: number,
): NativeActivity {
  const reported = nonnegative(state.activeTimeMs);
  if (reported === null) return busy ? openNativeActivity(activity, at) : activity;
  return { accumulatedMs: reported, openedAt: busy ? at : null };
}

/** `4s`, `3m 12s`, `1h 05m`: whole units, never fractional. */
export function formatActiveDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How the subagent count changed. Priority: error beats exit beats spawn. */
export type SubagentFlash = "spawn" | "exit" | "error";

const FLASH_PRIORITY: Record<SubagentFlash, number> = { spawn: 1, exit: 2, error: 3 };

function flashFor(
  previous: NativeSubagent | undefined,
  next: NativeSubagent,
): SubagentFlash | null {
  // Losing the connection interrupts agents without any of them having exited.
  if (previous?.native.disconnected || next.native.disconnected) return null;
  // History hydration is not a spawn or an exit.
  if (next.native.restored) return null;
  const wasActive = previous !== undefined && isActiveSubagentStatus(previous.status);
  const active = isActiveSubagentStatus(next.status);
  if (active) return wasActive ? null : "spawn";
  if (previous !== undefined && !wasActive && previous.status === next.status) return null;
  return next.status === "failed" ? "error" : "exit";
}

/**
 * The most significant lifecycle change between two roster observations, or null
 * when nothing spawned, exited or failed. Progress updates change nothing here.
 */
export function subagentFlashFor(
  previous: readonly NativeSubagent[],
  next: readonly NativeSubagent[],
): SubagentFlash | null {
  if (previous === next) return null;
  const before = new Map(previous.map((agent) => [agent.id, agent]));
  let result: SubagentFlash | null = null;
  for (const agent of next) {
    const flash = flashFor(before.get(agent.id), agent);
    if (flash && (result === null || FLASH_PRIORITY[flash] > FLASH_PRIORITY[result]))
      result = flash;
  }
  return result;
}

/**
 * `pulse` advances with every event so a burst restarts the hold timer; the kind
 * keeps the most significant event of the burst until the flash settles.
 */
export interface SubagentFlashState {
  readonly kind: SubagentFlash | null;
  readonly pulse: number;
}

export const IDLE_SUBAGENT_FLASH: SubagentFlashState = { kind: null, pulse: 0 };

export function reduceSubagentFlash(
  state: SubagentFlashState,
  event: SubagentFlash | "settle",
): SubagentFlashState {
  if (event === "settle") return state.kind === null ? state : { ...state, kind: null };
  const kind =
    state.kind !== null && FLASH_PRIORITY[state.kind] > FLASH_PRIORITY[event] ? state.kind : event;
  return { kind, pulse: state.pulse + 1 };
}

/** Subagents the user may still be waiting on. */
export const liveSubagentCount = (agents: readonly RuntimeSubagent[]): number =>
  agents.filter((agent) => isActiveSubagentStatus(agent.status)).length;
