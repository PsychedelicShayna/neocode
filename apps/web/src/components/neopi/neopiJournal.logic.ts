import type { NeoPiJournalEntry, NeoPiSessionJournalResult } from "@t3tools/contracts";

type Available = Extract<NeoPiSessionJournalResult, { status: "available" }>;
export interface NeoPiJournalSnapshot {
  readonly providerInstanceId: Available["providerInstanceId"];
  readonly page: Available["page"];
  readonly entries: ReadonlyArray<NeoPiJournalEntry>;
}
export const journalRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/** A page series is one pinned native snapshot, never a blend of leaves or identities. */
export function extendNeoPiJournalSnapshot(
  previous: NeoPiJournalSnapshot | null,
  result: Available,
): NeoPiJournalSnapshot {
  if (previous && (
    previous.providerInstanceId !== result.providerInstanceId ||
    previous.page.sessionId !== result.page.sessionId ||
    previous.page.sessionFile !== result.page.sessionFile ||
    previous.page.leafId !== result.page.leafId ||
    previous.page.totalEntries !== result.page.totalEntries ||
    previous.page.nextCursor === result.page.nextCursor
  )) throw new Error("The native journal snapshot changed. Refresh before reading more.");
  const ids = new Set(previous?.entries.map((entry) => entry.id));
  for (const entry of result.page.entries) {
    if (ids.has(entry.id)) throw new Error("NeoPi returned overlapping journal pages. Refresh this snapshot.");
    ids.add(entry.id);
  }
  return {
    providerInstanceId: result.providerInstanceId,
    page: result.page,
    entries: [...result.page.entries, ...(previous?.entries ?? [])],
  };
}

export function journalEntryLabel(entry: NeoPiJournalEntry): string {
  const message = journalRecord(entry.message);
  if (entry.type === "message") {
    const role = typeof message.role === "string" ? message.role : "message";
    return role === "toolResult" ? `Tool result · ${String(message.toolName ?? "unknown")}` : role;
  }
  if (entry.type === "custom_message" || entry.type === "custom")
    return `${entry.type} · ${String(entry.customType ?? "unknown")}`;
  return entry.type.replaceAll("_", " ");
}

export function journalEntryCategory(entry: NeoPiJournalEntry): "message" | "tool" | "system" {
  if (entry.type !== "message" && entry.type !== "custom_message") return "system";
  const message = journalRecord(entry.message);
  if (message.role === "toolResult" || message.role === "bashExecution" ||
    message.role === "evalExecution" || message.role === "pythonExecution") return "tool";
  if (message.role === "assistant" && Array.isArray(message.content) &&
    message.content.length > 0 && message.content.every((block) =>
      journalRecord(block).type === "toolCall" || journalRecord(block).type === "anthropicServerTool"))
    return "tool";
  return "message";
}

/** Build only an inspection outline. Native parent pointers define it, not model context. */
export function journalTreeRows(entries: ReadonlyArray<NeoPiJournalEntry>) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const children = new Map<string | null, NeoPiJournalEntry[]>();
  for (const entry of entries) {
    const parent = entry.parentId !== null && byId.has(entry.parentId) ? entry.parentId : null;
    const siblings = children.get(parent);
    if (siblings) siblings.push(entry);
    else children.set(parent, [entry]);
  }
  const rows: { entry: NeoPiJournalEntry; depth: number; missingParent: boolean; childCount: number }[] = [];
  const pending = (children.get(null) ?? []).toReversed().map((entry) => ({ entry, depth: 0 }));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (visited.has(next.entry.id)) continue;
    visited.add(next.entry.id);
    const descendants = children.get(next.entry.id) ?? [];
    rows.push({ ...next, missingParent: next.entry.parentId !== null && !byId.has(next.entry.parentId), childCount: descendants.length });
    for (let index = descendants.length - 1; index >= 0; index--)
      pending.push({ entry: descendants[index]!, depth: next.depth + 1 });
  }
  // Even malformed or future cyclic records remain inspectable rather than disappearing.
  for (const entry of entries)
    if (!visited.has(entry.id)) rows.push({ entry, depth: 0, missingParent: false, childCount: children.get(entry.id)?.length ?? 0 });
  return rows;
}
