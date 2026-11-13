// @effect-diagnostics nodeBuiltinImport:off -- compare branched session identities with Node path resolution.
import * as NodePath from "node:path";
import { TurnId, type NeoPiResumeCursor } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

class NeoPiRollbackError extends Schema.TaggedError<NeoPiRollbackError>()("NeoPiRollbackError", {
  message: Schema.String,
}) {}
export class NeoPiRollbackIntegrityError extends Schema.TaggedError<NeoPiRollbackIntegrityError>()(
  "NeoPiRollbackIntegrityError",
  { message: Schema.String },
) {}

/** NeoPi branch takes the user entry to REMOVE, not the entry preceding it. */
export async function rollbackNeoPiConversation(input: {
  cursor: NeoPiResumeCursor;
  numTurns: number;
  request: (command: { type: string; entryId?: string }) => Promise<unknown>;
  onBranched?: (cursor: NeoPiResumeCursor) => Promise<void>;
  useMessageEntryIds?: boolean;
}): Promise<NeoPiResumeCursor> {
  const { cursor, numTurns, request, onBranched, useMessageEntryIds = false } = input;
  if (!Number.isSafeInteger(numTurns) || numTurns < 1 || numTurns > cursor.turnBoundaries.length)
    throw new NeoPiRollbackError({
      message: "rollback unavailable for turns before boundary capture",
    });
  const removed = cursor.turnBoundaries.slice(-numTurns);
  if (removed.some((turn) => "kind" in turn && turn.kind === "unknown"))
    throw new NeoPiRollbackError({
      message: "rollback unavailable across a turn with unknown native history",
    });
  const target = removed.find(
    (turn): turn is Extract<typeof turn, { userEntryId: string }> => "userEntryId" in turn,
  );
  if (
    removed
      .slice(0, target ? removed.indexOf(target) : removed.length)
      .some((turn) => "kind" in turn && turn.kind === "continuation")
  )
    throw new NeoPiRollbackError({
      message: "rollback unavailable for a plan continuation without its original native turn",
    });
  if (!target) return { ...cursor, turnBoundaries: cursor.turnBoundaries.slice(0, -numTurns) };
  const { entries, leafId } = object(await request({ type: "get_entries" }));
  if (!Array.isArray(entries) || !(typeof leafId === "string" || leafId === null))
    throw new NeoPiRollbackError({ message: "NeoPi did not return a valid entry ancestry" });
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of entries) {
    const entry = object(value);
    if (typeof entry.id !== "string" || byId.has(entry.id))
      throw new NeoPiRollbackError({ message: "NeoPi returned duplicate or invalid entry IDs" });
    byId.set(entry.id, entry);
  }
  let id = leafId;
  const seen = new Set<string>();
  let selected: Record<string, unknown> | undefined;
  while (id !== null) {
    if (seen.has(id))
      throw new NeoPiRollbackError({ message: "NeoPi entry ancestry contains a cycle" });
    seen.add(id);
    const entry = byId.get(id);
    if (!entry || !(typeof entry.parentId === "string" || entry.parentId === null))
      throw new NeoPiRollbackError({ message: "NeoPi entry ancestry is incomplete" });
    if (id === target.userEntryId) selected = entry;
    id = entry.parentId;
  }
  const native = object(selected?.message);
  const branchable =
    (selected?.type === "message" &&
      (native.role === "user" ||
        (native.role === "custom" &&
          native.attribution === "user" &&
          (native.customType === "skill-prompt" || native.customType === "collab-prompt")))) ||
    (selected?.type === "custom_message" &&
      selected.attribution === "user" &&
      (selected.customType === "skill-prompt" || selected.customType === "collab-prompt"));
  if (!branchable)
    throw new NeoPiRollbackError({
      message: "Rollback boundary is not a user entry on the active ancestry",
    });

  const before = await readMessages(request);
  const grouped = groupNeoPiHistory(before, entries, leafId, cursor, useMessageEntryIds);
  const firstRemoved = grouped.findIndex((turn) => turn.id === target.turnId);
  if (firstRemoved < 0)
    throw new NeoPiRollbackError({
      message: "Rollback boundary is missing from native conversation history",
    });
  const retained = grouped.slice(0, firstRemoved).flatMap((turn) => turn.items);

  const branch = object(await request({ type: "branch", entryId: target.userEntryId }));
  if (branch.cancelled !== false)
    throw new NeoPiRollbackError({ message: "NeoPi cancelled conversation rollback" });
  let next: NeoPiResumeCursor;
  try {
    const state = object(await request({ type: "get_state" }));
    if (
      typeof state.sessionFile !== "string" ||
      !state.sessionFile ||
      typeof state.sessionId !== "string" ||
      !state.sessionId ||
      NodePath.resolve(state.sessionFile) === NodePath.resolve(cursor.sessionFile) ||
      state.sessionId === cursor.sessionId
    )
      throw new NeoPiRollbackError({
        message: "NeoPi did not report the branched session identity",
      });
    const { historyLeafId: _, ...previous } = cursor;
    next = {
      ...previous,
      sessionFile: NodePath.resolve(state.sessionFile),
      sessionId: state.sessionId,
      turnBoundaries: cursor.turnBoundaries.slice(0, -numTurns),
    };
  } catch (cause) {
    throw new NeoPiRollbackIntegrityError({
      message: `NeoPi rollback integrity error: cannot verify branched conversation: ${String(cause)}`,
    });
  }
  await onBranched?.(next);
  const after = await readMessages(request);
  const persisted = useMessageEntryIds
    ? after.filter((message) => Object.hasOwn(object(message), "entryId"))
    : after;
  if (JSON.stringify(persisted) !== JSON.stringify(retained))
    throw new NeoPiRollbackIntegrityError({
      message:
        "NeoPi rollback integrity error: branched conversation still contains removed or unexpected messages",
    });
  const branchEntries = object(await request({ type: "get_entries" }));
  const branchLeaf = branchEntries.leafId;
  if (branchLeaf !== null && !(typeof branchLeaf === "string" && branchLeaf.length > 0))
    throw new NeoPiRollbackError({ message: "NeoPi did not return a valid branched history head" });
  return { ...next, historyLeafId: branchLeaf };
}

async function readMessages(
  request: (command: { type: string; cursor?: string }) => Promise<unknown>,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = object(
      await request({ type: "get_messages_page", ...(cursor ? { cursor } : {}) }),
    );
    if (!Array.isArray(page.messages))
      throw new NeoPiRollbackError({ message: "NeoPi did not return a valid conversation page" });
    messages.push(...page.messages);
    cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
    if (cursor && seen.has(cursor))
      throw new NeoPiRollbackError({ message: "NeoPi conversation pagination contains a cycle" });
    if (cursor) seen.add(cursor);
  } while (cursor);
  return messages;
}

/** Align native history with captured prompt boundaries, not every user message (steers/extensions). */
export function groupNeoPiHistory(
  messages: ReadonlyArray<unknown>,
  entriesValue: unknown,
  leafValue: unknown,
  cursor: NeoPiResumeCursor,
  useMessageEntryIds = false,
): Array<{ id: TurnId; items: unknown[] }> {
  if (!Array.isArray(entriesValue) || !(typeof leafValue === "string" || leafValue === null))
    throw new NeoPiRollbackError({ message: "NeoPi did not return a valid transcript ancestry" });
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of entriesValue) {
    const entry = object(value);
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const ancestry: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let id = leafValue;
  while (id !== null) {
    if (seen.has(id))
      throw new NeoPiRollbackError({ message: "NeoPi transcript ancestry contains a cycle" });
    seen.add(id);
    const entry = byId.get(id);
    if (!entry || !(typeof entry.parentId === "string" || entry.parentId === null))
      throw new NeoPiRollbackError({ message: "NeoPi transcript ancestry is incomplete" });
    ancestry.push(entry);
    id = entry.parentId;
  }
  ancestry.reverse();
  const boundaries = new Map(
    cursor.turnBoundaries.flatMap((boundary) =>
      "userEntryId" in boundary ? [[boundary.userEntryId, boundary.turnId] as const] : [],
    ),
  );
  for (const boundary of cursor.turnBoundaries) {
    if (!("kind" in boundary) || boundary.kind !== "continuation") continue;
    const preceding = ancestry.findIndex((entry) => entry.id === boundary.afterEntryId);
    if (preceding < 0)
      throw new NeoPiRollbackError({
        message: "NeoPi plan continuation boundary left the active ancestry",
      });
    const next = ancestry[preceding + 1];
    if (next && typeof next.id === "string") boundaries.set(next.id, boundary.turnId);
  }
  if (useMessageEntryIds) {
    const byEntry = new Map<string, unknown[]>();
    for (const message of messages) {
      const entryId = object(message).entryId;
      if (entryId === undefined && !Object.hasOwn(object(message), "entryId")) continue;
      if (typeof entryId !== "string" || !seen.has(entryId))
        throw new NeoPiRollbackError({
          message: "NeoPi transcript contains an unmatched native entry id",
        });
      const items = byEntry.get(entryId);
      if (items) items.push(message);
      else byEntry.set(entryId, [message]);
    }
    const turns: Array<{ id: TurnId; items: unknown[] }> = [];
    for (const entry of ancestry) {
      const turnId = boundaries.get(String(entry.id));
      if (turnId) turns.push({ id: turnId, items: [] });
      const items = byEntry.get(String(entry.id));
      if (!items) continue;
      if (turns.length === 0) turns.push({ id: TurnId.make("neopi-history-1"), items: [] });
      turns[turns.length - 1]!.items.push(...items);
    }
    return turns;
  }
  const turns: Array<{ id: TurnId; items: unknown[] }> = [];
  let messageIndex = 0;
  for (const entry of ancestry) {
    const turnId = boundaries.get(String(entry.id));
    if (turnId) turns.push({ id: turnId, items: [] });
    if (messageIndex >= messages.length) continue;
    const message = object(messages[messageIndex]);
    const native = object(entry.message);
    const direct =
      entry.type === "message" &&
      native.role === message.role &&
      JSON.stringify(native.content) === JSON.stringify(message.content);
    const converted =
      (entry.type === "custom_message" && message.role === "custom") ||
      (entry.type === "branch_summary" && message.role === "branchSummary") ||
      (entry.type === "compaction" && message.role === "compactionSummary");
    if (!direct && !converted) continue;
    if (turns.length === 0) turns.push({ id: TurnId.make("neopi-history-1"), items: [] });
    turns[turns.length - 1]!.items.push(messages[messageIndex++]);
  }
  if (messageIndex !== messages.length)
    throw new NeoPiRollbackError({
      message: "NeoPi transcript contains unmatched native messages",
    });
  return turns;
}
