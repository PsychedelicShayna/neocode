import { describe, expect, it } from "vite-plus/test";
import { agentStatusLabel } from "./AgentRoster";

describe("agent status label", () => {
  it("never shows a child that finished unseen as interrupted, failed or completed", () => {
    const unseen = agentStatusLabel({ status: "interrupted", unobservedSince: 1_000 });
    for (const status of ["interrupted", "failed", "completed"] as const)
      expect(unseen).not.toBe(agentStatusLabel({ status, unobservedSince: null }));
  });
});
