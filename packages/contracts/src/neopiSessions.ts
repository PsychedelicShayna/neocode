import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const NeoPiSessionScope = Schema.Literals(["project", "all"]);
export type NeoPiSessionScope = typeof NeoPiSessionScope.Type;
export const NeoPiSessionListInput = Schema.Struct({
  projectId: ProjectId,
  scope: NeoPiSessionScope,
});
export type NeoPiSessionListInput = typeof NeoPiSessionListInput.Type;
export const NeoPiSessionOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("neocode"), threadId: ThreadId }),
  Schema.Struct({
    kind: Schema.Literal("process"),
    pid: NonNegativeInt,
    attachable: Schema.Boolean,
  }),
]);
export type NeoPiSessionOwner = typeof NeoPiSessionOwner.Type;
export const NeoPiSessionSummary = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionId: Schema.String,
  sessionFile: Schema.String,
  cwd: Schema.String,
  title: Schema.NullOr(Schema.String),
  firstMessage: Schema.String,
  createdAt: IsoDateTime,
  modifiedAt: IsoDateTime,
  messageCount: NonNegativeInt,
  owner: NeoPiSessionOwner,
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
});
export type NeoPiSessionSummary = typeof NeoPiSessionSummary.Type;
export const NeoPiSessionDiagnostic = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  message: Schema.String,
});
export type NeoPiSessionDiagnostic = typeof NeoPiSessionDiagnostic.Type;
export const NeoPiSessionListResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    sessions: Schema.Array(NeoPiSessionSummary),
    diagnostics: Schema.Array(NeoPiSessionDiagnostic),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.String,
    diagnostics: Schema.Array(NeoPiSessionDiagnostic),
  }),
]);
export type NeoPiSessionListResult = typeof NeoPiSessionListResult.Type;
export const NeoPiSessionResumeInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionFile: Schema.String,
  projectId: ProjectId,
});
export type NeoPiSessionResumeInput = typeof NeoPiSessionResumeInput.Type;
export const NeoPiSessionResumeResult = Schema.Struct({
  threadId: ThreadId,
  created: Schema.Boolean,
});
export type NeoPiSessionResumeResult = typeof NeoPiSessionResumeResult.Type;
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
    telemetry: Schema.optional(Schema.Struct({
      tokensPerSecond: Schema.NullOr(Schema.Number),
      context: Schema.NullOr(Schema.Struct({
        tokens: Schema.NullOr(Schema.Number),
        contextWindow: Schema.Number,
        percent: Schema.NullOr(Schema.Number),
      })),
      sessionUsage: Schema.NullOr(Schema.Struct({
        input: Schema.Number,
        cacheRead: Schema.Number,
        cacheWrite: Schema.Number,
        cost: Schema.Number,
        subagentCost: Schema.Number,
        advisorCost: Schema.Number,
        advisorCostState: Schema.Literals(["ready", "restoring", "unavailable"]),
      })),
      approvalMode: Schema.NullOr(Schema.Literals(["always-ask", "write", "yolo"])),
    })),
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
    operation: Schema.Literals(["list", "resume", "handoff", "configuration"]),
    message: Schema.String,
  },
) {}
