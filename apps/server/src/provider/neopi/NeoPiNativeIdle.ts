import type { NeoPiRpcClient } from "effect-neopi-rpc/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const NEOPI_NATIVE_IDLE_DEBOUNCE_MS = 30_000;

const IdleState = Schema.Struct({
  isStreaming: Schema.Boolean,
  queuedMessages: Schema.optionalKey(
    Schema.Struct({
      steering: Schema.Array(Schema.Unknown),
      followUp: Schema.Array(Schema.Unknown),
    }),
  ),
});
const Jobs = Schema.Struct({
  running: Schema.Array(Schema.Unknown),
  runningCount: Schema.Number,
});
const Subagents = Schema.Struct({
  subagents: Schema.Array(Schema.Struct({ status: Schema.String })),
});
const settledSubagentStatuses = new Set(["completed", "failed", "aborted", "cancelled"]);

/** Unknown or unsupported inventories cannot prove an owned runtime safe to retire. */
export const isNeoPiNativeIdle = Effect.fnUntraced(
  function* (client: Pick<NeoPiRpcClient, "request">) {
    const state = yield* Schema.decodeUnknownEffect(IdleState)(
      yield* client.request({ type: "get_state", includeDump: false }),
    );
    if (
      state.isStreaming ||
      (state.queuedMessages &&
        (state.queuedMessages.steering.length > 0 || state.queuedMessages.followUp.length > 0))
    )
      return false;
    const jobs = yield* Schema.decodeUnknownEffect(Jobs)(
      yield* client.request({ type: "get_jobs" }),
    );
    if (jobs.running.length > 0 || jobs.runningCount !== 0) return false;
    const agents = yield* Schema.decodeUnknownEffect(Subagents)(
      yield* client.request({ type: "get_subagents" }),
    );
    return agents.subagents.every((agent) => settledSubagentStatuses.has(agent.status));
  },
  Effect.timeout("5 seconds"),
  Effect.orElseSucceed(() => false),
);
