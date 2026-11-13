import { NodeId, TurnItemId, type OrchestrationV2Subagent } from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";

import { coreTurnTokenUsage, emptyCoreState, mapCoreFrame, type CoreState } from "./core.ts";
import { nativeItemBase, scopedItemId, type CoreMapCtx } from "./MapCtx.ts";
import {
  emptyToolState,
  mapToolFrame,
  settleTools,
  withHostToolNames,
  type ToolState,
} from "./tools.ts";

export interface SubagentState {
  readonly runs: Readonly<Record<string, ChildRun>>;
  readonly generations: Readonly<Record<string, number>>;
  readonly toolOwners: Readonly<Record<string, string | null>>;
}

interface ChildRun {
  readonly nativeId: string;
  readonly taskId: NodeId;
  readonly itemNativeId: string;
  readonly parentToolUseId?: string;
  readonly parentNodeId: NodeId;
  readonly description: string;
  readonly role?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly status: OrchestrationV2Subagent["status"];
  readonly terminal: boolean;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly core: CoreState;
  readonly tools: ToolState;
  readonly text: string;
  readonly toolUses: number;
  readonly completedTools: ReadonlySet<string>;
  readonly lastSummary?: string;
}

type MappedSubagents = {
  readonly events: ProviderAdapterV2Event[];
  readonly state: SubagentState;
};

export function emptySubagentState(): SubagentState {
  return { runs: {}, generations: {}, toolOwners: {} };
}

export function mapSubagentFrame(
  ctx: CoreMapCtx,
  frame: unknown,
  state: SubagentState,
  hostToolNames?: ReadonlyArray<string>,
): MappedSubagents {
  const record = asRecord(frame);
  if (!record || typeof record.type !== "string") return { events: [], state };
  switch (record.type) {
    case "subagent_lifecycle":
      return mapLifecycle(ctx, record, state, hostToolNames);
    case "subagent_progress":
      return mapProgress(ctx, record, state, hostToolNames);
    case "subagent_event":
      return mapEvent(ctx, record, state, hostToolNames);
    default:
      return { events: [], state };
  }
}

function mapLifecycle(
  ctx: CoreMapCtx,
  frame: Record<string, unknown>,
  state: SubagentState,
  hostToolNames: ReadonlyArray<string> | undefined,
): MappedSubagents {
  const payload = payloadOf(frame);
  const id = text(payload.id);
  const status = text(payload.status);
  if (!id || !status) return { events: [], state };
  if (status === "started") {
    const opened = startRun(ctx, state, id, payload, hostToolNames);
    return { events: taskEvents(ctx, opened.run), state: opened.state };
  }
  if (status !== "completed" && status !== "failed" && status !== "aborted") {
    return { events: [], state };
  }
  const previous = state.runs[id];
  if (!previous || previous.terminal) return { events: [], state };
  const statusForTools = status === "aborted" ? "cancelled" : status;
  const tools = settleTools(
    {
      ...ctx,
      nodeId: previous.taskId,
      agentId: previous.taskId,
      parentItemId: TurnItemId.make(previous.taskId),
    },
    previous.tools,
    statusForTools,
  );
  const run: ChildRun = {
    ...previous,
    status: statusForTools,
    terminal: true,
    completedAt: previous.completedAt ?? ctx.now(),
    tools: tools.state,
  };
  return { events: [...tools.events, ...taskEvents(ctx, run)], state: putRun(state, run) };
}

function mapProgress(
  ctx: CoreMapCtx,
  frame: Record<string, unknown>,
  state: SubagentState,
  hostToolNames: ReadonlyArray<string> | undefined,
): MappedSubagents {
  const payload = payloadOf(frame);
  const progress = asRecord(payload.progress) ?? {};
  const id = text(progress.id) ?? text(payload.id);
  if (!id || state.runs[id]?.terminal) return { events: [], state };
  const opened = ensureRun(ctx, state, id, payload, hostToolNames);
  const summary = progressSummary(progress);
  const status = opened.run.completedAt
    ? opened.run.status
    : (progressStatus(text(progress.status)) ?? opened.run.status);
  const run: ChildRun = {
    ...opened.run,
    description: text(payload.task) ?? opened.run.description,
    status,
    ...(isTerminal(status) ? { completedAt: opened.run.completedAt ?? ctx.now() } : {}),
    ...(summary ? { lastSummary: tail(summary) } : {}),
  };
  return { events: taskEvents(ctx, run), state: putRun(opened.state, run) };
}

function mapEvent(
  ctx: CoreMapCtx,
  frame: Record<string, unknown>,
  state: SubagentState,
  hostToolNames: ReadonlyArray<string> | undefined,
): MappedSubagents {
  const payload = payloadOf(frame);
  const id = text(payload.id);
  if (!id || payload.event === undefined || state.runs[id]?.terminal) {
    return { events: [], state };
  }
  const opened = ensureRun(ctx, state, id, payload, hostToolNames);
  const childCtx: CoreMapCtx = {
    ...ctx,
    nodeId: opened.run.taskId,
    agentId: opened.run.taskId,
    parentItemId: TurnItemId.make(opened.run.taskId),
  };
  const core = mapCoreFrame(childCtx, payload.event, opened.run.core);
  const tools = mapToolFrame(childCtx, payload.event, opened.run.tools);
  const record = asRecord(payload.event);
  const addition = textFromChildEvent(record);
  const finalText = record?.type === "message_end" ? assistantText(record.message) : undefined;
  const narration =
    finalText !== undefined
      ? tail(finalText)
      : addition
        ? tail(opened.run.text + addition)
        : opened.run.text;
  const toolCallId = text(record?.toolCallId);
  const newlyCompleted =
    record?.type === "tool_execution_end" &&
    toolCallId !== undefined &&
    !opened.run.completedTools.has(toolCallId);
  const model = record?.type === "agent_start" ? modelSlug(record.model) : undefined;
  const effort =
    record?.type === "agent_start"
      ? (text(record.effort) ?? text(record.thinkingLevel))
      : undefined;
  let summary = addition || finalText !== undefined ? narration : opened.run.lastSummary;
  for (const event of core.events) {
    if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
      summary = tail(event.turnItem.message);
    }
  }
  const run: ChildRun = {
    ...opened.run,
    core: core.state,
    tools: tools.state,
    text: narration,
    toolUses: opened.run.toolUses + (newlyCompleted ? 1 : 0),
    completedTools:
      newlyCompleted && toolCallId
        ? new Set(opened.run.completedTools).add(toolCallId)
        : opened.run.completedTools,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(summary !== undefined ? { lastSummary: summary } : {}),
  };
  const owner = toolCallId ? opened.state.toolOwners[toolCallId] : undefined;
  const changed =
    !state.runs[id] ||
    run.lastSummary !== opened.run.lastSummary ||
    run.model !== opened.run.model ||
    run.effort !== opened.run.effort ||
    run.toolUses !== opened.run.toolUses ||
    run.core.usage !== opened.run.core.usage;
  return {
    // Child text is progress, not a second message in the parent's conversation.
    events: [...(changed ? taskEvents(ctx, run) : []), ...tools.events],
    state: {
      ...putRun(opened.state, run),
      ...(record?.type === "tool_execution_start" && toolCallId
        ? {
            toolOwners: {
              ...opened.state.toolOwners,
              [toolCallId]: owner === undefined || owner === run.taskId ? run.taskId : null,
            },
          }
        : {}),
    },
  };
}

function startRun(
  ctx: CoreMapCtx,
  state: SubagentState,
  id: string,
  payload: Record<string, unknown>,
  hostToolNames: ReadonlyArray<string> | undefined,
): { readonly state: SubagentState; readonly run: ChildRun } {
  const existing = state.runs[id];
  if (existing && !existing.completedAt) {
    const description = text(payload.description) ?? existing.description;
    const run = description === existing.description ? existing : { ...existing, description };
    return { state: run === existing ? state : putRun(state, run), run };
  }
  const generation = (state.generations[id] ?? 0) + 1;
  const nativeParentToolUseId = text(payload.parentToolCallId);
  const parentAgentId = nativeParentToolUseId ? state.toolOwners[nativeParentToolUseId] : undefined;
  const parentToolUseId =
    nativeParentToolUseId && parentAgentId !== null
      ? scopedItemId(
          parentAgentId ? { ...ctx, agentId: parentAgentId } : ctx,
          nativeParentToolUseId,
        )
      : undefined;
  const role = text(payload.agent);
  const itemNativeId = `task:${id}#${generation}`;
  const run: ChildRun = {
    nativeId: id,
    taskId: NodeId.make(scopedItemId(ctx, itemNativeId)),
    itemNativeId,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    parentNodeId: parentAgentId ? NodeId.make(parentAgentId) : ctx.nodeId,
    description: text(payload.description) ?? text(payload.task) ?? role ?? id,
    ...(role ? { role } : {}),
    status: "running",
    terminal: false,
    startedAt: ctx.now(),
    core: emptyCoreState(),
    tools: withHostToolNames(emptyToolState(), hostToolNames ?? []),
    text: "",
    toolUses: 0,
    completedTools: new Set(),
  };
  return {
    state: {
      ...state,
      generations: { ...state.generations, [id]: generation },
      runs: { ...state.runs, [id]: run },
    },
    run,
  };
}

function ensureRun(
  ctx: CoreMapCtx,
  state: SubagentState,
  id: string,
  payload: Record<string, unknown>,
  hostToolNames: ReadonlyArray<string> | undefined,
): { readonly state: SubagentState; readonly run: ChildRun } {
  const existing = state.runs[id];
  return existing ? { state, run: existing } : startRun(ctx, state, id, payload, hostToolNames);
}

function taskEvents(ctx: CoreMapCtx, run: ChildRun): ProviderAdapterV2Event[] {
  const now = DateTime.makeUnsafe(ctx.now());
  const completedAt = run.completedAt ? DateTime.makeUnsafe(run.completedAt) : null;
  const nativeTaskRef = {
    driver: ctx.provider,
    nativeId: run.nativeId,
    strength: "strong" as const,
  };
  const usage = coreTurnTokenUsage(run.core);
  const subagent: OrchestrationV2Subagent = {
    id: run.taskId,
    threadId: ctx.threadId,
    runId: ctx.runId,
    parentNodeId: run.parentNodeId,
    origin: "provider_native",
    createdBy: "agent",
    driver: ctx.provider,
    providerInstanceId: ctx.providerInstanceId,
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef,
    prompt: run.description,
    ...(run.role ? { role: run.role } : {}),
    title: run.description,
    model: run.model ?? null,
    ...(run.model
      ? {
          modelSelection: {
            instanceId: ctx.providerInstanceId,
            model: run.model,
            ...(run.effort ? { options: [{ id: "reasoningEffort", value: run.effort }] } : {}),
          },
        }
      : {}),
    status: run.status,
    ...(run.lastSummary ? { progress: run.lastSummary } : {}),
    result: completedAt ? run.text || run.lastSummary || null : null,
    ...(usage.usageStatus !== "unavailable" ? { turnTokenUsage: usage } : {}),
    toolUses: run.toolUses,
    startedAt: DateTime.makeUnsafe(run.startedAt),
    completedAt,
    updatedAt: now,
  };
  return [
    {
      type: "node.updated",
      driver: ctx.provider,
      node: {
        id: run.taskId,
        threadId: ctx.threadId,
        runId: ctx.runId,
        parentNodeId: run.parentNodeId,
        rootNodeId: ctx.nodeId,
        kind: "subagent",
        status: run.status,
        countsForRun: false,
        providerThreadId: ctx.providerThreadId,
        providerTurnId: ctx.providerTurnId,
        nativeItemRef: nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: subagent.startedAt,
        completedAt,
      },
    },
    { type: "subagent.updated", driver: ctx.provider, subagent },
    {
      type: "turn_item.updated",
      driver: ctx.provider,
      turnItem: {
        ...nativeItemBase(ctx, run.itemNativeId, run.status, run.description, run.startedAt),
        nodeId: run.taskId,
        completedAt,
        nativeItemRef: nativeTaskRef,
        parentItemId: run.parentToolUseId ? TurnItemId.make(run.parentToolUseId) : null,
        type: "subagent",
        subagentId: run.taskId,
        origin: "provider_native",
        driver: ctx.provider,
        providerInstanceId: ctx.providerInstanceId,
        childThreadId: null,
        prompt: subagent.prompt,
        ...(subagent.progress ? { progress: subagent.progress } : {}),
        result: subagent.result,
      },
    },
  ];
}

function isTerminal(status: OrchestrationV2Subagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function progressSummary(progress: Record<string, unknown>): string | undefined {
  if (typeof progress.recentOutput === "string") return text(progress.recentOutput);
  if (Array.isArray(progress.recentOutput)) {
    for (let index = progress.recentOutput.length - 1; index >= 0; index -= 1) {
      const entry = text(progress.recentOutput[index]);
      if (entry) return entry;
    }
  }
  return text(progress.lastIntent) ?? text(progress.currentTool) ?? text(progress.description);
}

function progressStatus(status: string | undefined): OrchestrationV2Subagent["status"] | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
    case "idle":
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    case "aborted":
      return "cancelled";
    default:
      return undefined;
  }
}

function textFromChildEvent(event: Record<string, unknown> | undefined): string {
  const assistant = asRecord(event?.assistantMessageEvent);
  if (!assistant || typeof assistant.type !== "string") return "";
  if (!assistant.type.endsWith("_delta")) return "";
  if (!assistant.type.startsWith("text_") && !assistant.type.startsWith("thinking_")) return "";
  return typeof assistant.delta === "string" ? assistant.delta : "";
}

function assistantText(value: unknown): string | undefined {
  const message = asRecord(value);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  return message.content
    .flatMap((block) => {
      const part = asRecord(block);
      return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
    })
    .join("");
}

function payloadOf(frame: Record<string, unknown>): Record<string, unknown> {
  return asRecord(frame.payload) ?? frame;
}

function putRun(state: SubagentState, run: ChildRun): SubagentState {
  return { ...state, runs: { ...state.runs, [run.nativeId]: run } };
}

function modelSlug(model: unknown): string | undefined {
  const direct = text(model);
  if (direct) return direct;
  const record = asRecord(model);
  if (!record) return undefined;
  const provider = text(record.provider);
  const id = text(record.id) ?? text(record.modelId);
  if (provider && id) return `${provider}/${id}`;
  return id;
}

function tail(value: string): string {
  const trimmed = value.trim();
  let start = Math.max(0, trimmed.length - 160);
  const code = trimmed.charCodeAt(start);
  if (start > 0 && code >= 0xdc00 && code <= 0xdfff) start += 1;
  return trimmed.slice(start);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
