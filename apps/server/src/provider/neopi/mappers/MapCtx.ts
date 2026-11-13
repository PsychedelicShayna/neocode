import {
  TurnItemId,
  type NodeId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface MapCtx {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionKey?: string;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId | null;
  readonly runId: RunId | null;
  readonly nodeId: NodeId;
  readonly itemOrdinal: (id: string) => number;
  readonly agentId?: string;
  readonly parentToolUseId?: string;
  readonly parentItemId?: TurnItemId;
  readonly now: () => string;
  readonly newEventId: () => string;
}

export interface CoreMapCtx extends MapCtx {
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurn: OrchestrationV2ProviderTurn | null;
  readonly runOrdinal: number | null;
}

/** Keep native IDs stable inside a session, but never reuse them across sessions or turns. */
export function scopedItemId(ctx: MapCtx, nativeId: string): string {
  return `neopi:${JSON.stringify([
    ctx.providerInstanceId,
    ctx.sessionKey ?? null,
    ctx.threadId,
    ctx.turnId ?? null,
    ctx.agentId ?? null,
    nativeId,
  ])}`;
}

export function nativeItemBase(
  ctx: MapCtx,
  nativeId: string,
  status: OrchestrationV2TurnItem["status"],
  title: string | null,
  startedAt: string = ctx.now(),
) {
  const id = scopedItemId(ctx, nativeId);
  const now = DateTime.makeUnsafe(ctx.now());
  return {
    id: TurnItemId.make(id),
    threadId: ctx.threadId,
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    providerThreadId: ctx.providerThreadId,
    providerTurnId: ctx.providerTurnId,
    nativeItemRef: { driver: ctx.provider, nativeId, strength: "strong" as const },
    parentItemId: ctx.parentItemId ?? null,
    ordinal: ctx.itemOrdinal(id),
    status,
    title,
    startedAt: DateTime.makeUnsafe(startedAt),
    completedAt:
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "interrupted"
        ? now
        : null,
    updatedAt: now,
  };
}
