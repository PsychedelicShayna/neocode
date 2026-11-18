import { describe, expect, it } from "vite-plus/test";
import { agentRowSummary, agentStatusLabel } from "./AgentRoster";

const known = { unobservedSince: null, outcomeUnrecorded: false };

describe("agent status label", () => {
  it("never shows a finish of unknown outcome as interrupted, failed or completed", () => {
    const unseen = agentStatusLabel({ ...known, status: "interrupted", unobservedSince: 1_000 });
    const unrecorded = agentStatusLabel({
      ...known,
      status: "interrupted",
      outcomeUnrecorded: true,
    });
    for (const status of ["interrupted", "failed", "completed"] as const) {
      expect(unseen).not.toBe(agentStatusLabel({ ...known, status }));
      expect(unrecorded).not.toBe(agentStatusLabel({ ...known, status }));
    }
    expect(unrecorded).not.toBe(unseen);
  });
});

describe("agent row summary", () => {
  const busy = { activity: "Reading the log", task: "Find the bug" };

  it("shows a finish of unknown outcome over the agent's last activity and task", () => {
    const unseen = { ...known, ...busy, status: "interrupted" as const, unobservedSince: 1_000 };
    const unrecorded = {
      ...known,
      ...busy,
      status: "interrupted" as const,
      outcomeUnrecorded: true,
    };
    expect(agentRowSummary(unseen)).toBe(agentStatusLabel(unseen));
    expect(agentRowSummary(unrecorded)).toBe(agentStatusLabel(unrecorded));
  });

  it("keeps showing what any other agent is doing", () => {
    expect(agentRowSummary({ ...known, ...busy, status: "completed" })).toBe("Reading the log");
    expect(agentRowSummary({ ...known, ...busy, activity: null, status: "running" })).toBe(
      "Find the bug",
    );
  });
});
