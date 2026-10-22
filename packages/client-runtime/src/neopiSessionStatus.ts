import type { NeoPiSessionConfigurationResult } from "@t3tools/contracts";

const nonnegative = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Present native observations without deriving session totals from rendered messages. */
export function projectNeoPiSessionStatus(
  snapshot: NeoPiSessionConfigurationResult,
  connected: boolean,
) {
  if (snapshot.status === "unavailable") {
    return { status: "unavailable" as const, reason: snapshot.reason };
  }
  if (!connected) {
    return { status: "stale" as const, reason: "The native session disconnected. Reconnect to read its status." };
  }
  const telemetry = snapshot.telemetry;
  const usage = telemetry?.sessionUsage;
  const input = nonnegative(usage?.input);
  const cacheRead = nonnegative(usage?.cacheRead);
  const cacheWrite = nonnegative(usage?.cacheWrite);
  const promptTokens = input !== null && cacheRead !== null && cacheWrite !== null
    ? input + cacheRead + cacheWrite
    : null;
  const journalCost = nonnegative(usage?.cost);
  const advisorCost = nonnegative(usage?.advisorCost);
  const contextWindow = nonnegative(telemetry?.context?.contextWindow);
  const percent = nonnegative(telemetry?.context?.percent);
  return {
    status: "observed" as const,
    sessionId: snapshot.sessionId,
    attachment: snapshot.attachment,
    observedAt: snapshot.observedAt,
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    tokensPerSecond: nonnegative(telemetry?.tokensPerSecond),
    cacheHitPercent: promptTokens !== null && promptTokens > 0 && cacheRead !== null
      ? cacheRead / promptTokens * 100
      : null,
    context: contextWindow !== null && contextWindow > 0 && percent !== null
      ? { percent, contextWindow, tokens: nonnegative(telemetry?.context?.tokens) }
      : null,
    // Completed task costs are already in journalCost. Never add subagentCost again.
    recordedCost: usage?.advisorCostState === "ready" && journalCost !== null && advisorCost !== null
      ? journalCost + advisorCost
      : null,
    costState: usage?.advisorCostState ?? "unavailable",
    approvalMode: telemetry?.approvalMode ?? null,
  };
}
