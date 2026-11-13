import * as Schema from "effect/Schema";

export class NeoPiRuntimeError extends Schema.TaggedError<NeoPiRuntimeError>()(
  "NeoPiRuntimeError",
  {
    code: Schema.Literals([
      "settings",
      "identity_mismatch",
      "not_running",
      "not_ready",
      "busy",
      "spawn",
      "rpc",
      "startup",
      "session_in_use",
      "runtime_mode_deferred",
      "closed",
    ]),
    message: Schema.String,
    flag: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
