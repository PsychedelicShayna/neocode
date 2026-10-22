import { NeoPiNavigateTreeResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const NativeAnswerImage = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
export type NativeAnswerImage = typeof NativeAnswerImage.Type;
export const NativeTreeTargetDraft = Schema.Struct({
  summarize: Schema.Boolean,
  instructions: Schema.String,
  message: Schema.NullOr(Schema.String),
  result: Schema.NullOr(NeoPiNavigateTreeResult),
  answers: Schema.Record(
    Schema.String,
    Schema.Struct({ selectedOptions: Schema.Array(Schema.String), customInput: Schema.String }),
  ),
  images: Schema.Array(NativeAnswerImage),
});
export type NativeTreeTargetDraft = typeof NativeTreeTargetDraft.Type;
export const NativeTreeDraft = Schema.Struct({
  targets: Schema.Record(Schema.String, NativeTreeTargetDraft),
  resumeResult: Schema.NullOr(NeoPiNavigateTreeResult),
});
export type NativeTreeDraft = typeof NativeTreeDraft.Type;
export const emptyNativeTreeDraft = (): NativeTreeDraft => ({ targets: {}, resumeResult: null });
export const emptyNativeTreeTargetDraft = (): NativeTreeTargetDraft => ({
  summarize: false,
  instructions: "",
  message: null,
  result: null,
  answers: {},
  images: [],
});
