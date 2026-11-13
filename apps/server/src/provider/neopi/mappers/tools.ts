import type { OrchestrationV2TurnItem, ToolActivitySource } from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

import { nativeItemBase, type MapCtx } from "./MapCtx.ts";
import { snapshotDelta } from "./snapshotDelta.ts";

export interface InFlightTool {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly startedAt: string;
  readonly host: boolean;
  readonly bashSnapshot?: string;
}

export interface ToolState {
  readonly inFlightTools: Readonly<Record<string, InFlightTool>>;
  readonly hostToolNames: ReadonlySet<string>;
  readonly hostToolCallIds: ReadonlySet<string>;
  readonly completedToolCallIds: ReadonlySet<string>;
}

const T3_CODE_TOOL_SOURCE = {
  key: "t3-code",
  name: "NeoCode",
  kind: "integration",
} as const satisfies ToolActivitySource;

const FILE_CHANGE_TOOLS = new Set(["edit", "write", "delete", "move"]);

export function emptyToolState(): ToolState {
  return {
    inFlightTools: {},
    hostToolNames: new Set(),
    hostToolCallIds: new Set(),
    completedToolCallIds: new Set(),
  };
}

export function withHostToolNames(state: ToolState, names: Iterable<string>): ToolState {
  const hostToolNames = new Set(state.hostToolNames);
  for (const name of names) {
    if (name.length > 0) hostToolNames.add(name);
  }
  return hostToolNames.size === state.hostToolNames.size ? state : { ...state, hostToolNames };
}

export function mapToolFrame(
  ctx: MapCtx,
  frame: unknown,
  state: ToolState,
): { events: ProviderAdapterV2Event[]; state: ToolState } {
  const record = asRecord(frame);
  if (!record) return { events: [], state };
  if (record.type === "host_tool_call") {
    const id = stringField(record.toolCallId);
    return { events: [], state: id ? addId(state, "hostToolCallIds", id) : state };
  }
  if (
    record.type !== "tool_execution_start" &&
    record.type !== "tool_execution_update" &&
    record.type !== "tool_execution_end"
  )
    return { events: [], state };
  const identity = callIdentity(record);
  if (!identity || state.completedToolCallIds.has(identity.toolCallId))
    return { events: [], state };

  const existing = state.inFlightTools[identity.toolCallId];
  if (existing && record.type === "tool_execution_start") return { events: [], state };
  let call: InFlightTool = existing ?? {
    ...identity,
    args: record.args,
    startedAt: ctx.now(),
    host:
      state.hostToolNames.has(identity.toolName) || state.hostToolCallIds.has(identity.toolCallId),
  };
  if (existing && record.args !== undefined) call = { ...call, args: record.args };
  if (!call.host && state.hostToolCallIds.has(call.toolCallId)) call = { ...call, host: true };
  const events: ProviderAdapterV2Event[] = [];
  if (!existing) events.push(toolEvent(ctx, call, "running"));

  if (record.type === "tool_execution_end") {
    const failed = record.isError === true || asRecord(record.result)?.isError === true;
    events.push(toolEvent(ctx, call, failed ? "failed" : "completed", record.result));
    const inFlightTools = { ...state.inFlightTools };
    delete inFlightTools[call.toolCallId];
    return {
      events,
      state: {
        ...state,
        inFlightTools,
        completedToolCallIds: addToSet(state.completedToolCallIds, call.toolCallId),
      },
    };
  }
  if (record.type === "tool_execution_update" && call.toolName === "bash" && !call.host) {
    const snapshot = snapshotText(record.partialResult);
    if (snapshot !== undefined) {
      const visible = visibleCommandSnapshot(
        snapshotDelta(call.bashSnapshot ?? "", snapshot),
        snapshot,
      );
      call = { ...call, bashSnapshot: snapshot };
      if (visible !== undefined) events.push(toolEvent(ctx, call, "running", undefined, visible));
    }
  }
  return { events, state: putInFlight(state, call) };
}

export function settleTools(
  ctx: MapCtx,
  state: ToolState,
  status: "completed" | "failed" | "cancelled" | "interrupted",
): { events: ProviderAdapterV2Event[]; state: ToolState } {
  const calls = Object.values(state.inFlightTools);
  if (calls.length === 0) return { events: [], state };
  const completedToolCallIds = new Set(state.completedToolCallIds);
  const events = calls.map((call) => {
    completedToolCallIds.add(call.toolCallId);
    return toolEvent(ctx, call, status);
  });
  return {
    events,
    state: { ...state, inFlightTools: {}, completedToolCallIds },
  };
}

function toolEvent(
  ctx: MapCtx,
  call: InFlightTool,
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted",
  result?: unknown,
  snapshot?: string,
): ProviderAdapterV2Event {
  const args = asRecord(call.args);
  const intent = stringField(args?.i)?.trim();
  const base = nativeItemBase(
    ctx,
    call.toolCallId,
    status,
    intent || call.toolName,
    call.startedAt,
  );
  const details = asRecord(asRecord(result)?.details);
  const output = joinText(contentBlocks(result));
  let turnItem: OrchestrationV2TurnItem;
  if (call.toolName === "bash" && !call.host) {
    const text =
      output ??
      snapshot ??
      (call.bashSnapshot === undefined
        ? undefined
        : withoutTrailingIncompleteCodePoint(call.bashSnapshot));
    const exitCode = integerField(details?.exitCode);
    turnItem = {
      ...base,
      type: "command_execution",
      input: commandFromArgs(call.args) ?? "",
      ...(text !== undefined ? { output: text } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(status === "failed" ? { outputIndicatesFailure: true } : {}),
    };
  } else {
    const paths =
      !call.host && FILE_CHANGE_TOOLS.has(call.toolName)
        ? uniqueStrings([...pathsFromArgs(call.args), ...pathsFromDetails(details)])
        : [];
    const fileName = paths[0];
    if (fileName !== undefined) {
      const diff = call.toolName === "edit" ? editDiff(details) : undefined;
      turnItem = {
        ...base,
        type: "file_change",
        fileName,
        changes: paths.map((path) => ({ path, operation: call.toolName })),
        ...(diff !== undefined ? { diffStr: diff } : {}),
        ...(call.toolName === "write" && typeof args?.content === "string"
          ? { newStr: args.content }
          : {}),
      };
    } else {
      const viewedImagePath = workspaceImagePath(call.args, details);
      turnItem = {
        ...base,
        type: "dynamic_tool",
        toolName: call.toolName,
        input: call.args,
        ...(result !== undefined ? { output: result } : {}),
        ...(viewedImagePath ? { viewedImagePath } : {}),
        ...(call.host ? { toolSource: T3_CODE_TOOL_SOURCE } : {}),
      };
    }
  }
  return { type: "turn_item.updated", driver: ctx.provider, turnItem };
}

function editDiff(details: Record<string, unknown> | undefined): string | undefined {
  if (!details) return undefined;
  if (typeof details.diff === "string" && details.diff.length > 0) return details.diff;
  if (!Array.isArray(details.perFileResults)) return undefined;
  const diffs: string[] = [];
  for (const entry of details.perFileResults) {
    const diff = asRecord(entry)?.diff;
    if (typeof diff === "string" && diff.length > 0) diffs.push(diff);
  }
  return diffs.length > 0 ? diffs.join("\n") : undefined;
}

function integerField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function workspaceImagePath(
  args: unknown,
  details: Record<string, unknown> | undefined,
): string | undefined {
  const record = asRecord(args);
  const source = asRecord(asRecord(details?.meta)?.source);
  const candidates = [
    record?.imagePath,
    record?.file_path,
    record?.path,
    details?.imagePath,
    details?.resolvedPath,
    details?.displayTarget,
    details?.path,
    source?.type === "path" ? source.value : undefined,
  ];
  for (const candidate of candidates) {
    const path = localImagePath(candidate);
    if (path) return path;
  }
  return undefined;
}

function localImagePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !isWorkspaceImagePreviewPath(trimmed)) return undefined;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname.length > 0 && url.hostname !== "localhost") return undefined;
      const pathname = decodeURIComponent(url.pathname);
      const path = /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
      return isWorkspaceImagePreviewPath(path) ? path : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) return undefined;
  return trimmed;
}

function visibleCommandSnapshot(
  compared: ReturnType<typeof snapshotDelta>,
  snapshot: string,
): string | undefined {
  if ("delta" in compared && compared.delta.length === 0) return undefined;
  const visible = withoutTrailingIncompleteCodePoint(snapshot);
  return visible.length > 0 ? visible : undefined;
}

function withoutTrailingIncompleteCodePoint(value: string): string {
  if (value.length === 0) return value;
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
}

function putInFlight(state: ToolState, call: InFlightTool): ToolState {
  return {
    ...state,
    inFlightTools: { ...state.inFlightTools, [call.toolCallId]: call },
  };
}

function addId(
  state: ToolState,
  key: "hostToolCallIds" | "completedToolCallIds",
  id: string,
): ToolState {
  if (state[key].has(id)) return state;
  return { ...state, [key]: addToSet(state[key], id) };
}

function addToSet(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  next.add(value);
  return next;
}

function callIdentity(
  record: Record<string, unknown>,
): { toolCallId: string; toolName: string } | undefined {
  const toolCallId = stringField(record.toolCallId);
  const toolName = stringField(record.toolName);
  if (!toolCallId || !toolName) return undefined;
  return { toolCallId, toolName };
}

function commandFromArgs(args: unknown): string | undefined {
  if (typeof args === "string" && args.length > 0) return args;
  const record = asRecord(args);
  if (!record) return undefined;
  const command = record.command ?? record.cmd;
  if (typeof command === "string" && command.length > 0) return command;
  if (Array.isArray(command)) {
    const parts = command.filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    if (parts.length > 0) return parts.join(" ");
  }
  return undefined;
}

function pathsFromArgs(args: unknown): string[] {
  const record = asRecord(args);
  if (!record) return [];
  const paths: string[] = [];
  pushPath(paths, record.path);
  pushPath(paths, record.filePath);
  pushPath(paths, record.file);
  pushPath(paths, record.sourcePath);
  pushPath(paths, record.from);
  pushPath(paths, record.to);
  pushPath(paths, record.source);
  pushPath(paths, record.destination);
  pushPath(paths, record.rename);
  pushPath(paths, record.move);
  if (Array.isArray(record.paths)) {
    for (const entry of record.paths) pushPath(paths, entry);
  }
  if (Array.isArray(record.edits)) {
    for (const edit of record.edits) {
      const file = asRecord(edit);
      if (!file) continue;
      pushPath(paths, file.path);
      pushPath(paths, file.filePath);
      pushPath(paths, file.move);
      pushPath(paths, file.rename);
    }
  }
  if (typeof record.input === "string") {
    for (const match of record.input.matchAll(/^\[([^\]#\n]+)(?:#[^\]]+)?\]/gm)) {
      pushPath(paths, match[1]);
    }
  }
  return uniqueStrings(paths);
}

function pathsFromDetails(details: Record<string, unknown> | undefined): string[] {
  if (!details) return [];
  const paths: string[] = [];
  pushPath(paths, details.path);
  pushPath(paths, details.sourcePath);
  pushPath(paths, details.move);
  if (Array.isArray(details.perFileResults)) {
    for (const entry of details.perFileResults) {
      const file = asRecord(entry);
      if (!file) continue;
      pushPath(paths, file.path);
      pushPath(paths, file.sourcePath);
      pushPath(paths, file.move);
    }
  }
  return paths;
}

function snapshotText(partialResult: unknown): string | undefined {
  if (typeof partialResult === "string") return partialResult;
  const record = asRecord(partialResult);
  if (!record) return undefined;
  if (typeof record.text === "string") return record.text;
  if (typeof record.output === "string") return record.output;
  if (!Array.isArray(record.content)) return undefined;
  return joinText(record.content);
}

function contentBlocks(result: unknown): ReadonlyArray<unknown> {
  if (typeof result === "string") return [{ type: "text", text: result }];
  const content = asRecord(result)?.content;
  return Array.isArray(content) ? content : [];
}

function joinText(blocks: ReadonlyArray<unknown>): string | undefined {
  const parts: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function pushPath(paths: string[], value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) paths.push(value);
}

function uniqueStrings(values: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
