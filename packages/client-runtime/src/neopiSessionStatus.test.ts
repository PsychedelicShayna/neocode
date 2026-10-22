import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type NeoPiSessionConfigurationResult } from "@t3tools/contracts";
import { projectNeoPiSessionStatus } from "./neopiSessionStatus";

type Available = Extract<NeoPiSessionConfigurationResult, { status: "available" }>;
const snapshot = (): Available => ({
  status: "available",
  providerInstanceId: ProviderInstanceId.make("native"),
  sessionId: "first",
  attachment: "owned",
  observedAt: "2026-10-22T00:00:00.000Z",
  model: { provider: "openai", id: "actual", name: null },
  thinkingLevel: "high",
  activeRole: null,
  roles: { status: "unsupported", reason: "No roles" },
  telemetry: {
    tokensPerSecond: 42,
    context: { tokens: 1000, contextWindow: 2000, percent: 50 },
    sessionUsage: {
      input: 10, cacheRead: 80, cacheWrite: 10, cost: 12,
      subagentCost: 4, advisorCost: 3, advisorCostState: "ready",
    },
    approvalMode: "always-ask",
  },
});

describe("native session status", () => {
  it("includes compacted and branched journal spend without counting completed task cost twice", () => {
    expect(projectNeoPiSessionStatus(snapshot(), true)).toMatchObject({
      status: "observed", recordedCost: 15, cacheHitPercent: 80,
      tokensPerSecond: 42, context: { percent: 50 }, approvalMode: "always-ask",
    });
  });

  it("removes counters on disconnect instead of calling an old observation current", () => {
    const old = snapshot();
    expect(projectNeoPiSessionStatus(old, false)).toMatchObject({ status: "stale" });
    expect(projectNeoPiSessionStatus(old, false)).not.toHaveProperty("recordedCost");
    const terminal = { ...snapshot(), sessionId: "second", attachment: "terminal" as const };
    expect(projectNeoPiSessionStatus(terminal, true)).toMatchObject({
      status: "observed", sessionId: "second", attachment: "terminal",
    });
  });

  it("does not treat unsupported telemetry or unknown post-compaction context as zero", () => {
    const { telemetry: _telemetry, ...value } = snapshot();
    expect(projectNeoPiSessionStatus(value, true)).toMatchObject({
      recordedCost: null, cacheHitPercent: null, context: null, tokensPerSecond: null,
    });
    const base = snapshot();
    const unknown = { ...base, telemetry: { ...base.telemetry!, context: { tokens: null, contextWindow: 2000, percent: null } } };
    expect(projectNeoPiSessionStatus(unknown, true)).toMatchObject({ context: null });
  });

  it.each(["restoring", "unavailable"] as const)("does not publish a complete cost during advisor %s", (state) => {
    const base = snapshot();
    const value = { ...base, telemetry: { ...base.telemetry!, sessionUsage: { ...base.telemetry!.sessionUsage!, advisorCostState: state } } };
    expect(projectNeoPiSessionStatus(value, true)).toMatchObject({ recordedCost: null, costState: state });
  });

  it("distinguishes a measured zero cache hit from no prompt observations", () => {
    const base = snapshot();
    const value = { ...base, telemetry: { ...base.telemetry!, sessionUsage: { ...base.telemetry!.sessionUsage!, cacheRead: 0 } } };
    expect(projectNeoPiSessionStatus(value, true)).toMatchObject({ cacheHitPercent: 0 });
    const empty = { ...value, telemetry: { ...value.telemetry, sessionUsage: { ...value.telemetry.sessionUsage, input: 0, cacheWrite: 0 } } };
    expect(projectNeoPiSessionStatus(empty, true)).toMatchObject({ cacheHitPercent: null });
  });
});
