import * as Encoding from "effect/Encoding";
import type {
  FormField,
  FormOptionNote,
  FormSpan,
  FormUiRequest,
  FormUiResponse,
  FormValue,
} from "effect-neopi-rpc/form";

export type { FormBlock, FormField, FormSpan } from "effect-neopi-rpc/form";

export interface NativeForm {
  readonly kind: "form";
  readonly id: string;
  readonly sections: FormUiRequest["sections"];
  readonly acceptImages: boolean;
}

export type NativeFormImage = NonNullable<FormOptionNote["images"]>[number];

interface NoteDraft {
  readonly text: string;
  readonly images?: readonly NativeFormImage[];
}

export interface NativeFormChoice {
  readonly checked: readonly number[];
  readonly other: string | null;
  readonly notes?: Readonly<Record<number, NoteDraft>>;
}

export type NativeFormDraft = Readonly<Record<string, string | NativeFormChoice>>;
export type NativeFormErrors = Readonly<Record<string, string>>;
export type NativeFormResponse = FormUiResponse;

export function formSpanText(spans: readonly FormSpan[]): string {
  return spans.map(({ text }) => text).join("");
}

export function defaultFormChoice(field: Extract<FormField, { kind: "choice" }>): NativeFormChoice {
  return {
    checked: field.options.flatMap((option, index) => (option.checked ? [index] : [])),
    other: null,
  };
}

export function changeFormChoice(
  field: Extract<FormField, { kind: "choice" }>,
  value: NativeFormChoice,
  index: number | "other",
): NativeFormChoice {
  if (index === "other") {
    if (!field.other) return value;
    return value.other === null
      ? { ...value, checked: field.multi ? value.checked : [], other: "" }
      : { ...value, other: null };
  }
  if (!field.options[index] || field.options[index].disabled) return value;
  if (value.checked.includes(index)) {
    if (!field.multi) return value;
    return { ...value, checked: value.checked.filter((selected) => selected !== index) };
  }
  return field.multi
    ? { ...value, checked: [...value.checked, index] }
    : { ...value, checked: [index], other: null };
}

export function submitNativeForm(
  form: NativeForm,
  draft: NativeFormDraft,
):
  | { readonly errors: NativeFormErrors; readonly response?: never }
  | { readonly response: Extract<FormUiResponse, { data: unknown }>; readonly errors?: never } {
  const data: Record<string, FormValue> = Object.create(null);
  const errors: Record<string, string> = {};
  const notes: FormOptionNote[] = [];
  for (const [sectionIndex, section] of form.sections.entries()) {
    let caption = "";
    for (const [blockIndex, block] of section.blocks.entries()) {
      if (block.kind !== "field") {
        if (block.kind === "text") caption = formSpanText(block.spans);
        continue;
      }
      const field = block.field;
      const question =
        formSpanText(field.label) || caption || formSpanText(section.title) || field.name;
      caption = "";
      if (!field.name) continue;
      const key = `${sectionIndex}:${blockIndex}`;
      const input = draft[key];
      if (field.kind === "text") {
        const text = typeof input === "string" ? input : field.value;
        const result = formTextValue(field, text);
        if (typeof result === "object") errors[key] = result.error;
        else data[field.name] = result;
        continue;
      }
      const choice = input && typeof input !== "string" ? input : defaultFormChoice(field);
      const selected = field.options.flatMap((option, index) =>
        !option.disabled && choice.checked.includes(index) ? [{ option, index }] : [],
      );
      const other = field.other ? choice.other?.trim() : undefined;
      // NeoPi returns arrays only when a multi field declares multiple options.
      const values = selected.map(({ option }) => option.value);
      if (other) values.push(other);
      const value = field.multi && field.options.length > 1 ? values : other || values[0];
      if (field.required && values.length === 0) errors[key] = "Select an answer.";
      if (value !== undefined) data[field.name] = value;
      for (const { option, index } of selected) {
        const note = choice.notes?.[index];
        if (!note) continue;
        const images = form.acceptImages ? note.images : undefined;
        const text = [note.text.trim(), ...(images ?? []).map((_, i) => `[Image #${i + 1}]`)]
          .filter(Boolean)
          .join("\n");
        if (!text) continue;
        notes.push({
          name: field.name,
          question,
          option: formSpanText(option.label),
          value: option.value,
          text,
          ...(images?.length ? { images } : {}),
        });
      }
    }
  }
  if (Object.keys(errors).length > 0) return { errors };
  // Hidden values are never edited or echoed by the client; NeoPi restores its originals.
  return {
    response: {
      type: "extension_ui_response",
      id: form.id,
      data,
      ...(notes.length ? { notes } : {}),
    },
  };
}

const noNativeFormErrors: NativeFormErrors = {};

export function visibleNativeFormErrors(
  form: NativeForm,
  draft: NativeFormDraft,
  hasInvalidSubmit: boolean,
): NativeFormErrors {
  if (!hasInvalidSubmit) return noNativeFormErrors;
  return submitNativeForm(form, draft).errors ?? noNativeFormErrors;
}

function formTextValue(
  field: Extract<FormField, { kind: "text" }>,
  text: string,
): string | number | { error: string } {
  if (!text.trim()) return field.required ? { error: "Enter a value." } : text;
  let value: string | number = text;
  if (field.type === "number" || field.type === "range") {
    value = Number(text);
    if (!Number.isFinite(value)) return { error: "Enter a number." };
    if (field.min !== undefined && value < field.min)
      return { error: `Enter ${field.min} or more.` };
    if (field.max !== undefined && value > field.max)
      return { error: `Enter ${field.max} or less.` };
  }
  if (field.minLength !== undefined && text.length < field.minLength)
    return { error: `Enter at least ${field.minLength} characters.` };
  if (field.maxLength !== undefined && text.length > field.maxLength)
    return { error: `Enter no more than ${field.maxLength} characters.` };
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text))
    return { error: "Enter an email address." };
  if (field.type === "url") {
    try {
      if (!new URL(text).protocol) return { error: "Enter a full URL." };
    } catch {
      return { error: "Enter a full URL." };
    }
  }
  if (field.pattern) {
    try {
      if (!new RegExp(`^(?:${field.pattern})$`, "v").test(text))
        return { error: "Enter a value that matches the requested format." };
    } catch {
      // NeoPi ignores invalid patterns. Some mobile JS engines also lack Unicode sets.
    }
  }
  return value;
}

export function nativeFormImageSource(
  block: { kind: "image"; src: string } | { kind: "svg"; markup: string },
): string | undefined {
  // Image-only rendering; never feed extension-provided SVG/XML into the document.
  if (block.kind === "svg") {
    const markup = /^<svg\b[^>]*\sxmlns\s*=/.test(block.markup)
      ? block.markup
      : block.markup.replace(/^<svg(?=\s|>)/, '<svg xmlns="http://www.w3.org/2000/svg"');
    return `data:image/svg+xml;base64,${Encoding.encodeBase64(markup)}`;
  }
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(block.src)) return block.src;
  try {
    const url = new URL(block.src);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password)
      return url.href;
  } catch {
    // A native-machine filesystem path cannot be resolved by a remote client.
  }
  return undefined;
}
