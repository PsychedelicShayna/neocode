// @effect-diagnostics nodeBuiltinImport:off -- native session identities use absolute paths.
import * as NodePath from "node:path";
import type { NeoPiSessionConfigurationResult } from "@t3tools/contracts";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { NEOPI_CAPABILITIES } from "./NeoPiCompatibility.ts";
import { neoPiRolesFromRpc } from "./NeoPiModelCatalog.ts";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";
import type { NeoPiSessionRuntimeShape } from "./NeoPiRuntimeTypes.ts";

type Available = Extract<NeoPiSessionConfigurationResult, { status: "available" }>;
export type NeoPiRuntimeConfiguration = Omit<Available, "providerInstanceId">;
export interface NeoPiConfigurationIdentity {
  readonly sessionId: string;
  readonly sessionFile: string;
}
const State = Schema.Struct({
  sessionId: Schema.String,
  sessionFile: Schema.String,
  model: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        provider: Schema.String,
        id: Schema.String,
        name: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  thinkingLevel: Schema.optional(Schema.NullOr(Schema.String)),
  activeRole: Schema.optional(Schema.NullOr(Schema.String)),
  tokensPerSecond: Schema.optional(Schema.NullOr(Schema.Number)),
  contextUsage: Schema.optional(Schema.NullOr(Schema.Struct({
    tokens: Schema.optional(Schema.NullOr(Schema.Number)),
    contextWindow: Schema.Number,
    percent: Schema.optional(Schema.NullOr(Schema.Number)),
  }))),
  sessionUsage: Schema.optional(Schema.Struct({
    input: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    cost: Schema.Number,
    subagentCost: Schema.Number,
    advisorCost: Schema.Number,
    advisorCostState: Schema.Literals(["ready", "restoring", "unavailable"]),
  })),
  approvalMode: Schema.optional(Schema.Literals(["always-ask", "write", "yolo"])),
});
const decodeState = Schema.decodeUnknownEffect(State);
const sameIdentity = (left: NeoPiConfigurationIdentity, right: NeoPiConfigurationIdentity) =>
  left.sessionId !== "" &&
  left.sessionFile !== "" &&
  left.sessionId === right.sessionId &&
  NodePath.resolve(left.sessionFile) === NodePath.resolve(right.sessionFile);
const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });

/** Reads an existing runtime without starting it or changing its saved cursor. */
export const readNeoPiSessionConfiguration = Effect.fn("NeoPiSessionRuntime.configuration")(
  function* (
    runtime: NeoPiSessionRuntimeShape,
    expected: NeoPiConfigurationIdentity,
  ): Effect.fn.Return<
    NeoPiRuntimeConfiguration | Extract<NeoPiSessionConfigurationResult, { status: "unavailable" }>,
    NeoPiRuntimeError | NeoPiRpcError
  > {
    const generation = runtime.processGeneration;
    const connected = Effect.gen(function* () {
      const status = yield* SubscriptionRef.get(runtime.state);
      return status === "ready" || status === "running";
    });
    if (generation === undefined || !(yield* connected))
      return unavailable("The NeoPi session is not connected.");
    const saved = yield* SubscriptionRef.get(runtime.cursor);
    if (!sameIdentity(saved, expected))
      return unavailable("The bound NeoPi session has changed. Refresh the thread.");
    const readState = () =>
      runtime.request({ type: "get_state", includeDump: false }).pipe(
        Effect.flatMap(decodeState),
        Effect.mapError((cause) =>
          cause instanceof NeoPiRpcError
            ? cause
            : new NeoPiRuntimeError({
                code: "rpc",
                message: "NeoPi returned malformed session configuration.",
              }),
        ),
      );
    const before = yield* readState();
    if (!sameIdentity(before, expected))
      return unavailable("The native NeoPi session has changed. Refresh the thread.");
    if (runtime.processGeneration !== generation || !(yield* connected))
      return unavailable("The NeoPi connection changed during the snapshot. Refresh the thread.");
    let roles: Available["roles"] = {
      status: "unsupported",
      reason: "This connected NeoPi session does not advertise get_roles.",
    };
    if (runtime.capabilities.has(NEOPI_CAPABILITIES.getRoles)) {
      const result = neoPiRolesFromRpc(yield* runtime.request({ type: "get_roles" }));
      if (!result)
        return yield* new NeoPiRuntimeError({
          code: "rpc",
          message: "NeoPi returned malformed role configuration.",
        });
      roles = {
        status: "available",
        items: result.roles.map((role) => ({
          id: role.id,
          alias: role.alias,
          name: role.name,
          configured: role.configured ?? null,
          patterns: role.patterns,
          resolved: role.resolved
            ? {
                provider: role.resolved.provider,
                modelId: role.resolved.modelId,
                thinkingLevel: role.resolved.thinkingLevel ?? null,
              }
            : null,
          hidden: role.hidden,
        })),
      };
    }
    const after = yield* readState();
    const current = yield* SubscriptionRef.get(runtime.cursor);
    if (
      runtime.processGeneration !== generation ||
      !(yield* connected) ||
      !sameIdentity(after, expected) ||
      !sameIdentity(current, expected)
    )
      return unavailable(
        "The NeoPi connection or native session changed during the snapshot. Refresh the thread.",
      );
    return {
      status: "available",
      sessionId: after.sessionId,
      attachment: runtime.capabilities.has(NEOPI_CAPABILITIES.controlAttached)
        ? "terminal"
        : "owned",
      model: after.model
        ? { provider: after.model.provider, id: after.model.id, name: after.model.name ?? null }
        : null,
      thinkingLevel: after.thinkingLevel ?? null,
      activeRole: after.activeRole ?? null,
      telemetry: {
        tokensPerSecond: after.tokensPerSecond ?? null,
        context: after.contextUsage ? {
          tokens: after.contextUsage.tokens ?? null,
          contextWindow: after.contextUsage.contextWindow,
          percent: after.contextUsage.percent ?? null,
        } : null,
        sessionUsage: after.sessionUsage ?? null,
        approvalMode: after.approvalMode ?? null,
      },
      roles,
      observedAt: DateTime.formatIso(yield* DateTime.now),
    };
  },
  Effect.catch((cause) =>
    cause instanceof NeoPiRpcError && (cause.code === "closed" || cause.code === "exited")
      ? Effect.succeed(unavailable("The NeoPi session disconnected during the snapshot."))
      : Effect.fail(
          cause instanceof NeoPiRuntimeError
            ? cause
            : new NeoPiRuntimeError({
                code: "rpc",
                message: "Could not read NeoPi session configuration.",
                cause,
              }),
        ),
  ),
);
