import { MessageId, type OrchestrationV2TurnItem, type TurnTokenUsage } from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";

import { nativeItemBase, scopedItemId, type CoreMapCtx } from "./MapCtx.ts";

type CoreResult = { readonly events: ProviderAdapterV2Event[]; readonly state: CoreState };

// Only the runtime's t3.turn.outcome settles a turn; native agent_end cannot.
// t3.state carries post-settlement/compaction snapshots; t3.compaction covers manual compaction.
const T3_TURN_OUTCOME_TYPE = "t3.turn.outcome";
const T3_STATE_TYPE = "t3.state";
const T3_COMPACTION_TYPE = "t3.compaction";

const TURN_STATES = ["completed", "failed", "interrupted", "cancelled"] as const;
type TurnState = (typeof TURN_STATES)[number];

export interface CoreState {
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly nextMessageOrdinal: number;
  readonly turnStarted: boolean;
  readonly openMessageOrdinal: number | undefined;
  readonly messages: ReadonlyArray<AssistantMessageRecord>;
  readonly openItems: Readonly<Record<string, OpenContentItem>>;
  readonly usage: UsageTotals;
  readonly hasSubagents: boolean;
  readonly compaction: CompactionTracker | undefined;
  readonly commandSeq: number;
}

interface AssistantMessageRecord {
  readonly ordinal: number;
  readonly signature: string;
  readonly hasUsage: boolean;
  readonly terminal: boolean;
}

interface OpenContentItem {
  readonly itemId: string;
  readonly ordinal: number;
  readonly contentIndex: number;
  readonly itemType: "assistant_message" | "reasoning";
  readonly text: string;
  readonly startedAt: string;
  readonly pendingComplete: boolean;
  readonly failed: boolean;
}

interface UsageTotals {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly sawReasoning: boolean;
  readonly totalCostUsd: number;
  readonly sawCost: boolean;
  readonly withUsage: number;
  readonly withoutUsage: number;
}

interface CompactionTracker {
  readonly itemId: string;
  readonly startedAt: string;
  readonly open: boolean;
  readonly settled: boolean;
  readonly beforeTokens: number | undefined;
  readonly afterTokens: number | undefined;
}

interface ParsedUsage {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number | undefined;
  readonly costTotal: number | undefined;
}

const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  sawReasoning: false,
  totalCostUsd: 0,
  sawCost: false,
  withUsage: 0,
  withoutUsage: 0,
};

export function emptyCoreState(): CoreState {
  return {
    model: undefined,
    thinkingLevel: undefined,
    nextMessageOrdinal: 1,
    turnStarted: false,
    openMessageOrdinal: undefined,
    messages: [],
    openItems: {},
    usage: EMPTY_USAGE,
    hasSubagents: false,
    compaction: undefined,
    commandSeq: 0,
  };
}

/** Turn usage accumulated since the last `agent_start`, after dedupe. */
export function coreTurnTokenUsage(state: CoreState): TurnTokenUsage {
  return tokenUsageFrom(state);
}

export function mapCoreFrame(ctx: CoreMapCtx, frame: unknown, state: CoreState): CoreResult {
  const record = asRecord(frame);
  if (!record || typeof record.type !== "string") return { events: [], state };
  switch (record.type) {
    case "t3.prompt.accepted":
      return {
        events:
          ctx.agentId === undefined && ctx.providerTurn && !ctx.providerTurn.inputAccepted
            ? [
                {
                  type: "provider_turn.updated",
                  driver: ctx.provider,
                  threadId: ctx.threadId,
                  providerTurn: { ...ctx.providerTurn, inputAccepted: true },
                },
              ]
            : [],
        state,
      };
    case "agent_start":
      return mapAgentStart(ctx, record, state);
    case "message_start": {
      const message = asRecord(record.message);
      return {
        events: [],
        state:
          message?.role === "assistant"
            ? openAssistant(state, message)
            : { ...state, openMessageOrdinal: undefined },
      };
    }
    case "message_update":
      return mapMessageUpdate(ctx, record, state);
    case "message_end": {
      const message = asRecord(record.message);
      if (message?.role !== "assistant") {
        return { events: [], state: { ...state, openMessageOrdinal: undefined } };
      }
      let next = state.openMessageOrdinal === undefined ? openAssistant(state, message) : state;
      next = noteUsage(next, next.openMessageOrdinal, message, true);
      next = rememberSignature(next, next.openMessageOrdinal, signatureOf(message));
      return closeOpenContent(ctx, next, next.openMessageOrdinal, false);
    }
    case "agent_end": {
      const messages = Array.isArray(record.messages)
        ? record.messages.filter(isAssistantMessage)
        : [];
      return closeOpenContent(
        ctx,
        pairAgentEndMessages(state, messages),
        state.openMessageOrdinal,
        false,
      );
    }
    case "turn_end": {
      const closed = closeOpenContent(ctx, state, state.openMessageOrdinal, false);
      return {
        events: closed.events,
        state: { ...closed.state, openMessageOrdinal: state.openMessageOrdinal },
      };
    }
    case "command_output": {
      const textValue = typeof record.text === "string" ? record.text : "";
      if (!textValue) return { events: [], state };
      const seq = state.commandSeq + 1;
      return {
        events: contentEvents(
          ctx,
          {
            itemId: `neopi:command:${seq}`,
            ordinal: state.nextMessageOrdinal,
            contentIndex: 0,
            itemType: "assistant_message",
            text: textValue,
            startedAt: ctx.now(),
            pendingComplete: true,
            failed: false,
          },
          "completed",
        ),
        state: { ...state, commandSeq: seq },
      };
    }
    case "subagent_lifecycle":
    case "subagent_progress":
    case "subagent_event":
      return { events: [], state: { ...state, hasSubagents: true } };
    case "notice": {
      const message = text(record.message);
      return {
        events: message ? [noticeEvent(ctx, message, noticeDetail(record))] : [],
        state,
      };
    }
    case "auto_retry_start": {
      const attempt = nonNeg(record.attempt);
      const maxAttempts = nonNeg(record.maxAttempts);
      const message =
        text(record.errorMessage) ??
        `NeoPi is retrying${attempt !== undefined ? ` (attempt ${attempt}${maxAttempts !== undefined ? `/${maxAttempts}` : ""})` : ""}`;
      return {
        events: [
          noticeEvent(ctx, message, {
            ...(attempt !== undefined ? { attempt } : {}),
            ...(maxAttempts !== undefined ? { maxAttempts } : {}),
            ...(nonNeg(record.delayMs) !== undefined ? { delayMs: nonNeg(record.delayMs) } : {}),
            ...(record.errorId !== undefined ? { errorId: record.errorId } : {}),
          }),
        ],
        state,
      };
    }
    case "auto_retry_end":
      return {
        events:
          record.success === false
            ? [
                noticeEvent(
                  ctx,
                  text(record.finalError) ?? "NeoPi retry failed",
                  nonNeg(record.attempt) !== undefined ? { attempt: nonNeg(record.attempt) } : {},
                ),
              ]
            : [],
        state,
      };
    case "retry_fallback_applied": {
      const fromModel = text(record.from);
      const toModel = text(record.to);
      if (!fromModel || !toModel) return { events: [], state };
      const reason =
        text(record.reason) ??
        (text(record.role) ? `Retry fallback (${text(record.role)})` : "Retry fallback");
      const refreshed = metadataRefresh(ctx, state, toModel, state.thinkingLevel, false);
      return {
        events: [noticeEvent(ctx, reason, { fromModel, toModel }), ...refreshed.events],
        state: refreshed.state,
      };
    }
    case "config_update": {
      const hasModel = Object.prototype.hasOwnProperty.call(record, "model");
      const hasThinking = Object.prototype.hasOwnProperty.call(record, "thinkingLevel");
      const thinkingLevel = hasThinking ? text(record.thinkingLevel) : state.thinkingLevel;
      return metadataRefresh(
        ctx,
        state,
        hasModel ? (modelSlug(record.model) ?? text(record.model)) : state.model,
        thinkingLevel,
        hasThinking && thinkingLevel === undefined,
      );
    }
    case "thinking_level_changed": {
      const level = text(record.thinkingLevel) ?? text(record.resolved) ?? text(record.configured);
      return metadataRefresh(ctx, state, state.model, level, level === undefined);
    }
    case "extension_error":
      return {
        events: [
          noticeEvent(ctx, errorText(record.error), {
            ...(text(record.extensionPath) ? { extensionPath: text(record.extensionPath) } : {}),
            ...(text(record.event) ? { event: text(record.event) } : {}),
          }),
        ],
        state,
      };
    case "auto_compaction_start":
      return mapCompactionStart(ctx, record, state);
    case "auto_compaction_end":
    case T3_COMPACTION_TYPE:
      return settleCompaction(ctx, record, state);
    case T3_TURN_OUTCOME_TYPE:
      return mapTurnOutcome(ctx, record, state);
    case T3_STATE_TYPE:
      return mapSessionState(ctx, record, state);
    case "t3.session.exited": {
      const recoverable = record.recoverable === true;
      const stderr =
        typeof record.stderrTail === "string" ? record.stderrTail.trim().slice(-512) : "";
      const processStatus = [
        `code ${String(record.code ?? "unknown")}`,
        ...(typeof record.signal === "string" ? [`signal ${record.signal}`] : []),
      ].join(", ");
      return {
        events: [
          {
            type: "provider_session.updated",
            driver: ctx.provider,
            providerSession: {
              ...ctx.providerSession,
              status: recoverable ? "error" : "stopped",
              lastError: recoverable
                ? `NeoPi process exited (${processStatus})${stderr ? `: ${stderr}` : ""}`
                : null,
              updatedAt: DateTime.makeUnsafe(ctx.now()),
            },
          },
        ],
        state,
      };
    }
    default:
      return { events: [], state };
  }
}

function mapAgentStart(
  ctx: CoreMapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): CoreResult {
  const model = modelSlug(frame.model) ?? text(frame.model) ?? state.model;
  const effort = text(frame.effort) ?? text(frame.thinkingLevel) ?? state.thinkingLevel;
  if (state.turnStarted) {
    return { events: [], state: { ...state, model, thinkingLevel: effort } };
  }
  const next: CoreState = {
    ...state,
    model,
    thinkingLevel: effort,
    turnStarted: true,
    openMessageOrdinal: undefined,
    messages: [],
    openItems: {},
    usage: EMPTY_USAGE,
    hasSubagents: false,
  };
  return {
    events:
      ctx.agentId === undefined && ctx.providerTurn
        ? [
            {
              type: "provider_turn.updated",
              driver: ctx.provider,
              threadId: ctx.threadId,
              providerTurn: {
                ...ctx.providerTurn,
                status: "running",
                startedAt: ctx.providerTurn.startedAt ?? DateTime.makeUnsafe(ctx.now()),
                ...(model ? { model } : {}),
              },
            },
          ]
        : [],
    state: next,
  };
}

function mapMessageUpdate(
  ctx: CoreMapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): CoreResult {
  const assistantEvent = asRecord(frame.assistantMessageEvent);
  if (!assistantEvent || typeof assistantEvent.type !== "string") return { events: [], state };
  const message =
    asRecord(frame.message) ?? asRecord(assistantEvent.partial) ?? asRecord(assistantEvent.message);
  let next =
    message?.role === "assistant" || message === undefined
      ? ensureOpenAssistant(state, message)
      : state;
  const kind = contentKind(assistantEvent.type);
  if (!kind || next.openMessageOrdinal === undefined) {
    if (assistantEvent.type !== "error" && assistantEvent.type !== "done") {
      return { events: [], state: next };
    }
    const final = asRecord(assistantEvent.message) ?? asRecord(assistantEvent.error);
    if (final?.role === "assistant") {
      next = noteUsage(next, next.openMessageOrdinal, final, true);
      next = rememberSignature(next, next.openMessageOrdinal, signatureOf(final));
    }
    const closed = closeOpenContent(
      ctx,
      next,
      next.openMessageOrdinal,
      assistantEvent.type === "error",
    );
    return {
      events: closed.events,
      state: { ...closed.state, openMessageOrdinal: next.openMessageOrdinal },
    };
  }
  const contentIndex = contentIndexOf(assistantEvent);
  const itemId = contentItemId(next.openMessageOrdinal, kind, contentIndex);
  let item = next.openItems[itemId];
  const isStart = assistantEvent.type === "text_start" || assistantEvent.type === "thinking_start";
  const isDelta = assistantEvent.type.endsWith("_delta");
  const isEnd = assistantEvent.type === "text_end" || assistantEvent.type === "thinking_end";
  if (!isStart && !isDelta && !isEnd) return { events: [], state: next };
  item ??= {
    itemId,
    ordinal: next.openMessageOrdinal,
    contentIndex,
    itemType: kind === "thinking" ? "reasoning" : "assistant_message",
    text: "",
    startedAt: ctx.now(),
    pendingComplete: false,
    failed: false,
  };
  if (isDelta && typeof assistantEvent.delta === "string") {
    item = { ...item, text: item.text + assistantEvent.delta };
  }
  if (isEnd) {
    item = {
      ...item,
      text: typeof assistantEvent.content === "string" ? assistantEvent.content : item.text,
      pendingComplete: true,
    };
  }
  next = putItem(next, item);
  const flushed = flushReadyItems(ctx, next, next.openMessageOrdinal, false);
  return {
    events: [
      ...(!item.pendingComplete || flushed.state.openItems[itemId]
        ? contentEvents(ctx, item, "running")
        : []),
      ...flushed.events,
    ],
    state: flushed.state,
  };
}

function mapTurnOutcome(
  ctx: CoreMapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): CoreResult {
  if (!isTurnState(frame.state)) return { events: [], state };
  const closed = closeOpenContent(ctx, state, undefined, frame.state === "failed");
  const turn = ctx.providerTurn;
  if (
    ctx.agentId !== undefined ||
    !turn ||
    ctx.runOrdinal === null ||
    (turn.status !== "pending" && turn.status !== "running")
  ) {
    return { events: closed.events, state: resetTurn(closed.state) };
  }
  const events: ProviderAdapterV2Event[] = [
    ...closed.events,
    {
      type: "provider_turn.updated",
      driver: ctx.provider,
      threadId: ctx.threadId,
      providerTurn: {
        ...turn,
        status: frame.state,
        completedAt: DateTime.makeUnsafe(ctx.now()),
        turnTokenUsage: tokenUsageFrom(closed.state),
        ...(closed.state.model ? { model: closed.state.model } : {}),
      },
    },
  ];
  if (frame.state === "failed") {
    events.push({
      type: "turn.terminal",
      driver: ctx.provider,
      providerThreadId: ctx.providerThreadId,
      providerTurnId: turn.id,
      runOrdinal: ctx.runOrdinal,
      status: "failed",
      failureItemOrdinal: ctx.itemOrdinal(scopedItemId(ctx, "terminal-failure")),
      failure: {
        class: "provider_error",
        message: (text(frame.errorMessage) ?? "NeoPi turn failed").slice(0, 4096),
        code: null,
        retryable: null,
      },
      threadDisposition: "reusable",
    });
  } else {
    events.push({
      type: "turn.terminal",
      driver: ctx.provider,
      providerThreadId: ctx.providerThreadId,
      providerTurnId: turn.id,
      runOrdinal: ctx.runOrdinal,
      status: frame.state,
      failure: null,
      threadDisposition: "reusable",
    });
  }
  return { events, state: resetTurn(closed.state) };
}

function mapSessionState(
  ctx: CoreMapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): CoreResult {
  const session = asRecord(frame.state) ?? frame;
  const model = modelSlug(session.model) ?? text(session.model) ?? state.model;
  const hasThinking = Object.prototype.hasOwnProperty.call(session, "thinkingLevel");
  const level = hasThinking ? text(session.thinkingLevel) : state.thinkingLevel;
  const refreshed = metadataRefresh(ctx, state, model, level, hasThinking && level === undefined);
  const context = asRecord(session.contextUsage);
  const usedTokens = nonNeg(context?.tokens);
  if (usedTokens === undefined) return refreshed;
  const maxTokens = positive(context?.contextWindow);
  const previous = refreshed.events.find((event) => event.type === "provider_thread.updated");
  return {
    events: [
      {
        type: "provider_thread.updated",
        driver: ctx.provider,
        providerThread: {
          ...(previous?.providerThread ?? ctx.providerThread),
          contextUsage: {
            usedTokens,
            ...(maxTokens !== undefined ? { maxTokens } : {}),
          },
          updatedAt: DateTime.makeUnsafe(ctx.now()),
        },
      },
    ],
    state: refreshed.state,
  };
}

function metadataRefresh(
  ctx: CoreMapCtx,
  state: CoreState,
  model: string | undefined,
  thinkingLevel: string | undefined,
  clearThinking: boolean,
): CoreResult {
  const next = { ...state, model, thinkingLevel: clearThinking ? undefined : thinkingLevel };
  const previous = ctx.providerThread.nativeMetadata?.modelSelection;
  const selectedModel = model ?? previous?.model;
  if (!selectedModel || (!model && !thinkingLevel && !clearThinking))
    return { events: [], state: next };
  const options = (previous?.options ?? []).filter(
    (option) => option.id !== "reasoningEffort" || (!clearThinking && thinkingLevel === undefined),
  );
  if (thinkingLevel !== undefined) options.push({ id: "reasoningEffort", value: thinkingLevel });
  return {
    events: [
      {
        type: "provider_thread.updated",
        driver: ctx.provider,
        providerThread: {
          ...ctx.providerThread,
          nativeMetadata: {
            ...ctx.providerThread.nativeMetadata,
            modelSelection: { instanceId: ctx.providerInstanceId, model: selectedModel, options },
            updatedAt: ctx.now(),
          },
          updatedAt: DateTime.makeUnsafe(ctx.now()),
        },
      },
    ],
    state: next,
  };
}

function mapCompactionStart(
  ctx: CoreMapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): CoreResult {
  if (state.compaction?.open) return { events: [], state };
  const compaction: CompactionTracker = {
    itemId: `neopi:compaction:${state.commandSeq + 1}`,
    startedAt: ctx.now(),
    open: true,
    settled: false,
    beforeTokens: undefined,
    afterTokens: undefined,
  };
  return {
    events: [compactionEvent(ctx, compaction, "running", text(frame.reason) ?? text(frame.action))],
    state: { ...state, commandSeq: state.commandSeq + 1, compaction },
  };
}

function settleCompaction(
  ctx: CoreMapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): CoreResult {
  const result = asRecord(frame.result);
  const beforeTokens =
    nonNeg(frame.beforeTokens) ??
    nonNeg(frame.tokensBefore) ??
    nonNeg(result?.tokensBefore) ??
    state.compaction?.beforeTokens;
  const afterTokens =
    nonNeg(frame.afterTokens) ??
    nonNeg(frame.tokensAfter) ??
    nonNeg(result?.tokensAfter) ??
    state.compaction?.afterTokens;
  const skipped = frame.skipped === true;
  const errorMessage = text(frame.errorMessage);
  const failed = frame.aborted === true || errorMessage !== undefined;
  const summary =
    text(frame.summary) ??
    text(result?.summary) ??
    text(result?.shortSummary) ??
    errorMessage ??
    (skipped ? "Compaction skipped" : undefined);
  const compaction: CompactionTracker = {
    itemId: state.compaction?.itemId ?? `neopi:compaction:${state.commandSeq + 1}`,
    startedAt: state.compaction?.startedAt ?? ctx.now(),
    open: false,
    settled: true,
    beforeTokens,
    afterTokens,
  };
  const alreadyClosed = state.compaction?.settled === true && !state.compaction.open;
  const changedCounts = !sameCompaction(state.compaction, beforeTokens, afterTokens);
  return {
    events:
      !alreadyClosed || changedCounts
        ? [
            compactionEvent(
              ctx,
              compaction,
              skipped ? "cancelled" : failed ? "failed" : "completed",
              summary,
            ),
          ]
        : [],
    state: {
      ...state,
      commandSeq: state.compaction ? state.commandSeq : state.commandSeq + 1,
      compaction,
    },
  };
}

function compactionEvent(
  ctx: CoreMapCtx,
  item: CompactionTracker,
  status: OrchestrationV2TurnItem["status"],
  summary?: string,
): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver: ctx.provider,
    turnItem: {
      ...nativeItemBase(ctx, item.itemId, status, "Context compaction", item.startedAt),
      type: "compaction",
      driver: ctx.provider,
      ...(summary ? { summary } : {}),
      ...(item.beforeTokens !== undefined ? { beforeTokenCount: item.beforeTokens } : {}),
      ...(item.afterTokens !== undefined ? { afterTokenCount: item.afterTokens } : {}),
    },
  };
}

function noticeEvent(
  ctx: CoreMapCtx,
  message: string,
  providerMetadata?: Record<string, unknown>,
): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver: ctx.provider,
    turnItem: {
      ...nativeItemBase(ctx, `notice:${ctx.newEventId()}`, "completed", null),
      type: "system_notice",
      message,
      ...(providerMetadata ? { providerMetadata } : {}),
    },
  };
}

function contentEvents(
  ctx: CoreMapCtx,
  item: OpenContentItem,
  status: OrchestrationV2TurnItem["status"],
): ProviderAdapterV2Event[] {
  const base = nativeItemBase(
    ctx,
    item.itemId,
    status,
    item.itemType === "reasoning" ? "Thinking" : "Assistant",
    item.startedAt,
  );
  const streaming = status === "running";
  if (item.itemType === "reasoning") {
    return [
      {
        type: "turn_item.updated",
        driver: ctx.provider,
        turnItem: { ...base, type: "reasoning", text: item.text, streaming },
      },
    ];
  }
  const messageId = MessageId.make(scopedItemId(ctx, item.itemId));
  return [
    {
      type: "message.updated",
      driver: ctx.provider,
      message: {
        id: messageId,
        threadId: ctx.threadId,
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        role: "assistant",
        text: item.text,
        attachments: [],
        streaming,
        createdAt: DateTime.makeUnsafe(item.startedAt),
        updatedAt: DateTime.makeUnsafe(ctx.now()),
        createdBy: "agent",
        creationSource: "provider",
      },
    },
    {
      type: "turn_item.updated",
      driver: ctx.provider,
      turnItem: { ...base, type: "assistant_message", messageId, text: item.text, streaming },
    },
  ];
}

function closeOpenContent(
  ctx: CoreMapCtx,
  state: CoreState,
  ordinal: number | undefined,
  failed: boolean,
): CoreResult {
  const openItems = Object.values(state.openItems).map((item) =>
    ordinal !== undefined && item.ordinal !== ordinal
      ? item
      : { ...item, pendingComplete: true, failed: failed || item.failed },
  );
  let next = state;
  for (const item of openItems) next = putItem(next, item);
  const flushed = flushReadyItems(ctx, next, ordinal, true);
  return {
    events: flushed.events,
    state: { ...flushed.state, openMessageOrdinal: undefined },
  };
}

function flushReadyItems(
  ctx: CoreMapCtx,
  state: CoreState,
  ordinal: number | undefined,
  force: boolean,
): CoreResult {
  const items = Object.values(state.openItems).filter(
    (item) => ordinal === undefined || item.ordinal === ordinal,
  );
  const reasoningOpen = items.some(
    (item) => item.itemType === "reasoning" && !item.pendingComplete,
  );
  const ready = items
    .filter((item) => item.pendingComplete || force)
    .filter((item) => force || item.itemType === "reasoning" || !reasoningOpen)
    .sort((left, right) =>
      left.itemType === right.itemType
        ? left.contentIndex - right.contentIndex
        : left.itemType === "reasoning"
          ? -1
          : 1,
    );
  const events: ProviderAdapterV2Event[] = [];
  if (ready.length === 0) return { events, state };
  const openItems = { ...state.openItems };
  for (const item of ready) {
    events.push(...contentEvents(ctx, item, item.failed ? "failed" : "completed"));
    delete openItems[item.itemId];
  }
  return { events, state: { ...state, openItems } };
}

function openAssistant(state: CoreState, message: Record<string, unknown> | undefined): CoreState {
  const ordinal = state.nextMessageOrdinal;
  return {
    ...state,
    nextMessageOrdinal: ordinal + 1,
    openMessageOrdinal: ordinal,
    messages: [
      ...state.messages,
      { ordinal, signature: message ? signatureOf(message) : "", hasUsage: false, terminal: false },
    ],
  };
}

function ensureOpenAssistant(
  state: CoreState,
  message: Record<string, unknown> | undefined,
): CoreState {
  return state.openMessageOrdinal !== undefined ? state : openAssistant(state, message);
}

function noteUsage(
  state: CoreState,
  ordinal: number | undefined,
  message: Record<string, unknown>,
  terminal: boolean,
): CoreState {
  if (ordinal === undefined) return state;
  const usage = readUsage(message);
  const existing = state.messages.find((entry) => entry.ordinal === ordinal);
  if (!existing) return state;
  if (existing.hasUsage) {
    return terminal && !existing.terminal
      ? replaceMessage(state, { ...existing, terminal: true })
      : state;
  }
  if (!usage) {
    if (!terminal || existing.terminal) return state;
    return {
      ...replaceMessage(state, {
        ...existing,
        terminal: true,
        signature: existing.signature || signatureOf(message),
      }),
      usage: { ...state.usage, withoutUsage: state.usage.withoutUsage + 1 },
    };
  }
  const wasLacking = existing.terminal;
  return {
    ...replaceMessage(state, {
      ...existing,
      hasUsage: true,
      terminal: terminal || existing.terminal,
      signature: signatureOf(message) || existing.signature,
    }),
    usage: addUsage(state.usage, usage, wasLacking),
  };
}

function rememberSignature(
  state: CoreState,
  ordinal: number | undefined,
  signature: string,
): CoreState {
  if (ordinal === undefined || signature.length === 0) return state;
  const existing = state.messages.find((entry) => entry.ordinal === ordinal);
  if (!existing || existing.signature === signature) return state;
  return replaceMessage(state, { ...existing, signature });
}

function pairAgentEndMessages(
  state: CoreState,
  messages: ReadonlyArray<Record<string, unknown>>,
): CoreState {
  const existing = state.messages;
  const matched = new Set<number>();
  const pairs: Array<number | undefined> = messages.map(() => undefined);
  // Match stable message identities first; repeated signatures still consume distinct ordinals.
  messages.forEach((message, index) => {
    const signature = signatureOf(message);
    if (!signature) return;
    const match = existing.findIndex(
      (entry, candidate) => !matched.has(candidate) && entry.signature === signature,
    );
    if (match < 0) return;
    matched.add(match);
    pairs[index] = existing[match]?.ordinal;
  });
  // Native compact terminal frames can contain only a suffix of the streamed messages.
  // Preserve the original indices while matching leftovers; never splice the candidates.
  const offset = Math.max(0, existing.length - messages.length);
  messages.forEach((_, index) => {
    if (pairs[index] !== undefined) return;
    const preferred = messages.length < existing.length ? index + offset : index;
    const candidate = !matched.has(preferred)
      ? preferred
      : existing.findIndex((entry, position) => position >= offset && !matched.has(position));
    if (candidate < 0 || candidate >= existing.length) return;
    matched.add(candidate);
    pairs[index] = existing[candidate]?.ordinal;
  });
  let next = state;
  messages.forEach((message, index) => {
    const ordinal = pairs[index];
    if (ordinal !== undefined) {
      next = noteUsage(next, ordinal, message, true);
      return;
    }
    next = openAssistant(next, message);
    next = noteUsage(next, next.openMessageOrdinal, message, true);
  });
  return { ...next, openMessageOrdinal: state.openMessageOrdinal };
}

function addUsage(totals: UsageTotals, usage: ParsedUsage, wasLacking: boolean): UsageTotals {
  return {
    inputTokens: totals.inputTokens + usage.input + usage.cacheRead + usage.cacheWrite,
    cachedInputTokens: totals.cachedInputTokens + usage.cacheRead,
    cacheCreationTokens: totals.cacheCreationTokens + usage.cacheWrite,
    outputTokens: totals.outputTokens + usage.output,
    reasoningTokens: totals.reasoningTokens + (usage.reasoning ?? 0),
    sawReasoning: totals.sawReasoning || usage.reasoning !== undefined,
    totalCostUsd: totals.totalCostUsd + (usage.costTotal ?? 0),
    sawCost: totals.sawCost || usage.costTotal !== undefined,
    withUsage: totals.withUsage + 1,
    withoutUsage: wasLacking ? Math.max(0, totals.withoutUsage - 1) : totals.withoutUsage,
  };
}

function tokenUsageFrom(state: CoreState): TurnTokenUsage {
  const common = {
    usageScope: "main_agent" as const,
    hasSubagents: state.hasSubagents,
    ...(state.usage.withUsage > 0
      ? {
          cachedInputTokens: state.usage.cachedInputTokens,
          cacheCreationTokens: state.usage.cacheCreationTokens,
          ...(state.usage.sawReasoning ? { reasoningTokens: state.usage.reasoningTokens } : {}),
        }
      : {}),
  };
  if (state.usage.withUsage === 0) {
    return { ...common, usageStatus: "unavailable" };
  }
  if (state.usage.withoutUsage > 0) {
    return {
      ...common,
      usageStatus: "partial",
      inputTokens: state.usage.inputTokens,
      outputTokens: state.usage.outputTokens,
    };
  }
  return {
    ...common,
    usageStatus: "complete",
    inputTokens: state.usage.inputTokens,
    outputTokens: state.usage.outputTokens,
  };
}

function resetTurn(state: CoreState): CoreState {
  return {
    ...state,
    turnStarted: false,
    openMessageOrdinal: undefined,
    messages: [],
    openItems: {},
    usage: EMPTY_USAGE,
    hasSubagents: false,
  };
}

function replaceMessage(state: CoreState, message: AssistantMessageRecord): CoreState {
  return {
    ...state,
    messages: state.messages.map((entry) => (entry.ordinal === message.ordinal ? message : entry)),
  };
}

function putItem(state: CoreState, item: OpenContentItem | undefined): CoreState {
  if (!item) return state;
  return { ...state, openItems: { ...state.openItems, [item.itemId]: item } };
}

function contentItemId(ordinal: number, kind: "text" | "thinking", contentIndex: number): string {
  return `neopi:m${ordinal}:${kind}:${contentIndex}`;
}

function contentKind(type: string): "text" | "thinking" | undefined {
  if (type.startsWith("text_")) return "text";
  if (type.startsWith("thinking_")) return "thinking";
  return undefined;
}

function contentIndexOf(event: Record<string, unknown>): number {
  return nonNeg(event.contentIndex) ?? 0;
}

function signatureOf(message: Record<string, unknown>): string {
  const usage = asRecord(message.usage);
  const body = {
    timestamp: message.timestamp ?? null,
    responseId: message.responseId ?? null,
    provider: message.provider ?? null,
    model: message.model ?? null,
    text: contentFingerprint(message.content),
    input: usage?.input ?? null,
    output: usage?.output ?? null,
    cacheRead: usage?.cacheRead ?? null,
    cacheWrite: usage?.cacheWrite ?? null,
  };
  const empty =
    body.timestamp === null &&
    body.responseId === null &&
    body.provider === null &&
    body.model === null &&
    body.text === "" &&
    body.input === null;
  return empty ? "" : JSON.stringify(body);
}

function contentFingerprint(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      if (!record) return "";
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "thinking" && typeof record.thinking === "string") return record.thinking;
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function readUsage(message: Record<string, unknown>): ParsedUsage | undefined {
  const usage = asRecord(message.usage);
  if (!usage) return undefined;
  const input = nonNeg(usage.input);
  const output = nonNeg(usage.output);
  const cacheRead = nonNeg(usage.cacheRead);
  const cacheWrite = nonNeg(usage.cacheWrite);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    input: input ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    output: output ?? 0,
    reasoning: nonNeg(usage.reasoningTokens),
    costTotal: readCost(usage.cost),
  };
}

function readCost(cost: unknown): number | undefined {
  const record = asRecord(cost);
  const total = record?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> {
  return asRecord(value)?.role === "assistant";
}

function modelSlug(model: unknown): string | undefined {
  const record = asRecord(model);
  if (!record) return undefined;
  const provider = text(record.provider);
  const id = text(record.id) ?? text(record.modelId);
  if (provider && id) return `${provider}/${id}`;
  return id;
}

function noticeDetail(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  const detail: Record<string, unknown> = {};
  if (typeof frame.level === "string") detail.level = frame.level;
  const source = text(frame.source);
  if (source) detail.source = source;
  return Object.keys(detail).length > 0 ? detail : undefined;
}

function errorText(error: unknown): string {
  const direct = text(error);
  if (direct) return direct;
  const record = asRecord(error);
  return text(record?.message) ?? text(record?.error) ?? "NeoPi extension error";
}

function sameCompaction(
  tracker: CompactionTracker | undefined,
  beforeTokens: number | undefined,
  afterTokens: number | undefined,
): boolean {
  if (!tracker?.settled) return false;
  return tracker.beforeTokens === beforeTokens && tracker.afterTokens === afterTokens;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function positive(value: unknown): number | undefined {
  const parsed = nonNeg(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function isTurnState(value: unknown): value is TurnState {
  return typeof value === "string" && (TURN_STATES as ReadonlyArray<string>).includes(value);
}
