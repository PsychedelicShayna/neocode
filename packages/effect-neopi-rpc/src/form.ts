import * as Schema from "effect/Schema";

// NeoPi #857, 3bf7986554: packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts.
export interface SetFormDialogCommand {
  readonly type: "set_form_dialog";
  readonly id?: string;
  readonly enabled: boolean;
}

export interface SetFormDialogResult {
  readonly enabled: boolean;
}

const FormSpan = Schema.Struct({
  text: Schema.String,
  style: Schema.optionalKey(Schema.Literals(["code", "strong", "em"])),
});
export type FormSpan = typeof FormSpan.Type;
const Spans = Schema.Array(FormSpan);

const ChoiceOption = Schema.Struct({
  value: Schema.String,
  label: Spans,
  checked: Schema.Boolean,
  disabled: Schema.Boolean,
});
const ChoiceField = Schema.Struct({
  kind: Schema.Literal("choice"),
  name: Schema.String,
  multi: Schema.Boolean,
  select: Schema.Boolean,
  other: Schema.Boolean,
  label: Spans,
  options: Schema.Array(ChoiceOption),
  required: Schema.Boolean,
});
const TextField = Schema.Struct({
  kind: Schema.Literal("text"),
  name: Schema.String,
  type: Schema.String,
  multiline: Schema.Boolean,
  label: Spans,
  value: Schema.String,
  placeholder: Schema.String,
  required: Schema.Boolean,
  rows: Schema.Number,
  min: Schema.optionalKey(Schema.Number),
  max: Schema.optionalKey(Schema.Number),
  pattern: Schema.optionalKey(Schema.String),
  minLength: Schema.optionalKey(Schema.Number),
  maxLength: Schema.optionalKey(Schema.Number),
});
const Field = Schema.Union([ChoiceField, TextField]);
export type FormField = typeof Field.Type;

const Block = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), spans: Spans, heading: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("list"),
    items: Schema.Array(Spans),
    ordered: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("pre"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("table"),
    rows: Schema.Array(Schema.Array(Spans)),
    headerRows: Schema.Int,
  }),
  Schema.Struct({ kind: Schema.Literal("image"), src: Schema.String, alt: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("svg"), markup: Schema.String, alt: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("field"),
    field: Field,
    optionsEnd: Schema.optionalKey(Schema.Int),
  }),
]);
export type FormBlock = typeof Block.Type;

export const FormUiRequest = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  method: Schema.Literal("form"),
  id: Schema.String,
  sections: Schema.Array(
    Schema.Struct({
      title: Spans,
      blocks: Schema.Array(Block),
      fieldset: Schema.Boolean,
    }),
  ),
  hidden: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  timeout: Schema.optionalKey(Schema.Int),
  acceptImages: Schema.optionalKey(Schema.Boolean),
});
export type FormUiRequest = typeof FormUiRequest.Type;

const FormValue = Schema.Union([Schema.String, Schema.Finite, Schema.Array(Schema.String)]);
export type FormValue = typeof FormValue.Type;
const FormData = Schema.Record(Schema.String, FormValue);
const NoteImage = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
const Note = Schema.Struct({
  name: Schema.String,
  question: Schema.String,
  option: Schema.String,
  value: Schema.String,
  text: Schema.String,
  images: Schema.optionalKey(Schema.Array(NoteImage)),
});
export type FormOptionNote = typeof Note.Type;

export const FormUiSubmission = Schema.Struct({
  type: Schema.Literal("extension_ui_response"),
  id: Schema.String,
  data: FormData,
  notes: Schema.optionalKey(Schema.Array(Note)),
  timedOut: Schema.optionalKey(Schema.Boolean),
});
export type FormUiSubmission = typeof FormUiSubmission.Type;

export const FormUiResponse = Schema.Union([
  FormUiSubmission,
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    cancelled: Schema.Literal(true),
    timedOut: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type FormUiResponse = typeof FormUiResponse.Type;
