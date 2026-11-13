import { describe, expect, it } from "vite-plus/test";

import { approvalRequestType, parseApprovalPrompt } from "./approvalPrompt.ts";

describe("NeoPi legacy approval prompt", () => {
  it("retains the reason and all detail lines", () => {
    expect(
      parseApprovalPrompt(
        "Allow tool: bash\nReason: destructive command\nCommand: rm -rf build\nCwd: /repo",
        ["Approve", "Deny"],
      ),
    ).toEqual({
      toolName: "bash",
      requestType: "command",
      detail: "Allow tool: bash\nReason: destructive command\nCommand: rm -rf build\nCwd: /repo",
    });
  });

  it("requires the exact first line and exact pair of ordered options", () => {
    expect(parseApprovalPrompt("Should we run bash?", ["Approve", "Deny"])).toBeUndefined();
    expect(parseApprovalPrompt("Allow tool: bash", ["Deny", "Approve"])).toBeUndefined();
    expect(parseApprovalPrompt("Allow tool:   ", ["Approve", "Deny"])).toBeUndefined();
    expect(parseApprovalPrompt("Prefix Allow tool: bash", ["Approve", "Deny"])).toBeUndefined();
  });

  it.each([
    ["bash", "command"],
    ["edit", "file-change"],
    ["write", "file-change"],
    ["delete", "file-change"],
    ["move", "file-change"],
    ["read", "file-read"],
    ["mcp__server__tool", "mcp-elicitation"],
    ["shell", "permission"],
  ] as const)("maps %s to %s", (tool, kind) => {
    expect(approvalRequestType(tool)).toBe(kind);
  });
});
