import { describe, expect, it } from "vite-plus/test";
import { selectNativeSessionDialog } from "./neopiNativeAsk.ts";
import {
  changeFormChoice,
  defaultFormChoice,
  submitNativeForm,
  type FormBlock,
  type FormField,
} from "./neopiNativeForm.ts";
import { emptyNativeSessionFeed, reduceNativeSessionFeed } from "./neopiNativeSessions.ts";

const engine = {
  kind: "choice",
  name: "engine",
  required: true,
  multi: false,
  select: true,
  other: false,
  label: [{ text: "Storage engine" }],
  options: [
    { value: "pg", label: [{ text: "Postgres" }], checked: true, disabled: false },
    { value: "sqlite", label: [{ text: "SQLite" }], checked: false, disabled: false },
  ],
} satisfies FormField;
const flags = {
  ...engine,
  name: "flags",
  label: [],
  required: false,
  multi: true,
  select: false,
  other: true,
  options: [
    { value: "read", label: [{ text: "Read" }], checked: true, disabled: false },
    { value: "admin", label: [{ text: "Admin" }], checked: true, disabled: true },
  ],
} satisfies FormField;
const title = {
  kind: "text",
  type: "text",
  name: "title",
  multiline: true,
  label: [],
  value: "",
  placeholder: "",
  rows: 2,
  required: true,
  minLength: 3,
} satisfies FormField;
const replicas = {
  ...title,
  name: "replicas",
  type: "number",
  multiline: false,
  rows: 1,
  value: "2",
  min: 1,
  max: 8,
  minLength: 1,
} satisfies FormField;
const request = {
  type: "extension_ui_request",
  method: "form",
  id: "form:test",
  timeout: 30000,
  sections: [
    {
      title: [{ text: "Database" }],
      fieldset: true,
      blocks: [engine, flags, title, replicas].map((field): FormBlock => ({
        kind: "field",
        field,
      })),
    },
  ],
  hidden: [{ name: "context", value: "server-only" }],
};
function openForm() {
  return reduceNativeSessionFeed(emptyNativeSessionFeed(), {
    type: "obligation-opened",
    revision: 1,
    id: request.id,
    request,
  });
}

describe("inline NeoPi form", () => {
  it("submits scalar choice, ordered multi values, text and numeric values without hidden or disabled values", () => {
    const form = selectNativeSessionDialog(openForm().dialogs);
    if (form?.kind !== "form") throw new Error("expected inline form");
    const choice = changeFormChoice(engine, defaultFormChoice(engine), 1);
    const multi = changeFormChoice(flags, defaultFormChoice(flags), "other");
    expect(
      submitNativeForm(form, {
        "0:0": choice,
        "0:1": { ...multi, other: " read-only " },
        "0:2": "database",
        "0:3": "3.5",
      }).response,
    ).toEqual({
      type: "extension_ui_response",
      id: request.id,
      data: { engine: "sqlite", flags: ["read", "read-only"], title: "database", replicas: 3.5 },
    });
    expect(submitNativeForm(form, { "0:2": "  ", "0:3": "9" }).errors).toEqual({
      "0:2": "Enter a value.",
      "0:3": "Enter 8 or less.",
    });
    expect(submitNativeForm(form, { "0:2": "database" }).response?.data).toEqual({
      engine: "pg",
      flags: ["read"],
      title: "database",
      replicas: 2,
    });
  });

  it("closes the timed form upon the owner's cancellation, without synthesizing a reply", () => {
    const settled = reduceNativeSessionFeed(openForm(), {
      type: "obligation-settled",
      revision: 2,
      id: request.id,
      outcome: "cancelled",
    });
    expect(selectNativeSessionDialog(settled.dialogs)).toBeNull();
  });
});
