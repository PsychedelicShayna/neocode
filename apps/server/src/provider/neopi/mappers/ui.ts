import {
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderRequestKind,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import type { UiResponseWire } from "effect-neopi-rpc/schema";
import * as DateTime from "effect/DateTime";
import { NEOPI_CAPABILITIES } from "../NeoPiCompatibility.ts";
import { nativeItemBase, scopedItemId, type CoreMapCtx } from "./MapCtx.ts";
import { approvalRequestType, parseApprovalPrompt } from "./approvalPrompt.ts";

export const NEOPI_CAP_TOOL_APPROVAL = NEOPI_CAPABILITIES.toolApprovalRequest;

export type UiReply =
  | { readonly _tag: "ExtensionUi"; readonly frame: UiResponseWire }
  | {
      readonly _tag: "ToolApproval";
      readonly frame: {
        readonly type: "tool_approval_response";
        readonly id: string;
        readonly decision: "allow_once" | "allow_session" | "deny";
      };
    };

/** Commit a prepared reply only after the native wire accepts it. */
export interface PendingUi {
  readonly requestId: RuntimeRequestId;
  readonly nativeId: string;
  readonly kind: "approval" | "user-input";
  readonly reply: (answer: ProviderApprovalDecision | Record<string, unknown>) => UiReply;
  readonly settle: (answer: ProviderApprovalDecision | Record<string, unknown>) => void;
}

interface OpenUi {
  readonly nativeId: string;
  readonly kind: PendingUi["kind"];
  readonly request: OrchestrationV2RuntimeRequest;
  readonly item: OrchestrationV2TurnItem;
}

interface Settlement {
  readonly opened: OpenUi;
  readonly answers?: Record<string, unknown>;
  readonly decision?: ProviderApprovalDecision;
}

export interface UiState {
  readonly capabilities: Set<string>;
  planMode?: "plan" | "default";
  nextRequest: number;
  readonly inFlightTools: Record<string, { readonly toolName: string; readonly args: unknown }>;
  readonly open: Map<string, OpenUi>;
  readonly settlements: Settlement[];
}

export function emptyUiState(): UiState {
  return {
    capabilities: new Set(),
    nextRequest: 0,
    inFlightTools: {},
    open: new Map(),
    settlements: [],
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonempty(value: unknown): string | undefined {
  return text(value)?.trim() || undefined;
}

function timeoutSuffix(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? `\nTimeout: ${value}ms`
    : "";
}

function notice(
  ctx: CoreMapCtx,
  message: string,
  providerMetadata?: Record<string, unknown>,
): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver: ctx.provider,
    turnItem: {
      ...nativeItemBase(ctx, `ui-notice:${ctx.newEventId()}`, "completed", null),
      type: "system_notice",
      message,
      ...(providerMetadata ? { providerMetadata } : {}),
    },
  };
}

function requestEvents(ctx: CoreMapCtx, opened: OpenUi): ProviderAdapterV2Event[] {
  return [
    {
      type: "runtime_request.updated",
      driver: ctx.provider,
      threadId: ctx.threadId,
      runtimeRequest: opened.request,
    },
    { type: "turn_item.updated", driver: ctx.provider, turnItem: opened.item },
  ];
}

function openRequest(
  ctx: CoreMapCtx,
  state: UiState,
  nativeId: string,
  content:
    | {
        readonly kind: "approval";
        readonly requestKind: ProviderRequestKind;
        readonly prompt: string;
        readonly sessionApproval: boolean;
        readonly toolCallId?: string;
      }
    | { readonly kind: "user-input"; readonly question: OrchestrationV2UserInputQuestion },
): OpenUi {
  const nativeItemId = `ui:${nativeId}#${++state.nextRequest}`;
  const requestId = RuntimeRequestId.make(scopedItemId(ctx, nativeItemId));
  const parentItemId =
    content.kind === "approval" && content.toolCallId
      ? TurnItemId.make(scopedItemId(ctx, content.toolCallId))
      : ctx.parentItemId;
  const base = nativeItemBase(
    { ...ctx, ...(parentItemId ? { parentItemId } : {}) },
    nativeItemId,
    "waiting",
    null,
  );
  const item: OrchestrationV2TurnItem =
    content.kind === "approval"
      ? {
          ...base,
          type: "approval_request",
          requestId,
          requestKind: content.requestKind,
          prompt: content.prompt,
          options: [
            { decision: "accept", label: "Approve" },
            ...(content.sessionApproval
              ? [{ decision: "acceptForSession" as const, label: "Always allow this session" }]
              : []),
            { decision: "decline", label: "Deny" },
          ],
        }
      : { ...base, type: "user_input_request", requestId, questions: [content.question] };
  const opened: OpenUi = {
    nativeId,
    kind: content.kind,
    item,
    request: {
      id: requestId,
      nodeId: ctx.nodeId,
      providerTurnId: ctx.providerTurnId,
      nativeRequestRef: { driver: ctx.provider, nativeId, strength: "strong" },
      kind: content.kind === "approval" ? content.requestKind : "user_input",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: ctx.providerSessionId },
      createdAt: DateTime.makeUnsafe(ctx.now()),
      resolvedAt: null,
    },
  };
  state.open.set(nativeId, opened);
  return opened;
}

function settleEvents(
  ctx: CoreMapCtx,
  opened: OpenUi,
  settlement: Omit<Settlement, "opened">,
  cancelled = false,
): ProviderAdapterV2Event[] {
  const now = DateTime.makeUnsafe(ctx.now());
  return requestEvents(ctx, {
    ...opened,
    request: {
      ...opened.request,
      status: cancelled ? "cancelled" : "resolved",
      resolvedAt: now,
      ...(settlement.decision ? { decision: settlement.decision } : {}),
      ...(settlement.answers ? { answers: settlement.answers } : {}),
    },
    item: {
      ...opened.item,
      status: cancelled ? "cancelled" : "completed",
      completedAt: now,
      updatedAt: now,
    },
  });
}

/** Flush committed wire replies; a cancelled or replaced request cannot settle a newer one. */
export function flushUiSettlements(ctx: CoreMapCtx, state: UiState): ProviderAdapterV2Event[] {
  const events: ProviderAdapterV2Event[] = [];
  for (const settlement of state.settlements.splice(0)) {
    const opened = settlement.opened;
    if (state.open.get(opened.nativeId) !== opened) continue;
    state.open.delete(opened.nativeId);
    events.push(...settleEvents(ctx, opened, settlement));
  }
  return events;
}

function pending(state: UiState, opened: OpenUi, reply: PendingUi["reply"]): PendingUi {
  return {
    requestId: opened.request.id,
    nativeId: opened.nativeId,
    kind: opened.kind,
    reply,
    settle(answer) {
      if (state.open.get(opened.nativeId) !== opened) return;
      state.settlements.push({
        opened,
        ...(typeof answer === "string" ? { decision: answer } : { answers: answer }),
      });
    },
  };
}

export function mapUiRequest(
  ctx: CoreMapCtx,
  frame: unknown,
  state: UiState,
): { events: ProviderAdapterV2Event[]; state: UiState; pending?: PendingUi } {
  const events = flushUiSettlements(ctx, state);
  const data = record(frame);
  const type = data?.type;
  if (!data) return { events, state };
  if (type === "ready") {
    if (Array.isArray(data.capabilities)) {
      state.capabilities.clear();
      for (const cap of data.capabilities) if (typeof cap === "string") state.capabilities.add(cap);
    }
    return { events, state };
  }
  if (type === "t3.state" || type === "chat_mode_changed" || type === "mode_changed") {
    const chatMode = type === "t3.state" ? record(data.state)?.chatMode : data.mode;
    if (
      (type === "t3.state" || type === "chat_mode_changed") &&
      (chatMode === "off" || chatMode === "chat" || chatMode === "erp" || chatMode === "raw")
    ) {
      events.push(
        notice(ctx, `NeoPi chat mode: ${chatMode}`, {
          neopiUi: { kind: "chat-mode", mode: chatMode },
        }),
      );
    }
    const planMode = type === "t3.state" ? record(data.state)?.mode : data.mode;
    if (
      (type === "t3.state" || type === "mode_changed") &&
      (planMode === "default" || planMode === "plan") &&
      state.planMode !== planMode
    ) {
      state.planMode = planMode;
      events.push(
        notice(ctx, `NeoPi native plan mode: ${planMode}`, {
          neopiUi: { kind: "plan-mode", mode: planMode },
        }),
      );
    }
    return { events, state };
  }
  if (type === "tool_execution_start") {
    const id = nonempty(data.toolCallId);
    const toolName = nonempty(data.toolName);
    if (id && toolName) state.inFlightTools[id] = { toolName, args: data.args };
    return { events, state };
  }
  if (type === "tool_execution_end") {
    const id = nonempty(data.toolCallId);
    if (id) delete state.inFlightTools[id];
    return { events, state };
  }
  if (
    type === "tool_approval_cancel" ||
    (type === "extension_ui_request" && data.method === "cancel")
  ) {
    const target = nonempty(data.targetId);
    const opened = target ? state.open.get(target) : undefined;
    if (!opened) {
      events.push(
        notice(ctx, `Ignored NeoPi UI cancel for unknown request ${target ?? "(missing target)"}`),
      );
    } else {
      state.open.delete(opened.nativeId);
      events.push(...settleEvents(ctx, opened, {}, true));
    }
    return { events, state };
  }
  const id = nonempty(data.id);
  if (!id || state.open.has(id)) return { events, state };
  if (type === "tool_approval_request") {
    if (!state.capabilities.has(NEOPI_CAP_TOOL_APPROVAL)) return { events, state };
    const toolName = nonempty(data.toolName);
    if (!toolName) return { events, state };
    const toolCallId = nonempty(data.toolCallId);
    const details = Array.isArray(data.details)
      ? data.details.filter(
          (detail): detail is string => typeof detail === "string" && detail.length > 0,
        )
      : [];
    const opened = openRequest(ctx, state, id, {
      kind: "approval",
      requestKind: approvalRequestType(toolName),
      sessionApproval: true,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      prompt:
        [
          `Allow tool: ${toolName}`,
          ...(nonempty(data.reason) ? [`Reason: ${data.reason}`] : []),
          ...details,
          ...(Object.hasOwn(data, "args") ? [`Arguments: ${JSON.stringify(data.args)}`] : []),
        ].join("\n") + timeoutSuffix(data.timeout),
    });
    events.push(...requestEvents(ctx, opened));
    return {
      events,
      state,
      pending: pending(state, opened, (answer) => ({
        _tag: "ToolApproval",
        frame: {
          type: "tool_approval_response",
          id,
          decision:
            answer === "accept"
              ? "allow_once"
              : answer === "acceptForSession" || answer === "acceptAlways"
                ? "allow_session"
                : "deny",
        },
      })),
    };
  }
  if (type !== "extension_ui_request") return { events, state };
  const method = data.method;
  if (method === "select" || method === "input" || method === "editor" || method === "confirm") {
    const title = nonempty(data.title) ?? method;
    const options = Array.isArray(data.options)
      ? data.options.filter((option): option is string => typeof option === "string")
      : [];
    const approval = method === "select" ? parseApprovalPrompt(title, options) : undefined;
    if (approval) {
      const matches = Object.entries(state.inFlightTools).filter(
        ([, tool]) => tool.toolName === approval.toolName,
      );
      const tool = matches.length === 1 ? matches[0] : undefined;
      const opened = openRequest(ctx, state, id, {
        kind: "approval",
        requestKind: approval.requestType,
        sessionApproval: false,
        prompt:
          approval.detail +
          (tool ? `\nArguments: ${JSON.stringify(tool[1].args)}` : "") +
          timeoutSuffix(data.timeout),
        ...(tool ? { toolCallId: tool[0] } : {}),
      });
      events.push(...requestEvents(ctx, opened));
      return {
        events,
        state,
        pending: pending(state, opened, (answer) => ({
          _tag: "ExtensionUi",
          frame: {
            id,
            value:
              answer === "accept" || answer === "acceptForSession" || answer === "acceptAlways"
                ? "Approve"
                : "Deny",
          },
        })),
      };
    }
    const descriptions = Array.isArray(data.optionDetails) ? data.optionDetails : [];
    const questionOptions =
      method === "confirm"
        ? [
            { label: "Yes", description: "Yes", value: "true" },
            { label: "No", description: "No", value: "false" },
          ]
        : options.flatMap((option, index) => {
            const label = nonempty(option);
            return label
              ? [
                  {
                    label,
                    description: nonempty(record(descriptions[index])?.description) ?? label,
                    value: option,
                  },
                ]
              : [];
          });
    const prefill = method === "editor" ? text(data.prefill) : undefined;
    const opened = openRequest(ctx, state, id, {
      kind: "user-input",
      question: {
        id,
        header: title,
        question:
          (method === "confirm" ? (nonempty(data.message) ?? title) : title) +
          timeoutSuffix(data.timeout),
        options: questionOptions,
        allowCustomAnswer: method !== "select" && method !== "confirm",
        multiSelect: false,
        ...(prefill !== undefined ? { initialAnswer: prefill } : {}),
      },
    });
    events.push(...requestEvents(ctx, opened));
    return {
      events,
      state,
      pending: pending(state, opened, (answer) => {
        const first = record(answer)?.[id];
        const response: UiResponseWire =
          first === undefined
            ? { id, cancelled: true }
            : method === "confirm"
              ? { id, confirmed: first === true || first === "true" }
              : { id, value: String(first) };
        return { _tag: "ExtensionUi", frame: response };
      }),
    };
  }
  if (method === "notify") {
    const message = nonempty(data.message);
    if (message)
      events.push(notice(ctx, message, { neopiUi: { kind: "notice", level: data.notifyType } }));
  } else if (method === "setStatus") {
    const key = nonempty(data.statusKey);
    if (key)
      events.push(
        notice(ctx, nonempty(data.statusText) ?? `NeoPi status ${key} cleared`, {
          neopiUi: { kind: "status", key, text: text(data.statusText) ?? "" },
        }),
      );
  } else if (method === "setWidget") {
    const key = nonempty(data.widgetKey);
    const lines = Array.isArray(data.widgetLines)
      ? data.widgetLines.filter((line): line is string => typeof line === "string")
      : [];
    if (key)
      events.push(
        notice(ctx, lines.join("\n") || `NeoPi widget ${key} cleared`, {
          neopiUi: { kind: "widget", key, lines },
        }),
      );
  } else if (method === "set_editor_text") {
    if (typeof data.text === "string")
      events.push(
        notice(ctx, "NeoPi suggested composer text", {
          neopiUi: { kind: "editor", text: data.text },
        }),
      );
  } else if (method === "open_url") {
    events.push(
      notice(ctx, nonempty(data.instructions) ?? "Open URL", {
        url: data.url,
        ...(data.launchUrl ? { launchUrl: data.launchUrl } : {}),
      }),
    );
  } else if (method === "setTitle") {
    const title = nonempty(data.title);
    events.push(
      title
        ? {
            type: "provider_thread.updated",
            driver: ctx.provider,
            providerThread: {
              ...ctx.providerThread,
              nativeMetadata: { ...ctx.providerThread.nativeMetadata, title, updatedAt: ctx.now() },
              updatedAt: DateTime.makeUnsafe(ctx.now()),
            },
          }
        : notice(ctx, "Ignored empty NeoPi title"),
    );
  }
  return { events, state };
}
