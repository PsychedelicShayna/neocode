import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FormUiRequest, FormUiResponse } from "./form.ts";
import { decodeFrameLine } from "./schema.ts";

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(Json);
const decodeJson = Schema.decodeEffect(Json);
const decodeForm = Schema.decodeUnknownEffect(FormUiRequest);
const encodeForm = Schema.encodeEffect(FormUiRequest);
const ReplyJson = Schema.fromJsonString(FormUiResponse);
const decodeReply = Schema.decodeEffect(ReplyJson);
const encodeReply = Schema.encodeEffect(ReplyJson);

// NeoPi #857 docs/rpc.md, “Form dialog”.
const request = {
  type: "extension_ui_request",
  id: "form-1",
  method: "form",
  sections: [
    {
      title: [{ text: "Database" }],
      fieldset: true,
      blocks: [
        { kind: "text", spans: [{ text: "Choose storage" }], heading: false },
        {
          kind: "field",
          field: {
            kind: "choice",
            name: "engine",
            multi: false,
            select: true,
            other: false,
            label: [],
            options: [
              { value: "pg", label: [{ text: "Postgres" }], checked: true, disabled: false },
            ],
            required: true,
          },
        },
        {
          kind: "field",
          field: {
            kind: "text",
            name: "replicas",
            type: "number",
            multiline: false,
            label: [{ text: "Replicas" }],
            value: "2",
            placeholder: "",
            required: true,
            min: 1,
            rows: 1,
          },
        },
      ],
    },
  ],
  hidden: [{ name: "context", value: "provision" }],
  timeout: 30000,
} satisfies FormUiRequest;

it.effect("round-trips the documented request, reply and dismissal", () =>
  Effect.gen(function* () {
    const frame = yield* decodeFrameLine(yield* encodeJson(request));
    const parsed = yield* decodeForm(frame);
    assert.deepEqual(yield* encodeForm(parsed), request);
    const reply = {
      type: "extension_ui_response",
      id: "form-1",
      data: { engine: "pg", replicas: 3 },
      notes: [
        {
          name: "engine",
          question: "Choose storage",
          option: "Postgres",
          value: "pg",
          text: "Use the existing cluster.",
        },
      ],
    };
    for (const value of [reply, { type: "extension_ui_response", id: "form-1", cancelled: true }]) {
      const decoded = yield* decodeReply(yield* encodeJson(value));
      assert.deepEqual(yield* decodeJson(yield* encodeReply(decoded)), value);
    }
  }),
);
