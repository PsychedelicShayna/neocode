import { describe, expect, it } from "vite-plus/test";

import { nativeRoleCycleNotice, nativeThinkingCycleNotice } from "./nativeSessionShortcuts";

describe("native session shortcuts", () => {
  it("names the level NeoPi cycled to, and says when there is nothing to cycle", () => {
    expect(nativeThinkingCycleNotice({ level: "xhigh" })).toBe("Reasoning: Extra High");
    expect(nativeThinkingCycleNotice({ level: "auto" })).toBe("Reasoning: auto");
    expect(nativeThinkingCycleNotice(null)).toBe("This model has no reasoning levels to cycle.");
  });

  it("reports the role, model and level NeoPi cycled to", () => {
    expect(
      nativeRoleCycleNotice({
        role: "slow",
        model: { id: "gpt-6", name: "GPT-6" },
        thinkingLevel: "high",
      }),
    ).toBe("Role: slow · GPT-6 · High");
    expect(nativeRoleCycleNotice({ role: "smol", model: { id: "m-1" } })).toBe("Role: smol · m-1");
    expect(nativeRoleCycleNotice(null)).toBe("Only one role model is available.");
  });
});
