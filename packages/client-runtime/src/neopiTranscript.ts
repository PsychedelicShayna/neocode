import type { NeoPiJournalEntry } from "@t3tools/contracts";
import { journalRecord } from "./neopiJournal.ts";

// Keep canonical records on projected rows so debug views stay lossless.

export interface TranscriptImage {
  readonly src: string;
  readonly mimeType: string;
}

export interface TranscriptFile {
  readonly path: string;
  readonly content: string | null;
  readonly skippedReason: string | null;
  readonly record: Record<string, unknown>;
}

interface RowBase {
  readonly id: string;
  readonly entry: NeoPiJournalEntry;
  readonly timestamp: string;
  /** A live (not yet persisted) message from the current turn. */
  readonly live: boolean;
}

export interface UserRow extends RowBase {
  readonly kind: "user";
  readonly text: string;
  readonly images: ReadonlyArray<TranscriptImage>;
  readonly files: ReadonlyArray<TranscriptFile>;
  readonly steering: boolean;
}

export interface AssistantRow extends RowBase {
  readonly kind: "assistant";
  readonly text: string;
  readonly images: ReadonlyArray<TranscriptImage>;
  /** Last prose row of a finished assistant message: meta is shown below it. */
  readonly meta: AssistantMeta | null;
}

export interface AssistantMeta {
  readonly model: string | null;
  readonly provider: string | null;
  readonly durationMs: number | null;
  readonly outputTokens: number | null;
  readonly stopReason: string | null;
  readonly errorMessage: string | null;
}

export interface ThinkingRow extends RowBase {
  readonly kind: "thinking";
  readonly text: string;
  readonly summary: boolean;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly intent: string | null;
  readonly arguments: Record<string, unknown>;
}

export interface ToolResult {
  readonly entry: NeoPiJournalEntry;
  readonly text: string;
  readonly images: ReadonlyArray<TranscriptImage>;
  readonly isError: boolean;
  readonly details: unknown;
}

export interface ToolRow extends RowBase {
  readonly kind: "tool";
  readonly call: ToolCall;
  readonly result: ToolResult | null;
  /** Human sentence for the row: the agent's stated intent, else a synthesized label. */
  readonly label: string;
  /** The one argument worth showing beside the label: a command, a path, a query. */
  readonly detail: string | null;
}

export interface NoteRow extends RowBase {
  readonly kind: "note";
  readonly label: string;
  readonly text: string;
  readonly tone: "system" | "notice" | "error";
}

export interface DividerRow extends RowBase {
  readonly kind: "divider";
  readonly text: string;
  /** What a compaction kept, for the row to expand to. */
  readonly summary?: string;
}

export interface RecordRow extends RowBase {
  readonly kind: "record";
  readonly label: string;
}

export interface CommandRow {
  readonly kind: "command";
  readonly id: string;
  readonly text: string;
}

export type TranscriptRow =
  | UserRow
  | AssistantRow
  | ThinkingRow
  | ToolRow
  | NoteRow
  | DividerRow
  | RecordRow
  | CommandRow;

export interface TranscriptSource {
  readonly entries: ReadonlyArray<NeoPiJournalEntry>;
  readonly pending: ReadonlyArray<{
    readonly messageId: string;
    readonly message: Readonly<Record<string, unknown>>;
  }>;
  readonly leafId: string | null;
}

export interface TranscriptOptions {
  /** Show bookkeeping entries (model changes, usage, digests) as records. */
  readonly debug: boolean;
  /** Local command outputs keyed by the entry id they follow (`null` = before everything). */
  readonly commandOutputs?: ReadonlyMap<string | null, ReadonlyArray<CommandRow>>;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((value) => journalRecord(value))
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

function blockImages(content: unknown): TranscriptImage[] {
  const source = Array.isArray(content) ? content : [];
  return source.flatMap((value) => {
    const block = journalRecord(value);
    if (
      block.type !== "image" ||
      typeof block.data !== "string" ||
      block.data.length === 0 ||
      typeof block.mimeType !== "string" ||
      !/^image\/(png|jpeg|gif|webp|avif)$/.test(block.mimeType)
    )
      return [];
    return [{ src: `data:${block.mimeType};base64,${block.data}`, mimeType: block.mimeType }];
  });
}

function messageFiles(value: unknown): TranscriptFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const file = journalRecord(item);
    if (typeof file.path !== "string") return [];
    return [
      {
        path: file.path,
        content: typeof file.content === "string" ? file.content : null,
        skippedReason: typeof file.skippedReason === "string" ? file.skippedReason : null,
        record: file,
      },
    ];
  });
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((part) => part.trim().length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Strip wrapper tags NeoPi uses for injected notices so a preview reads as prose. */
function stripNoticeTags(text: string): string {
  return text
    .replace(/<\/?(system-notice|system-reminder|context-window-rollover|task-result[^>]*)>/g, "")
    .trim();
}

const TOOL_DETAIL_KEYS: Record<string, ReadonlyArray<string>> = {
  bash: ["command"],
  read: ["path"],
  write: ["path"],
  edit: ["input"],
  glob: ["path"],
  grep: ["pattern"],
  find: ["query"],
  web_search: ["query"],
  eval: ["title", "language"],
  task: ["name"],
  ctl: ["op", "target"],
  todo: ["op"],
  manage_skill: ["name"],
  ask: ["question"],
};

const TOOL_VERB: Record<string, string> = {
  bash: "Ran",
  read: "Read",
  write: "Wrote",
  edit: "Edited",
  glob: "Listed",
  grep: "Searched for",
  find: "Looked up",
  web_search: "Searched the web for",
  eval: "Evaluated",
  task: "Dispatched agents",
  wait: "Waited for background work",
  todo: "Updated the plan",
  ask: "Asked",
  ctl: "Steered a session",
  context_notes: "Saved context notes",
  manage_skill: "Managed a skill",
  new_context: "Requested a new context window",
};

function toolDetail(name: string, args: Record<string, unknown>): string | null {
  for (const key of TOOL_DETAIL_KEYS[name] ?? []) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      if (name === "edit") {
        const match = /^\[([^\]#]+)#/.exec(value);
        return match?.[1] ?? firstLine(value);
      }
      return firstLine(value, 160);
    }
    if (typeof value === "number") return String(value);
  }
  return null;
}

function toolLabel(call: ToolCall, detail: string | null): string {
  if (call.intent) return call.intent;
  const verb = TOOL_VERB[call.name];
  if (verb && detail) return `${verb} ${detail}`;
  if (verb) return verb;
  return call.name;
}

function toolCallFromBlock(block: Record<string, unknown>): ToolCall | null {
  if (block.type !== "toolCall" || typeof block.name !== "string") return null;
  const rawArgs = block.arguments;
  const args =
    typeof rawArgs === "string"
      ? (() => {
          try {
            return journalRecord(JSON.parse(rawArgs));
          } catch {
            return { input: rawArgs };
          }
        })()
      : journalRecord(rawArgs);
  const intent =
    str(block.intent) ??
    str(args.i) ??
    str(args.title) ??
    (typeof args.intent === "string" ? args.intent : null);
  return {
    id: typeof block.id === "string" ? block.id : "",
    name: block.name,
    intent: intent && intent.trim().length > 0 ? intent.trim() : null,
    arguments: args,
  };
}

function assistantMeta(message: Record<string, unknown>): AssistantMeta {
  const usage = journalRecord(message.usage);
  const started = num(message.timestamp);
  const completed = num(message.completedAt);
  return {
    model: str(message.model),
    provider: str(message.provider),
    durationMs:
      num(message.duration) ??
      (started !== null && completed !== null && completed >= started ? completed - started : null),
    outputTokens: num(usage.output),
    stopReason: str(message.stopReason),
    errorMessage: str(message.errorMessage),
  };
}

const bookkeepingLabel = (entry: NeoPiJournalEntry): string => {
  switch (entry.type) {
    case "model_usage":
      return "Model usage";
    case "credential_pin":
      return "Credential pin";
    case "title_change":
      return "Title change";
    case "custom":
      return `Native record · ${String(entry.customType ?? "custom")}`;
    case "session":
      return "Session header";
    default:
      return `Native record · ${entry.type}`;
  }
};

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

/** `anthropic/claude-opus-5-5` → `Claude Opus 5.5`; `gpt-6.1-sol` → `GPT 6.1 Sol`. */
export function modelDisplayName(model: string): string {
  const id = model.replace(/^.*\//, "");
  const words: string[] = [];
  for (const token of id.split("-").filter(Boolean)) {
    const last = words.at(-1);
    if (/^\d+$/.test(token) && last !== undefined && /^\d+(\.\d+)*$/.test(last)) {
      words[words.length - 1] = `${last}.${token}`;
    } else if (["gpt", "stt", "tts", "npi"].includes(token.toLowerCase())) {
      words.push(token.toUpperCase());
    } else {
      words.push(token.charAt(0).toUpperCase() + token.slice(1));
    }
  }
  return words.join(" ");
}

function dividerText(
  entry: NeoPiJournalEntry,
  next: NeoPiJournalEntry | undefined,
): {
  text: string;
  consumed: number;
} | null {
  switch (entry.type) {
    case "compaction": {
      const before = num(entry.tokensBefore);
      const after = num(entry.tokensAfter);
      return {
        text:
          before !== null && after !== null
            ? `Context compacted · ${formatTokens(before)} → ${formatTokens(after)} tokens`
            : "Context compacted",
        consumed: 0,
      };
    }
    case "model_change": {
      const model = modelDisplayName(String(entry.model ?? "unknown"));
      // A model switch usually lands with its reasoning level; one line for both.
      if (next?.type === "thinking_level_change" && typeof next.thinkingLevel === "string")
        return { text: `${model} · ${next.thinkingLevel}`, consumed: 1 };
      return { text: model, consumed: 0 };
    }
    case "thinking_level_change":
      return { text: `Reasoning ${String(entry.thinkingLevel ?? "unknown")}`, consumed: 0 };
    case "service_tier_change":
      return { text: "Service tier changed", consumed: 0 };
    case "reset_boundary":
      return { text: "Context reset · earlier entries stay in the journal", consumed: 0 };
    case "branch_summary":
      return { text: "Branch summary", consumed: 0 };
    default:
      return null;
  }
}

/** Entry kinds that mean something to a reader even outside debug mode. */
const VISIBLE_DIVIDERS = new Set([
  "compaction",
  "model_change",
  "thinking_level_change",
  "reset_boundary",
  "branch_summary",
]);

/**
 * One projection pass over `rows`. `pendingTools` maps a call id to the index of
 * its tool row while no result has joined it yet.
 */
function createPass(
  options: TranscriptOptions,
  rows: TranscriptRow[],
  pendingTools: Map<string, number>,
) {
  const appendOutputs = (anchor: string | null) => {
    for (const output of options.commandOutputs?.get(anchor) ?? []) rows.push(output);
  };

  const push = (row: TranscriptRow) => {
    rows.push(row);
  };

  const errorNote = (
    base: { entry: NeoPiJournalEntry; timestamp: string; live: boolean },
    meta: AssistantMeta,
  ): NoteRow => ({
    ...base,
    kind: "note",
    id: `${base.entry.id}:error`,
    label: meta.stopReason === "aborted" ? "Interrupted" : "Model error",
    text: meta.errorMessage ?? "",
    tone: meta.stopReason === "aborted" ? "system" : "error",
  });

  const visitMessage = (entry: NeoPiJournalEntry, live: boolean) => {
    const message = journalRecord(entry.message);
    const base = { entry, timestamp: entry.timestamp, live };
    const role = str(message.role);
    const before = rows.length;
    if (role === "user") {
      push({
        ...base,
        kind: "user",
        id: `${entry.id}:user`,
        text: blockText(message.content),
        images: [...blockImages(message.content), ...blockImages(message.images)],
        files: messageFiles(message.files),
        steering: message.steering === true,
      });
      return;
    }
    if (role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const meta = assistantMeta(message);
      const finished = !live && meta.stopReason !== null && meta.stopReason !== "toolUse";
      let lastProse = -1;
      content.forEach((value, index) => {
        const block = journalRecord(value);
        const id = `${entry.id}:${index}`;
        if (block.type === "text" && typeof block.text === "string") {
          if (block.text.trim().length === 0) return;
          push({ ...base, kind: "assistant", id, text: block.text, images: [], meta: null });
          lastProse = rows.length - 1;
          return;
        }
        if (block.type === "thinking" && typeof block.thinking === "string") {
          if (block.thinking.trim().length === 0) return;
          rows.push({
            ...base,
            kind: "thinking",
            id,
            text: block.thinking,
            summary: block.summary === true,
          });
          return;
        }
        if (block.type === "redactedThinking") {
          if (options.debug) push({ ...base, kind: "record", id, label: "Redacted reasoning" });
          return;
        }
        const call = toolCallFromBlock(block);
        if (call) {
          const detail = toolDetail(call.name, call.arguments);
          rows.push({
            ...base,
            kind: "tool",
            id,
            call,
            result: null,
            label: toolLabel(call, detail),
            detail,
          });
          if (call.id) pendingTools.set(call.id, rows.length - 1);
          return;
        }
        if (block.type === "image") {
          const images = blockImages([block]);
          if (images.length === 0) return;
          push({ ...base, kind: "assistant", id, text: "", images, meta: null });
          lastProse = rows.length - 1;
          return;
        }
        if (options.debug)
          push({ ...base, kind: "record", id, label: `${String(block.type ?? "unknown")} block` });
      });
      if (finished && lastProse >= 0 && rows[lastProse]?.kind === "assistant") {
        rows[lastProse] = { ...(rows[lastProse] as AssistantRow), meta };
      } else if (meta.errorMessage && (finished || content.length === 0)) {
        push(errorNote(base, meta));
      }
      if (rows.length === before && options.debug)
        push({
          ...base,
          kind: "record",
          id: `${entry.id}:record`,
          label: "Empty assistant message",
        });
      return;
    }
    if (role === "toolResult") {
      const callId = str(message.toolCallId) ?? "";
      const index = pendingTools.get(callId);
      const result: ToolResult = {
        entry,
        text: blockText(message.content),
        images: blockImages(message.content),
        isError: message.isError === true,
        details: message.details,
      };
      if (index !== undefined && rows[index]?.kind === "tool") {
        rows[index] = { ...(rows[index] as ToolRow), result };
        pendingTools.delete(callId);
        return;
      }
      // Orphan result (call not on this page): still a tool row.
      const call: ToolCall = {
        id: callId,
        name: str(message.toolName) ?? "tool",
        intent: null,
        arguments: {},
      };
      const id = `${entry.id}:result`;
      rows.push({
        ...base,
        kind: "tool",
        id,
        call,
        result,
        label: toolLabel(call, null),
        detail: null,
      });
      return;
    }
    if (role === "bashExecution" || role === "evalExecution" || role === "pythonExecution") {
      // Something the person ran from the composer: a tool row with its output.
      const command = str(message.command) ?? str(message.code) ?? "";
      const name =
        role === "bashExecution" ? "bash" : role === "pythonExecution" ? "python" : "eval";
      const call: ToolCall = {
        id: "",
        name,
        intent: null,
        arguments: role === "bashExecution" ? { command } : { code: command },
      };
      const exitCode = num(message.exitCode);
      const failed = (exitCode !== null && exitCode !== 0) || message.cancelled === true;
      const output = [
        str(message.output) ?? "",
        message.truncated === true ? "\n… output truncated by NeoPi" : "",
        message.cancelled === true ? "\n… cancelled" : "",
        exitCode !== null && exitCode !== 0 ? `\nexit ${exitCode}` : "",
      ].join("");
      const id = `${entry.id}:execution`;
      rows.push({
        ...base,
        kind: "tool",
        id,
        call,
        result: { entry, text: output, images: [], isError: failed, details: message.details },
        label: `You ran ${name}`,
        detail: firstLine(command, 160) || null,
      });
      return;
    }
    if (role === "developer" || role === "custom" || role === "system") {
      const text = blockText(message.content);
      if (message.display === false && !options.debug) return;
      push({
        ...base,
        kind: "note",
        id: `${entry.id}:note`,
        label:
          role === "developer"
            ? "System notice"
            : (str(message.customType)?.replaceAll("-", " ") ?? "Native message"),
        text: stripNoticeTags(text),
        tone: "system",
      });
      return;
    }
    if (options.debug || role !== null)
      push({
        ...base,
        kind: "record",
        id: `${entry.id}:record`,
        label: role ? `${role} message` : "Native message",
      });
  };

  /**
   * Projects `entries` from `from`, which must be where an iteration began
   * (a divider that merges its successor consumes two entries in one).
   * `onIteration` sees each iteration's first entry index and the row count before it.
   */
  const visitEntries = (
    entries: ReadonlyArray<NeoPiJournalEntry>,
    from: number,
    onIteration?: (entryIndex: number, rowCount: number) => void,
  ) => {
    // A resume from the first entry already holds the outputs that precede it.
    if (from === 0 && rows.length === 0) appendOutputs(null);
    for (let index = from; index < entries.length; index++) {
      onIteration?.(index, rows.length);
      const entry = entries[index]!;
      const base = { entry, timestamp: entry.timestamp, live: false };
      if (entry.type === "message") visitMessage(entry, false);
      else if (entry.type === "custom_message") {
        if (entry.display !== false || options.debug) {
          const customType = str(entry.customType);
          push({
            ...base,
            kind: "note",
            id: `${entry.id}:custom`,
            label:
              customType === "async-result"
                ? "Background result"
                : (customType?.replaceAll("-", " ") ?? "Notice"),
            text: stripNoticeTags(blockText(entry.content)),
            tone: "notice",
          });
        }
      } else if (VISIBLE_DIVIDERS.has(entry.type)) {
        const next = entries[index + 1];
        // Merge only when nothing (such as a command output) sits between the two entries.
        const mergeable = next && !options.commandOutputs?.get(entry.id)?.length ? next : undefined;
        const divider = dividerText(entry, mergeable);
        if (divider) {
          const summary =
            entry.type === "compaction" && typeof entry.summary === "string"
              ? stripNoticeTags(entry.summary)
              : "";
          push({
            ...base,
            kind: "divider",
            id: `${entry.id}:divider`,
            text: divider.text,
            ...(summary ? { summary } : {}),
          });
          if (divider.consumed > 0 && next) {
            if (options.debug)
              push({
                kind: "record",
                id: `${next.id}:record`,
                label: bookkeepingLabel(next),
                entry: next,
                timestamp: next.timestamp,
                live: false,
              });
            index += divider.consumed;
            appendOutputs(entry.id);
            appendOutputs(next.id);
            continue;
          }
        }
      } else if (options.debug) {
        push({ ...base, kind: "record", id: `${entry.id}:record`, label: bookkeepingLabel(entry) });
      }
      appendOutputs(entry.id);
    }
  };

  const visitPending = (pending: TranscriptSource["pending"], leafId: string | null) => {
    for (const { messageId, message } of pending) {
      visitMessage(liveEntry(messageId, leafId, message), true);
      appendOutputs(`live:${messageId}`);
    }
  };

  return { visitEntries, visitPending };
}

/**
 * A live message's synthetic journal entry. Keyed by the message object, which
 * the conversation reducer replaces only when that message changes, so an
 * unchanged live message keeps one entry (and rows that share it).
 */
const liveEntries = new WeakMap<
  object,
  { readonly messageId: string; readonly leafId: string | null; readonly entry: NeoPiJournalEntry }
>();

function liveEntry(
  messageId: string,
  leafId: string | null,
  message: Readonly<Record<string, unknown>>,
): NeoPiJournalEntry {
  const hit = liveEntries.get(message);
  if (hit && hit.messageId === messageId && hit.leafId === leafId) return hit.entry;
  const entry: NeoPiJournalEntry = {
    id: `live:${messageId}`,
    parentId: leafId,
    type: "message",
    timestamp: "",
    message,
  };
  liveEntries.set(message, { messageId, leafId, entry });
  return entry;
}

/** Structural equality for plain JSON-like values; shared references short-circuit. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (!sameValue(a[index], b[index])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!(key in right) || !sameValue(left[key], right[key])) return false;
  }
  return true;
}

function sameCommandOutputs(
  a: TranscriptOptions["commandOutputs"],
  b: TranscriptOptions["commandOutputs"],
): boolean {
  if (a === b) return true;
  const size = a?.size ?? 0;
  if (size !== (b?.size ?? 0)) return false;
  if (size === 0) return true;
  for (const [anchor, left] of a!) {
    const right = b!.get(anchor);
    if (!right || right.length !== left.length) return false;
    for (let index = 0; index < left.length; index++)
      if (!sameValue(left[index], right[index])) return false;
  }
  return true;
}

/** Swaps each row for an equal row of the previous projection, so unchanged rows keep identity. */
function shareRows(
  rows: TranscriptRow[],
  from: number,
  previous: ReadonlyMap<string, TranscriptRow>,
) {
  for (let index = from; index < rows.length; index++) {
    const row = rows[index]!;
    const before = previous.get(row.id);
    if (before && before !== row && sameValue(before, row)) rows[index] = before;
  }
}

const sameEntries = (a: ReadonlyArray<NeoPiJournalEntry>, b: ReadonlyArray<NeoPiJournalEntry>) =>
  a === b || (a.length === b.length && a.every((entry, index) => entry === b[index]));

/** The persisted entries' rows, and what resuming after an appended entry needs. */
interface PersistedProjection {
  readonly entries: ReadonlyArray<NeoPiJournalEntry>;
  readonly debug: boolean;
  readonly commandOutputs: TranscriptOptions["commandOutputs"];
  readonly rows: TranscriptRow[];
  /** Unjoined tool calls after the last entry, for live results that join them. */
  readonly pendingTools: Map<string, number>;
  /** Per iteration of the entry loop: its first entry index and the rows before it. */
  readonly iterationEntry: number[];
  readonly iterationRows: number[];
}

function projectPersisted(
  entries: ReadonlyArray<NeoPiJournalEntry>,
  options: TranscriptOptions,
  resume: {
    readonly base: PersistedProjection;
    readonly from: number;
    readonly rowCount: number;
    readonly iterations: number;
    readonly pendingTools: Map<string, number>;
    /** Tool rows the last iteration joined a result onto; they resume as open calls. */
    readonly unjoined: ReadonlyArray<number>;
  } | null,
  previous: ReadonlyMap<string, TranscriptRow>,
): PersistedProjection {
  const rows = resume ? resume.base.rows.slice(0, resume.rowCount) : [];
  for (const index of resume?.unjoined ?? [])
    rows[index] = { ...(rows[index] as ToolRow), result: null };
  const pendingTools = resume ? resume.pendingTools : new Map<string, number>();
  const iterationEntry = resume ? resume.base.iterationEntry.slice(0, resume.iterations) : [];
  const iterationRows = resume ? resume.base.iterationRows.slice(0, resume.iterations) : [];
  createPass(options, rows, pendingTools).visitEntries(
    entries,
    resume?.from ?? 0,
    (entryIndex, rowCount) => {
      iterationEntry.push(entryIndex);
      iterationRows.push(rowCount);
    },
  );
  shareRows(rows, resume?.rowCount ?? 0, previous);
  // Re-joined rows are new objects; equal to what they were, they stay what they were.
  for (const index of resume?.unjoined ?? []) {
    const before = resume!.base.rows[index]!;
    if (sameValue(before, rows[index])) rows[index] = before;
  }
  return {
    entries,
    debug: options.debug,
    commandOutputs: options.commandOutputs,
    rows,
    pendingTools,
    iterationEntry,
    iterationRows,
  };
}

/**
 * Where `entries` can continue the cached projection of an earlier, shorter list:
 * from the last iteration, whose output may change once an entry follows it.
 * Null when `entries` is not an extension, or the cached rows cannot be resumed
 * (duplicate tool call ids make the unjoined-call map ambiguous).
 */
function resumeAfterAppend(cached: PersistedProjection, entries: ReadonlyArray<NeoPiJournalEntry>) {
  const count = cached.entries.length;
  if (entries.length <= count || cached.iterationEntry.length === 0) return null;
  for (let index = 0; index < count; index++)
    if (entries[index] !== cached.entries[index]) return null;
  const iterations = cached.iterationEntry.length - 1;
  const rowCount = cached.iterationRows[iterations]!;
  const from = cached.iterationEntry[iterations]!;
  const lastEntry = cached.entries[from];
  const pendingTools = new Map<string, number>();
  const unjoined: number[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rowCount; index++) {
    const row = cached.rows[index]!;
    if (row.kind !== "tool" || row.call.id === "") continue;
    if (seen.has(row.call.id)) return null;
    seen.add(row.call.id);
    // The last iteration may be the result that joined this call; it runs again.
    if (row.result !== null && row.result.entry === lastEntry) unjoined.push(index);
    if (row.result === null || row.result.entry === lastEntry) pendingTools.set(row.call.id, index);
  }
  return { base: cached, from, rowCount, iterations, pendingTools, unjoined };
}

const rowsById = (rows: ReadonlyArray<TranscriptRow>, from = 0) => {
  const byId = new Map<string, TranscriptRow>();
  for (let index = from; index < rows.length; index++) byId.set(rows[index]!.id, rows[index]!);
  return byId;
};

// Project persisted entries once and replace only the live tail, retaining unchanged row identities.
export function createTranscriptProjector() {
  let cached: PersistedProjection | null = null;
  let last: { rows: ReadonlyArray<TranscriptRow>; tail: Map<string, TranscriptRow> } | null = null;
  return (source: TranscriptSource, options: TranscriptOptions): readonly TranscriptRow[] => {
    const { entries } = source;
    const reusable =
      cached !== null &&
      cached.debug === options.debug &&
      sameCommandOutputs(cached.commandOutputs, options.commandOutputs);
    let persisted: PersistedProjection;
    if (reusable && sameEntries(cached!.entries, entries))
      persisted = cached!.entries === entries ? cached! : { ...cached!, entries };
    else {
      const resume = reusable ? resumeAfterAppend(cached!, entries) : null;
      persisted = projectPersisted(
        entries,
        options,
        resume,
        resume ? rowsById(resume.base.rows, resume.rowCount) : rowsById(last?.rows ?? []),
      );
    }
    cached = persisted;

    let rows: ReadonlyArray<TranscriptRow> = persisted.rows;
    const tail = new Map<string, TranscriptRow>();
    if (source.pending.length > 0) {
      const next = persisted.rows.slice();
      createPass(options, next, new Map(persisted.pendingTools)).visitPending(
        source.pending,
        source.leafId,
      );
      for (let index = 0; index < next.length; index++) {
        if (next[index] === persisted.rows[index]) continue;
        const row = next[index]!;
        const before = last?.tail.get(row.id);
        if (before && before !== row && sameValue(before, row)) next[index] = before;
        tail.set(row.id, next[index]!);
      }
      rows = next;
    }
    if (last && last.rows.length === rows.length && last.rows.every((row, i) => row === rows[i]))
      rows = last.rows;
    last = { rows, tail };
    return rows;
  };
}

export function projectTranscript(
  source: TranscriptSource,
  options: TranscriptOptions,
): readonly TranscriptRow[] {
  return createTranscriptProjector()(source, options);
}

export function transcriptUserText(entries: ReadonlyArray<NeoPiJournalEntry>) {
  return entries.flatMap((entry) => {
    const message = journalRecord(entry.message);
    if (entry.type !== "message" || message.role !== "user") return [];
    return [{ id: entry.id, role: "user" as const, text: blockText(message.content) }];
  });
}
