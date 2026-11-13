import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId, TurnId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const NeoPiResumeCursor = Schema.Struct({
  v: Schema.Literal(1),
  sessionFile: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  sessionDir: TrimmedNonEmptyString,
  // Shared storage requires the cooperating native lease on every reopen.
  sharedSession: Schema.optional(Schema.Boolean),
  historyLeafId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  turnBoundaries: Schema.Array(
    Schema.Union([
      Schema.Struct({ turnId: TurnId, userEntryId: TrimmedNonEmptyString }),
      Schema.Struct({ turnId: TurnId, kind: Schema.Literals(["local", "unknown"]) }),
      Schema.Struct({
        turnId: TurnId,
        kind: Schema.Literal("continuation"),
        afterEntryId: TrimmedNonEmptyString,
      }),
    ]),
  ),
});
export type NeoPiResumeCursor = typeof NeoPiResumeCursor.Type;

export const NeoPiSessionHandoffInput = Schema.Struct({ threadId: ThreadId });
export type NeoPiSessionHandoffInput = typeof NeoPiSessionHandoffInput.Type;
export const NeoPiSessionHandoffResult = Schema.Struct({
  sessionFile: Schema.String,
  sessionId: Schema.String,
  cwd: Schema.String,
  command: Schema.String,
});
export type NeoPiSessionHandoffResult = typeof NeoPiSessionHandoffResult.Type;
export const NeoPiSessionConfigurationInput = Schema.Struct({ threadId: ThreadId });
export type NeoPiSessionConfigurationInput = typeof NeoPiSessionConfigurationInput.Type;
export const NeoPiSessionConfigurationResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("available"),
    providerInstanceId: ProviderInstanceId,
    sessionId: Schema.String,
    attachment: Schema.Literals(["terminal", "owned"]),
    model: Schema.NullOr(
      Schema.Struct({
        provider: Schema.String,
        id: Schema.String,
        name: Schema.NullOr(Schema.String),
      }),
    ),
    thinkingLevel: Schema.NullOr(Schema.String),
    activeRole: Schema.NullOr(Schema.String),
    observedAt: IsoDateTime,
    telemetry: Schema.optional(
      Schema.Struct({
        tokensPerSecond: Schema.NullOr(Schema.Number),
        context: Schema.NullOr(
          Schema.Struct({
            tokens: Schema.NullOr(Schema.Number),
            contextWindow: Schema.Number,
            percent: Schema.NullOr(Schema.Number),
          }),
        ),
        sessionUsage: Schema.NullOr(
          Schema.Struct({
            input: Schema.Number,
            cacheRead: Schema.Number,
            cacheWrite: Schema.Number,
            cost: Schema.Number,
            subagentCost: Schema.Number,
            advisorCost: Schema.Number,
            advisorCostState: Schema.Literals(["ready", "restoring", "unavailable"]),
          }),
        ),
        approvalMode: Schema.NullOr(Schema.Literals(["always-ask", "write", "yolo"])),
      }),
    ),
    roles: Schema.Union([
      Schema.Struct({ status: Schema.Literal("unsupported"), reason: Schema.String }),
      Schema.Struct({
        status: Schema.Literal("available"),
        items: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            alias: Schema.String,
            name: Schema.String,
            configured: Schema.NullOr(Schema.String),
            patterns: Schema.Array(Schema.String),
            resolved: Schema.NullOr(
              Schema.Struct({
                provider: Schema.String,
                modelId: Schema.String,
                thinkingLevel: Schema.NullOr(Schema.String),
              }),
            ),
            hidden: Schema.Boolean,
          }),
        ),
      }),
    ]),
  }),
]);
export type NeoPiSessionConfigurationResult = typeof NeoPiSessionConfigurationResult.Type;
export class NeoPiSessionError extends Schema.TaggedError<NeoPiSessionError>()(
  "NeoPiSessionError",
  {
    operation: Schema.Literals(["handoff", "configuration"]),
    message: Schema.String,
  },
) {}
