import { PlanId } from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { isRecord, type NeoPiInteractionMode } from "effect-neopi-rpc/schema";
import { NEOPI_CAPABILITIES } from "../NeoPiCompatibility.ts";
import { nativeItemBase, scopedItemId, type MapCtx } from "./MapCtx.ts";

export function neoPiInteractionModeFromFrame(frame: unknown): NeoPiInteractionMode | undefined {
  if (!isRecord(frame)) return undefined;
  if (frame.type === "mode_changed") {
    return frame.mode === "default" || frame.mode === "plan" ? frame.mode : undefined;
  }
  if (frame.type !== "t3.state" || !isRecord(frame.state)) return undefined;
  return frame.state.mode === "default" || frame.state.mode === "plan"
    ? frame.state.mode
    : undefined;
}

export function mapPlanProposal(
  ctx: MapCtx,
  frame: unknown,
  capabilities: ReadonlySet<string>,
): {
  readonly events: ReadonlyArray<ProviderAdapterV2Event>;
  readonly proposal?: { readonly id: string; readonly planMarkdown: string };
} {
  if (!capabilities.has(NEOPI_CAPABILITIES.setMode) || !isRecord(frame)) return { events: [] };
  if (
    frame.type !== "plan_proposal_request" ||
    typeof frame.id !== "string" ||
    frame.id.length === 0 ||
    typeof frame.planMarkdown !== "string" ||
    frame.planMarkdown.trim().length === 0
  )
    return { events: [] };

  const planMarkdown = frame.planMarkdown.trim();
  const nativeId = `plan:${frame.id}`;
  const planId = PlanId.make(scopedItemId(ctx, nativeId));
  return {
    events: [
      {
        type: "plan.updated",
        driver: ctx.provider,
        plan: {
          id: planId,
          threadId: ctx.threadId,
          runId: ctx.runId,
          nodeId: ctx.nodeId,
          kind: "proposed_plan",
          status: "draft",
          markdown: planMarkdown,
        },
      },
      {
        type: "turn_item.updated",
        driver: ctx.provider,
        turnItem: {
          ...nativeItemBase(ctx, nativeId, "completed", "Proposed plan"),
          type: "proposed_plan",
          planId,
          markdown: planMarkdown,
          streaming: false,
        },
      },
    ],
    proposal: { id: frame.id, planMarkdown },
  };
}
