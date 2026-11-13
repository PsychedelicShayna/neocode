import type { ProviderRequestKind } from "@t3tools/contracts";

export interface ApprovalPrompt {
  readonly toolName: string;
  readonly detail: string;
  readonly requestType: ProviderRequestKind;
}

export function approvalRequestType(toolName: string): ProviderRequestKind {
  if (toolName === "bash") return "command";
  if (toolName === "edit" || toolName === "write" || toolName === "delete" || toolName === "move")
    return "file-change";
  if (toolName === "read") return "file-read";
  if (toolName.startsWith("mcp__")) return "mcp-elicitation";
  return "permission";
}

/** The legacy RPC UI sends approvals as a select, not as a typed permission request. */
export function parseApprovalPrompt(
  title: string,
  options: readonly string[],
): ApprovalPrompt | undefined {
  if (options.length !== 2 || options[0] !== "Approve" || options[1] !== "Deny") return;
  const firstLine = title.split("\n", 1)[0] ?? "";
  const match = /^Allow tool: (.+)$/.exec(firstLine);
  const toolName = match?.[1]?.trim();
  if (!toolName) return;
  return { toolName, detail: title, requestType: approvalRequestType(toolName) };
}
