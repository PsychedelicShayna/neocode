import type { NeoPiJournalEntry } from "@t3tools/contracts";
import { journalRecord } from "./neopiJournal.ts";

/**
 * The native session tree as the TUI draws it: real forks get `├─`/`└─`
 * connectors and `│` gutters, a linear chain stays in its branch head's column,
 * and the active path is marked. Everything here is pure so a long session
 * projects once per snapshot and filtering never walks the structure again.
 */

export const SESSION_TREE_FILTERS = [
  "default",
  "no-tools",
  "user-only",
  "labeled-only",
  "all",
] as const;
export type SessionTreeFilter = (typeof SESSION_TREE_FILTERS)[number];

export interface SessionTreeItem {
  readonly entry: NeoPiJournalEntry;
  /** NeoPi's resolved bookmark for this entry. */
  readonly label: string | undefined;
}

export interface SessionTreeSnapshot {
  readonly items: readonly SessionTreeItem[];
  readonly leafId: string | null;
}

const isEntry = (value: Record<string, unknown>): value is NeoPiJournalEntry =>
  typeof value.id === "string" &&
  typeof value.type === "string" &&
  typeof value.timestamp === "string" &&
  (typeof value.parentId === "string" || value.parentId === null);

/**
 * Flattens NeoPi's nested `get_tree` response in sibling order. A session is a
 * deep chain, so this walks iteratively. Malformed nodes are skipped, never repaired.
 */
export function decodeSessionTree(value: unknown): SessionTreeSnapshot {
  const response = journalRecord(value);
  const items: SessionTreeItem[] = [];
  const pending = Array.isArray(response.tree) ? [...response.tree].reverse() : [];
  while (pending.length > 0) {
    const node = journalRecord(pending.pop());
    const entry = journalRecord(node.entry);
    if (isEntry(entry))
      items.push({
        entry,
        label: typeof node.label === "string" && node.label.length > 0 ? node.label : undefined,
      });
    if (Array.isArray(node.children))
      for (let index = node.children.length - 1; index >= 0; index--)
        pending.push(node.children[index]);
  }
  return { items, leafId: typeof response.leafId === "string" ? response.leafId : null };
}

/** Ancestor fork whose `│` keeps running beside every row below it. */
export interface SessionTreeGutter {
  /** Zero-based cell level of the fork's own connector. */
  readonly level: number;
  readonly isLast: boolean;
  readonly parent: SessionTreeGutter | null;
}

export interface SessionTreeRow {
  readonly id: string;
  readonly item: SessionTreeItem;
  readonly depth: number;
  readonly connector: "branch" | "last" | null;
  readonly gutters: SessionTreeGutter | null;
  readonly onActivePath: boolean;
  readonly isLeaf: boolean;
  readonly childCount: number;
  readonly collapsed: boolean;
  /** Descendants currently folded away by `collapsed`. */
  readonly hiddenCount: number;
}

export interface SessionTreeToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface SessionTreeProjection {
  readonly rows: readonly SessionTreeRow[];
  /** Tool calls by id, so a result row can say what was run. */
  readonly toolCalls: ReadonlyMap<string, SessionTreeToolCall>;
}

/** Find the nearest listed ancestor, even when a hidden parent chain is cyclic. */
export function sessionTreeVisibleParent(
  item: SessionTreeItem,
  itemById: ReadonlyMap<string, SessionTreeItem>,
  visibleIds: ReadonlyMap<string, unknown>,
): string | null {
  let parentId = item.entry.parentId;
  // A finite parent chain cannot visit more records than the snapshot contains.
  // Bound the walk without allocating another ancestry set for each key press.
  for (let remaining = itemById.size; parentId !== null && remaining > 0; remaining--) {
    if (parentId === item.entry.id) return null;
    if (visibleIds.has(parentId)) return parentId;
    parentId = itemById.get(parentId)?.entry.parentId ?? null;
  }
  return null;
}

interface PendingRow {
  readonly item: SessionTreeItem;
  readonly depth: number;
  readonly siblingIndex: number;
  readonly siblingCount: number;
  readonly hasParent: boolean;
  readonly gutters: SessionTreeGutter | null;
}

function indexToolCalls(items: readonly SessionTreeItem[]) {
  const toolCalls = new Map<string, SessionTreeToolCall>();
  for (const { entry } of items) {
    if (entry.type !== "message") continue;
    const message = journalRecord(entry.message);
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const block = journalRecord(value);
      if (
        block.type === "toolCall" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      )
        toolCalls.set(block.id, { name: block.name, args: journalRecord(block.arguments) });
    }
  }
  return toolCalls;
}

/**
 * Lays the parent-linked items out depth-first. The branch holding the current
 * leaf is always first among its siblings. An entry whose parent is unknown
 * becomes a root, and entries caught in a parent cycle are appended as roots, so
 * every record stays visible.
 */
export function projectSessionTree(
  items: readonly SessionTreeItem[],
  leafId: string | null,
  collapsed: ReadonlySet<string> = new Set(),
): SessionTreeProjection {
  const byId = new Map<string, SessionTreeItem>();
  for (const item of items) if (!byId.has(item.entry.id)) byId.set(item.entry.id, item);
  const children = new Map<string, SessionTreeItem[]>();
  const roots: SessionTreeItem[] = [];
  for (const item of byId.values()) {
    const parentId = item.entry.parentId;
    if (parentId !== null && parentId !== item.entry.id && byId.has(parentId)) {
      const siblings = children.get(parentId);
      if (siblings) siblings.push(item);
      else children.set(parentId, [item]);
    } else roots.push(item);
  }

  const activePath = new Set<string>();
  for (
    let current = leafId === null ? undefined : byId.get(leafId);
    current && !activePath.has(current.entry.id);
    current = current.entry.parentId === null ? undefined : byId.get(current.entry.parentId)
  )
    activePath.add(current.entry.id);

  const activeFirst = (siblings: readonly SessionTreeItem[]) => {
    const index = siblings.findIndex((sibling) => activePath.has(sibling.entry.id));
    if (index <= 0) return siblings;
    return [siblings[index]!, ...siblings.slice(0, index), ...siblings.slice(index + 1)];
  };
  /** Hides a collapsed branch from the walk, so it is not mistaken for a cycle. */
  const foldDescendants = (id: string) => {
    let count = 0;
    const pending = [...(children.get(id) ?? [])];
    while (pending.length > 0) {
      const descendant = pending.pop()!;
      count++;
      visited.add(descendant.entry.id);
      pending.push(...(children.get(descendant.entry.id) ?? []));
    }
    return count;
  };

  const rows: SessionTreeRow[] = [];
  const visited = new Set<string>();
  const multipleRoots = roots.length > 1;
  const stack: PendingRow[] = [];
  const pushSiblings = (
    siblings: readonly SessionTreeItem[],
    depth: number,
    hasParent: boolean,
    gutters: SessionTreeGutter | null,
  ) => {
    for (let index = siblings.length - 1; index >= 0; index--)
      stack.push({
        item: siblings[index]!,
        depth,
        siblingIndex: index,
        siblingCount: siblings.length,
        hasParent,
        gutters,
      });
  };
  const walk = () => {
    while (stack.length > 0) {
      const next = stack.pop()!;
      const id = next.item.entry.id;
      if (visited.has(id)) continue;
      visited.add(id);
      const isLast = next.siblingIndex === next.siblingCount - 1;
      const descendants = children.get(id) ?? [];
      const isCollapsed = collapsed.has(id) && descendants.length > 0;
      rows.push({
        id,
        item: next.item,
        depth: next.depth,
        connector: next.hasParent && next.siblingCount > 1 ? (isLast ? "last" : "branch") : null,
        gutters: next.gutters,
        onActivePath: activePath.has(id),
        isLeaf: id === leafId,
        childCount: descendants.length,
        collapsed: isCollapsed,
        hiddenCount: isCollapsed ? foldDescendants(id) : 0,
      });
      if (descendants.length === 0 || isCollapsed) continue;
      const isRoot = !next.hasParent;
      pushSiblings(
        activeFirst(descendants),
        descendants.length > 1 || (multipleRoots && isRoot) ? next.depth + 1 : next.depth,
        true,
        // Real forks keep a gutter running beside everything below them. The virtual
        // root joining several session roots draws none.
        next.siblingCount > 1 && !(multipleRoots && isRoot)
          ? { level: next.depth - 1, isLast, parent: next.gutters }
          : next.gutters,
      );
    }
  };
  pushSiblings(activeFirst(roots), 0, false, null);
  walk();
  for (const item of byId.values()) {
    if (visited.has(item.entry.id)) continue;
    pushSiblings([item], 0, false, null);
    walk();
  }
  return { rows, toolCalls: indexToolCalls(items) };
}

/** Cells one tree level occupies: `├─ `, `└─ `, `│  ` or blank. */
export const SESSION_TREE_LEVEL_CELLS = 3;

/**
 * The gutter text for one row. `scrollOffset` drops that many outer levels
 * behind a leading `…`; the caller derives one offset for the whole visible
 * window, because per-row offsets would stop the columns describing one shape.
 */
export function sessionTreePrefix(row: SessionTreeRow, scrollOffset: number): string {
  const offset = Math.min(scrollOffset, row.depth);
  const levels = row.depth - offset;
  if (levels === 0) return "";
  const gutterAt: (SessionTreeGutter | undefined)[] = [];
  for (let gutter = row.gutters; gutter; gutter = gutter.parent) {
    const level = gutter.level - offset;
    if (level >= 0 && level < levels && gutterAt[level] === undefined) gutterAt[level] = gutter;
  }
  let prefix = "";
  for (let level = 0; level < levels; level++) {
    const gutter = gutterAt[level];
    if (gutter) prefix += gutter.isLast ? "   " : "│  ";
    else if (row.connector && level === levels - 1)
      prefix += row.connector === "last" ? "└─ " : "├─ ";
    else prefix += "   ";
  }
  // The ellipsis marks folded outer levels, but never replaces a connector.
  return offset > 0 && prefix[0] !== "├" && prefix[0] !== "└" ? `…${prefix.slice(1)}` : prefix;
}

/** Outer levels to fold away so a window's deepest row still fits `maxLevels`. */
export function sessionTreeScrollOffset(deepest: number, maxLevels: number): number {
  return Math.max(0, deepest - Math.max(1, maxLevels));
}

export type SessionTreeKind = "user" | "assistant" | "tool" | "summary" | "custom" | "system";

export interface SessionTreeDescription {
  readonly kind: SessionTreeKind;
  readonly label: string;
  /** One line, no newlines. */
  readonly text: string;
  readonly error: boolean;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function textOf(content: unknown, limit = 2000): string {
  if (typeof content === "string") return content.slice(0, limit);
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const value of content) {
    const block = journalRecord(value);
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
      if (text.length >= limit) return text.slice(0, limit);
    }
  }
  return text;
}

function formatToolCall({ name, args }: SessionTreeToolCall): string {
  const path = String(args.path ?? args.file_path ?? "");
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return `${name} ${path}`;
    case "bash": {
      const command = oneLine(String(args.command ?? ""));
      return `bash ${command.length > 60 ? `${command.slice(0, 60)}…` : command}`;
    }
    case "grep":
      return `grep /${String(args.pattern ?? "")}/ ${path}`.trim();
    case "glob":
    case "ls":
      return `${name} ${path || String(args.paths ?? ".")}`;
    default: {
      const json = JSON.stringify(args);
      return `${name} ${json.length > 48 ? `${json.slice(0, 48)}…` : json}`;
    }
  }
}

const assistantErrorText = (message: Record<string, unknown>) =>
  typeof message.errorMessage === "string" && message.errorMessage.length > 0
    ? oneLine(message.errorMessage)
    : null;

/** Kind, short label and one-line snippet of an entry, mirroring the TUI's row text. */
export function describeSessionTreeEntry(
  entry: NeoPiJournalEntry,
  toolCalls: ReadonlyMap<string, SessionTreeToolCall>,
): SessionTreeDescription {
  if (entry.type === "message") {
    const message = journalRecord(entry.message);
    const role = typeof message.role === "string" ? message.role : "message";
    const row = (kind: SessionTreeKind, text: string, error = false, label = role) => ({
      kind,
      label,
      text: oneLine(text),
      error,
    });
    switch (role) {
      case "user":
        return row("user", textOf(message.content));
      case "developer":
        return row("system", textOf(message.content));
      case "assistant": {
        const text = textOf(message.content);
        const failure = assistantErrorText(message);
        const failed = message.stopReason === "error" || failure !== null;
        if (text) return row("assistant", text, failed);
        if (failed) return row("assistant", failure ?? "Request failed", true);
        if (message.stopReason === "aborted") return row("assistant", "(aborted)");
        const calls = Array.isArray(message.content)
          ? message.content.flatMap((value) => {
              const block = journalRecord(value);
              return block.type === "toolCall" && typeof block.name === "string"
                ? [block.name]
                : [];
            })
          : [];
        return row("assistant", calls.length > 0 ? calls.join(", ") : "(no content)");
      }
      case "toolResult": {
        const call =
          typeof message.toolCallId === "string" ? toolCalls.get(message.toolCallId) : undefined;
        const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
        return row(
          "tool",
          call ? formatToolCall(call) : toolName,
          message.isError === true,
          toolName,
        );
      }
      case "bashExecution":
        return row("tool", String(message.command ?? ""), false, "bash");
      case "evalExecution":
      case "pythonExecution":
        return row("tool", String(message.code ?? ""), false, "eval");
      default:
        return row("system", textOf(message.content));
    }
  }
  const custom = typeof entry.customType === "string" ? entry.customType : "custom";
  switch (entry.type) {
    case "custom_message":
      return { kind: "custom", label: custom, text: oneLine(textOf(entry.content)), error: false };
    case "custom":
      return { kind: "system", label: custom, text: "", error: false };
    case "compaction": {
      const tokens = typeof entry.tokensBefore === "number" ? entry.tokensBefore : null;
      return {
        kind: "summary",
        label: "compaction",
        text: tokens === null ? "" : `${Math.round(tokens / 1000)}k tokens`,
        error: false,
      };
    }
    case "branch_summary":
      return {
        kind: "summary",
        label: "branch summary",
        text: oneLine(typeof entry.summary === "string" ? entry.summary : ""),
        error: false,
      };
    case "model_change":
      return { kind: "system", label: "model", text: String(entry.model ?? ""), error: false };
    case "thinking_level_change":
      return {
        kind: "system",
        label: "thinking",
        text: String(entry.thinkingLevel ?? "off"),
        error: false,
      };
    case "label":
      return {
        kind: "system",
        label: "label",
        text: typeof entry.label === "string" ? entry.label : "(cleared)",
        error: false,
      };
    case "title_change":
      return {
        kind: "system",
        label: "title",
        text: oneLine(String(entry.title ?? "")),
        error: false,
      };
    case "mode_change":
      return { kind: "system", label: "mode", text: String(entry.mode ?? ""), error: false };
    default:
      return { kind: "system", label: entry.type.replaceAll("_", " "), text: "", error: false };
  }
}

const SETTINGS_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "label",
  "custom",
  "model_change",
  "model_usage",
  "thinking_level_change",
  "service_tier_change",
  "title_change",
  "credential_pin",
  "session_init",
  "ttsr_injection",
  "mode_change",
  "reset_boundary",
]);

function hasText(content: unknown): boolean {
  return textOf(content, 200).trim().length > 0;
}

/** Assistant turns that only called tools carry no text of their own; the TUI folds them away. */
function isBareToolTurn(row: SessionTreeRow): boolean {
  const { entry } = row.item;
  if (row.isLeaf || entry.type !== "message") return false;
  const message = journalRecord(entry.message);
  if (message.role !== "assistant" || hasText(message.content)) return false;
  const stop = message.stopReason;
  return stop === undefined || stop === null || stop === "stop" || stop === "toolUse";
}

const searchTexts = new WeakMap<SessionTreeItem, string>();

function searchText(row: SessionTreeRow, toolCalls: SessionTreeProjection["toolCalls"]): string {
  const cached = searchTexts.get(row.item);
  if (cached !== undefined) return cached;
  const described = describeSessionTreeEntry(row.item.entry, toolCalls);
  const text = `${row.item.label ?? ""} ${described.label} ${described.text}`.toLowerCase();
  searchTexts.set(row.item, text);
  return text;
}

/** The rows a filter mode and search query leave visible; structure and gutters are unchanged. */
export function filterSessionTree(
  projection: SessionTreeProjection,
  filter: SessionTreeFilter,
  query: string,
): readonly SessionTreeRow[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return projection.rows.filter((row) => {
    const { entry } = row.item;
    if (isBareToolTurn(row)) return false;
    const isSettings = SETTINGS_ENTRY_TYPES.has(entry.type);
    const isToolResult =
      entry.type === "message" && journalRecord(entry.message).role === "toolResult";
    switch (filter) {
      case "user-only":
        if (!(entry.type === "message" && journalRecord(entry.message).role === "user"))
          return false;
        break;
      case "no-tools":
        if (isSettings || isToolResult) return false;
        break;
      case "labeled-only":
        if (row.item.label === undefined) return false;
        break;
      case "all":
        break;
      case "default":
        if (isSettings) return false;
        break;
    }
    if (tokens.length === 0) return true;
    const text = searchText(row, projection.toolCalls);
    return tokens.every((token) => text.includes(token));
  });
}
