import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const NeoPiJournalOptions = Schema.Struct({
  scope: Schema.optional(Schema.Literals(["journal", "branch"])),
  direction: Schema.optional(Schema.Literals(["forward", "backward"])),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 256 }))),
});
export type NeoPiJournalOptions = typeof NeoPiJournalOptions.Type;

// Unknown native fields and entry kinds must survive both decoding and encoding.
export const NeoPiJournalEntry = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    parentId: Schema.NullOr(Schema.String),
    type: Schema.String,
    timestamp: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type NeoPiJournalEntry = typeof NeoPiJournalEntry.Type;
export const NeoPiJournalPage = Schema.Struct({
  entries: Schema.Array(NeoPiJournalEntry),
  sessionId: Schema.String,
  sessionFile: Schema.String,
  leafId: Schema.NullOr(Schema.String),
  totalEntries: NonNegativeInt,
  nextCursor: Schema.optional(Schema.String),
});
export type NeoPiJournalPage = typeof NeoPiJournalPage.Type;
export const NeoPiSessionJournalInput = Schema.Struct({
  threadId: ThreadId,
  ...NeoPiJournalOptions.fields,
});
export type NeoPiSessionJournalInput = typeof NeoPiSessionJournalInput.Type;
export const NeoPiSessionJournalResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    providerInstanceId: ProviderInstanceId,
    page: NeoPiJournalPage,
  }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("error"),
    code: Schema.String,
    message: Schema.String,
  }),
]);
export type NeoPiSessionJournalResult = typeof NeoPiSessionJournalResult.Type;
