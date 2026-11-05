import {
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProviderInstanceId,
  TurnId,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import {
  modelDisplayName,
  type TranscriptRow,
  type ToolRow,
} from "@t3tools/client-runtime/neopi-transcript";
import type { NeoPiJournalEntry } from "@t3tools/contracts";
import type { TimelineLatestTurn } from "../chat/MessagesTimeline.logic";
import type { QueuedComposerMessage } from "../../queuedMessageStore";
import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatAttachment, ChatMessage } from "../../types";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import {
  asKnownContextRecord,
  previewAnnotationFromRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
} from "../../lib/composerContextRecords";

/**
 * Native NeoPi journal rows, projected into the stock T3 timeline model so the
 * native workspace renders through `MessagesTimeline` instead of a parallel
 * renderer. NeoPi stays authoritative: this is a read-only view of its journal.
 *
 * Every user prompt opens a turn; rows before the first prompt on the loaded
 * page share an origin turn. Turn ids derive from journal entry ids, so paging
 * older history in never renames a turn the reader already expanded.
 */
export interface NativeTimeline {
  readonly entries: TimelineEntry[];
  readonly latestTurn: TimelineLatestTurn | null;
  readonly runningTurnId: TurnId | null;
}

/** Tool output past this many characters is cut; NeoPi keeps the full text. */
const TOOL_OUTPUT_LIMIT = 16_000;

const ITEM_TYPE: Record<string, ToolLifecycleItemType> = {
  bash: "command_execution",
  python: "command_execution",
  eval: "command_execution",
  edit: "file_change",
  write: "file_change",
  ast_edit: "file_change",
  web_search: "web_search",
  task: "collab_agent_tool_call",
};

function boundedOutput(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > TOOL_OUTPUT_LIMIT
    ? `${trimmed.slice(0, TOOL_OUTPUT_LIMIT)}\n… ${trimmed.length - TOOL_OUTPUT_LIMIT} more characters in the journal`
    : trimmed;
}

function toolCommand(row: ToolRow): string | undefined {
  const args = row.call.arguments;
  const value =
    row.call.name === "bash"
      ? args.command
      : row.call.name === "eval" || row.call.name === "python"
        ? (args.code ?? args.input)
        : undefined;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toolChangedFiles(row: ToolRow): string[] | undefined {
  if (ITEM_TYPE[row.call.name] !== "file_change") return undefined;
  const path = row.call.arguments.path ?? row.detail;
  return typeof path === "string" && path.length > 0 ? [path] : undefined;
}

function firstLine(text: string): string {
  const lines = text.trim().split("\n");
  const line = lines[0] ?? "";
  return lines.length > 1 || line.length > 200 ? `${line.slice(0, 200)} …` : line;
}

/** NeoPi's injected notices address the agent; keep what happened, drop the instruction. */
function noticeText(text: string): string {
  return text
    .replace(/\bhas completed\.\s*Resume your work using the result below\.?/i, "finished.")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * NeoPi states an intent for most calls ("Checking the build"); that sentence
 * is the row label and the expanded body holds the full command or argument
 * plus the output. Without an intent, T3's own labelling applies: a shell row
 * shows its first command line, other tools their path or pattern.
 */
function toolWorkEntry(row: ToolRow, turnId: TurnId, running: boolean): WorkLogEntry {
  const intent = row.call.intent ?? undefined;
  const fullCommand = toolCommand(row)?.trim();
  const command = fullCommand ? (intent ? fullCommand : firstLine(fullCommand)) : undefined;
  const changedFiles = toolChangedFiles(row);
  const itemType = ITEM_TYPE[row.call.name] ?? "dynamic_tool_call";
  const output = row.result ? boundedOutput(row.result.text) : "";
  const detail = intent
    ? [fullCommand ? "" : (row.detail ?? ""), output].filter(Boolean).join("\n\n")
    : fullCommand
      ? [fullCommand !== command ? fullCommand : "", output].filter(Boolean).join("\n\n")
      : (row.detail ??
        // A result whose call is on an earlier page has nothing but its output to show.
        (row.id.endsWith(":result")
          ? output
          : row.result?.isError
            ? firstLine(row.result.text)
            : ""));
  return {
    id: row.id,
    // A finished call is dated by its result, so turn durations cover the work.
    createdAt: row.result?.entry.timestamp ?? row.timestamp,
    turnId,
    ...(row.call.id ? { toolCallId: row.call.id } : {}),
    label: row.label,
    ...(intent ? { intent } : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(changedFiles ? { changedFiles } : {}),
    ...(row.call.name === "read" ? { requestKind: "file-read" as const } : {}),
    tone: "tool",
    toolTitle: row.label,
    itemType,
    toolLifecycleStatus: row.result
      ? row.result.isError
        ? "failed"
        : "completed"
      : running
        ? "inProgress"
        : "stopped",
  };
}

function imageAttachments(
  id: string,
  images: ReadonlyArray<{ readonly src: string; readonly mimeType: string }>,
): ChatAttachment[] {
  return images.map((image, index) => ({
    type: "image" as const,
    id: `${id}:image:${index}`,
    name: `image-${index + 1}.${image.mimeType.slice("image/".length)}`,
    mimeType: image.mimeType,
    sizeBytes: 0,
    previewUrl: image.src,
  }));
}

function message(
  id: string,
  role: ChatMessage["role"],
  text: string,
  turnId: TurnId,
  createdAt: string,
  streaming: boolean,
  attachments?: ChatAttachment[],
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(id),
      role,
      text,
      turnId,
      streaming,
      createdAt,
      updatedAt: createdAt,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    },
  };
}

function work(entry: WorkLogEntry): TimelineEntry {
  return { id: entry.id, kind: "work", createdAt: entry.createdAt, entry };
}

interface SettingState {
  readonly id: string;
  readonly model?: string | undefined;
  readonly level?: string | undefined;
}

/**
 * Model and reasoning changes. The projection already joins a model change with
 * the level change right after it ("Model · level"), so that level is read back.
 */
function settingChange(row: {
  readonly entry: NeoPiJournalEntry;
  readonly text: string;
}): { readonly model?: string; readonly level?: string } | null {
  const { entry } = row;
  if (entry.type === "model_change" && typeof entry.model === "string") {
    const joined = row.text.split(" · ");
    return {
      model: modelDisplayName(entry.model),
      ...(joined.length > 1 ? { level: joined.at(-1)! } : {}),
    };
  }
  if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
    return { level: entry.thinkingLevel };
  }
  return null;
}

function settingLabel(state: SettingState): string | null {
  if (state.model && state.level) return `${state.model} · ${state.level}`;
  if (state.model) return state.model;
  if (state.level) return `Reasoning ${state.level}`;
  return null;
}

/**
 * A row's timeline entry depends on the row and the running state when it was
 * reached (`a`, `b`). Rows keep their identity across updates, so a hit hands
 * back the same entry and the timeline's streaming fast path sees unchanged history.
 */
const entryMemo = new WeakMap<
  TranscriptRow,
  { readonly a: unknown; readonly b: unknown; readonly entry: TimelineEntry }
>();

function memoized(
  row: TranscriptRow,
  a: unknown,
  b: unknown,
  build: () => TimelineEntry,
): TimelineEntry {
  const hit = entryMemo.get(row);
  if (hit && hit.a === a && hit.b === b) return hit.entry;
  const entry = build();
  entryMemo.set(row, { a, b, entry });
  return entry;
}

/** The merged entry for a settings change, kept while the previous entry and label hold. */
const mergedSettingMemo = new WeakMap<
  TimelineEntry,
  { readonly label: string; readonly entry: TimelineEntry }
>();

export function projectNativeTimeline(
  rows: readonly TranscriptRow[],
  busy: boolean,
): NativeTimeline {
  const entries: TimelineEntry[] = [];
  let turnId = TurnId.make("native:origin");
  let turnStartedAt: string | null = null;
  let lastAt: string | null = null;
  let workEndedAt: string | null = null;
  let sawTurn = false;
  let lastSetting = null as SettingState | null;
  for (const row of rows) {
    if (row.kind === "command") {
      entries.push(
        memoized(row, turnId, lastAt, () =>
          work({
            id: row.id,
            createdAt: lastAt ?? new Date(0).toISOString(),
            turnId,
            label: "Command output",
            detail: row.text,
            tone: "info",
          }),
        ),
      );
      continue;
    }
    lastAt = row.timestamp;
    // Journal bookkeeping (model, reasoning and tier changes, compaction,
    // unrecognised records) lands after the reply when settings change later.
    // It is not work, so it must not stretch the turn's "Worked for" span.
    if (row.kind !== "divider" && row.kind !== "record") workEndedAt = row.timestamp;
    switch (row.kind) {
      case "user":
        // A steer joins the run it interrupts rather than starting a new turn.
        if (!row.steering || !sawTurn) {
          turnId = TurnId.make(`native:${row.entry.id}`);
          turnStartedAt = row.timestamp;
          sawTurn = true;
        }
        entries.push(
          memoized(row, turnId, null, () =>
            message(
              row.id,
              "user",
              row.text,
              turnId,
              row.timestamp,
              false,
              imageAttachments(row.id, row.images),
            ),
          ),
        );
        break;
      case "assistant":
        entries.push(
          memoized(row, turnId, null, () =>
            message(
              row.id,
              "assistant",
              row.text,
              turnId,
              row.timestamp,
              row.live,
              imageAttachments(row.id, row.images),
            ),
          ),
        );
        break;
      case "thinking":
        entries.push(
          memoized(row, turnId, null, () =>
            message(row.id, "reasoning", row.text, turnId, row.timestamp, row.live),
          ),
        );
        break;
      case "tool":
        // Only a call still waiting for its result shows whether the run is live.
        entries.push(
          memoized(row, turnId, row.result ? null : busy, () =>
            work(toolWorkEntry(row, turnId, busy)),
          ),
        );
        lastAt = row.result?.entry.timestamp ?? lastAt;
        workEndedAt = lastAt;
        break;
      case "divider": {
        const setting = settingChange(row);
        const previous = entries.at(-1);
        // Back-to-back model or reasoning changes read as one line with the result.
        if (setting && previous && previous.id === lastSetting?.id) {
          lastSetting = {
            id: previous.id,
            model: setting.model ?? lastSetting.model,
            level: setting.level ?? lastSetting.level,
          };
          const label = settingLabel(lastSetting) ?? row.text;
          const merged = mergedSettingMemo.get(previous);
          if (merged?.label === label) entries[entries.length - 1] = merged.entry;
          else {
            const entry = {
              ...previous,
              ...(previous.kind === "work" ? { entry: { ...previous.entry, label } } : {}),
            } as TimelineEntry;
            mergedSettingMemo.set(previous, { label, entry });
            entries[entries.length - 1] = entry;
          }
          break;
        }
        entries.push(
          memoized(row, turnId, null, () =>
            work({
              id: row.id,
              createdAt: row.timestamp,
              turnId,
              label: row.text,
              tone: "info",
              sourceActivityKind: "context-compaction",
            }),
          ),
        );
        lastSetting = setting ? { id: row.id, ...setting } : null;
        break;
      }
      case "note": {
        const label = row.label.charAt(0).toUpperCase() + row.label.slice(1);
        const text = noticeText(row.text);
        entries.push(
          memoized(row, turnId, null, () =>
            work({
              id: row.id,
              createdAt: row.timestamp,
              turnId,
              label,
              // The first line is the row label, the rest opens below it.
              ...(text ? { intent: text.split("\n")[0]!.trim(), detail: boundedOutput(text) } : {}),
              tone: row.tone === "error" ? "error" : "info",
            }),
          ),
        );
        break;
      }
      case "record":
        entries.push(
          memoized(row, turnId, null, () =>
            work({
              id: row.id,
              createdAt: row.timestamp,
              turnId,
              label: row.label,
              detail: JSON.stringify(row.entry, null, 2),
              tone: "info",
            }),
          ),
        );
        break;
    }
  }
  const latestTurn: TimelineLatestTurn | null = sawTurn
    ? {
        turnId,
        state: busy ? "running" : "completed",
        startedAt: turnStartedAt,
        completedAt: busy ? null : workEndedAt,
      }
    : null;
  return { entries, latestTurn, runningTurnId: busy && sawTurn ? turnId : null };
}

const NATIVE_SEND_SETTINGS: QueuedComposerMessage["sendSettings"] = {
  modelSelection: { instanceId: ProviderInstanceId.make("neopi"), model: "native" },
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: "default",
};

export interface NativeQueue {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
  readonly liveSteered: number;
}

/**
 * NeoPi's own prompt queue as timeline ghost rows; ids encode where each text
 * sits. Queued text is the serialized prompt, so context blocks (annotations,
 * terminal excerpts, review comments) are parsed back into their draft shapes.
 */
export function nativeQueuedMessages(
  queue: NativeQueue,
  createdAt: string,
): QueuedComposerMessage[] {
  const row = (
    lane: "steering" | "followUp",
    text: string,
    index: number,
    sending: boolean,
  ): QueuedComposerMessage => {
    const context = upgradeLegacyContextMessage(text);
    const records = context.records.flatMap((record) => {
      const known = asKnownContextRecord(record);
      return known ? [known] : [];
    });
    return {
      id: JSON.stringify([lane, index, text]),
      prompt: context.text,
      images: [],
      files: [],
      terminalContexts: records.flatMap((record) =>
        record.kind === "terminal" ? [terminalContextDraftFromRecord(record, "")] : [],
      ),
      previewAnnotations: records.flatMap((record) =>
        record.kind === "preview-annotation" ? [previewAnnotationFromRecord(record)] : [],
      ),
      reviewComments: records.flatMap((record) =>
        record.kind === "review-comment" ? [reviewCommentFromRecord(record)] : [],
      ),
      sendSettings: NATIVE_SEND_SETTINGS,
      queuedAfterToolActivityId: null,
      ...(sending ? { sending: "dispatching" as const } : {}),
      createdAt,
    };
  };
  return [
    ...queue.steering.map((text, index) => row("steering", text, index, index < queue.liveSteered)),
    ...queue.followUp.map((text, index) => row("followUp", text, index, false)),
  ];
}

export function parseNativeQueuedMessageId(
  id: string,
): { readonly lane: "steering" | "followUp"; readonly text: string } | null {
  try {
    const value: unknown = JSON.parse(id);
    if (
      Array.isArray(value) &&
      (value[0] === "steering" || value[0] === "followUp") &&
      typeof value[2] === "string"
    )
      return { lane: value[0], text: value[2] };
  } catch {}
  return null;
}

/**
 * The oldest queued prompt Send now can act on. NeoPi's `promote_queued_message` only moves
 * follow-ups into steering, so prompts already steering (or dispatching) are skipped.
 */
export function nextPromotableNativeQueuedMessageId(
  queued: readonly Pick<QueuedComposerMessage, "id" | "sending">[],
): string | null {
  return (
    queued.find(
      (message) =>
        message.sending === undefined &&
        parseNativeQueuedMessageId(message.id)?.lane === "followUp",
    )?.id ?? null
  );
}
