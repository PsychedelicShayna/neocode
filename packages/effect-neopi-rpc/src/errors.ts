import * as Schema from "effect/Schema";

/** Transport failure for the NeoPi/OMP JSONL stdio client. */
export class NeoPiRpcError extends Schema.TaggedError<NeoPiRpcError>()("NeoPiRpcError", {
  code: Schema.optional(Schema.String),
  message: Schema.String,
  command: Schema.optional(Schema.String),
}) {}
