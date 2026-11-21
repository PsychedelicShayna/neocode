/* eslint-disable react/no-array-index-key -- NeoPi addresses immutable form content in document order. */
import {
  changeFormChoice,
  defaultFormChoice,
  formSpanText,
  nativeFormImageSource,
  submitNativeForm,
  visibleNativeFormErrors,
  type FormBlock,
  type FormSpan,
  type NativeForm,
  type NativeFormChoice,
  type NativeFormDraft,
  type NativeFormResponse,
} from "@t3tools/client-runtime/neopi-native-form";
import { useId, useMemo, useRef, useState } from "react";
import { readFileAsDataUrl } from "../ChatView.logic";
import { ComposerBanner } from "../chat/ComposerBanner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

function Spans({ spans }: { spans: readonly FormSpan[] }) {
  return spans.map(({ text, style }, index) => {
    if (style === "strong") return <strong key={index}>{text}</strong>;
    if (style === "em") return <em key={index}>{text}</em>;
    if (style === "code")
      return (
        <code key={index} className="font-mono">
          {text}
        </code>
      );
    return text;
  });
}

function Content({ block }: { block: Exclude<FormBlock, { kind: "field" }> }) {
  switch (block.kind) {
    case "text":
      return block.heading ? (
        <h4 className="font-medium">
          <Spans spans={block.spans} />
        </h4>
      ) : (
        <p>
          <Spans spans={block.spans} />
        </p>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List className={block.ordered ? "list-decimal ps-5" : "list-disc ps-5"}>
          {block.items.map((item, index) => (
            <li key={index}>
              <Spans spans={item} />
            </li>
          ))}
        </List>
      );
    }
    case "pre":
      return (
        <pre className="overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">{block.text}</pre>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            {block.headerRows > 0 ? (
              <thead>
                {block.rows.slice(0, block.headerRows).map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, column) => (
                      <th key={column} className="border-b border-border px-2 py-1">
                        <Spans spans={cell} />
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
            ) : null}
            <tbody>
              {block.rows.slice(block.headerRows).map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column} className="border-b border-border px-2 py-1">
                      <Spans spans={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image":
    case "svg": {
      const src = nativeFormImageSource(block);
      return src ? (
        <img
          src={src}
          alt={block.alt}
          referrerPolicy="no-referrer"
          className="max-h-48 max-w-full object-contain"
        />
      ) : (
        <p className="text-muted-foreground">{block.alt || "Image unavailable"}</p>
      );
    }
  }
}

export function NativeSessionForm({
  form,
  respond,
}: {
  form: NativeForm;
  respond: (response: NativeFormResponse) => Promise<unknown>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<NativeFormDraft>({});
  const [hasInvalidSubmit, setHasInvalidSubmit] = useState(false);
  const errors = useMemo(
    () => visibleNativeFormErrors(form, draft, hasInvalidSubmit),
    [form, draft, hasInvalidSubmit],
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const imageReads = useRef(0);
  const [readingImages, setReadingImages] = useState(false);
  const send = async (response: NativeFormResponse) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try {
      await respond(response);
    } catch (cause) {
      setFailure(String(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const submit = () => {
    if (imageReads.current) return;
    const result = submitNativeForm(form, draft);
    if (result.errors) setHasInvalidSubmit(true);
    else void send(result.response);
  };
  return (
    <div
      role="group"
      aria-labelledby={`${id}-heading`}
      data-chat-composer-resting-controls="true"
      className="min-w-0 px-3 py-2 text-sm"
    >
      <h3 id={`${id}-heading`} className="mb-2 font-medium">
        NeoPi form
      </h3>
      <ComposerBanner.Scroll className="max-h-[35dvh]">
        <div className="space-y-3 px-1 pb-1">
          {form.sections.map((section, sectionIndex) => {
            const Section = section.fieldset ? "fieldset" : "section";
            const Title = section.fieldset ? "legend" : "h4";
            return (
              <Section key={sectionIndex} className="min-w-0 space-y-2">
                {section.title.length > 0 ? (
                  <Title className="font-medium">
                    <Spans spans={section.title} />
                  </Title>
                ) : null}
                {section.blocks.map((block, blockIndex) => {
                  const key = `${sectionIndex}:${blockIndex}`;
                  if (block.kind !== "field") return <Content key={key} block={block} />;
                  const field = block.field;
                  if (!field.name) return null;
                  const input = draft[key];
                  const errorId = errors[key] ? `${id}-${key}-error` : undefined;
                  const fieldLabel = (
                    <>
                      <Spans spans={field.label} />
                      {field.label.length === 0 ? field.name : null}
                      {field.required ? " (required)" : null}
                    </>
                  );
                  if (field.kind === "text") {
                    const props = {
                      id: `${id}-${key}`,
                      value: typeof input === "string" ? input : field.value,
                      placeholder: field.placeholder,
                      disabled: pending,
                      "aria-required": field.required,
                      "aria-invalid": Boolean(errorId),
                      "aria-describedby": errorId,
                      onChange: (
                        event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
                      ) => {
                        const value = event.currentTarget.value;
                        setDraft((current) => ({ ...current, [key]: value }));
                      },
                    };
                    return (
                      <div key={key} className="space-y-1">
                        <label htmlFor={props.id}>{fieldLabel}</label>
                        {field.multiline ? (
                          <Textarea {...props} rows={field.rows} />
                        ) : (
                          <Input
                            {...props}
                            type={field.type === "password" ? "password" : "text"}
                            inputMode={
                              field.type === "number" || field.type === "range"
                                ? "decimal"
                                : field.type === "email" ||
                                    field.type === "url" ||
                                    field.type === "tel"
                                  ? field.type
                                  : undefined
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.preventDefault();
                            }}
                          />
                        )}
                        {errorId ? (
                          <p id={errorId} role="alert" className="text-destructive">
                            {errors[key]}
                          </p>
                        ) : null}
                      </div>
                    );
                  }
                  const fallback = defaultFormChoice(field);
                  const choice = input && typeof input !== "string" ? input : fallback;
                  const change = (update: (value: NativeFormChoice) => NativeFormChoice) =>
                    setDraft((current) => {
                      const value = current[key];
                      return {
                        ...current,
                        [key]: update(value && typeof value !== "string" ? value : fallback),
                      };
                    });
                  const appendImages = async (index: number, files: readonly File[]) => {
                    if (!form.acceptImages || inFlight.current || !files.length) return;
                    imageReads.current += 1;
                    setReadingImages(true);
                    try {
                      const images = await Promise.all(
                        files.map(async (file) => ({
                          type: "image" as const,
                          mimeType: file.type,
                          data: (await readFileAsDataUrl(file)).split(",", 2)[1] ?? "",
                        })),
                      );
                      change((value) => {
                        const note = value.notes?.[index];
                        return {
                          ...value,
                          notes: {
                            ...value.notes,
                            [index]: {
                              text: note?.text ?? "",
                              images: [...(note?.images ?? []), ...images],
                            },
                          },
                        };
                      });
                    } catch (cause) {
                      setFailure(String(cause));
                    } finally {
                      imageReads.current -= 1;
                      setReadingImages(imageReads.current > 0);
                    }
                  };
                  return (
                    <fieldset
                      key={key}
                      disabled={pending}
                      aria-describedby={errorId}
                      className="min-w-0 space-y-1"
                    >
                      <legend>{fieldLabel}</legend>
                      {field.select ? (
                        <select
                          className="max-w-full rounded-md border border-border bg-background px-2 py-1"
                          aria-label={formSpanText(field.label) || field.name}
                          aria-required={field.required}
                          multiple={field.multi}
                          value={
                            field.multi
                              ? [
                                  ...choice.checked.map(String),
                                  ...(choice.other !== null ? ["other"] : []),
                                ]
                              : choice.other !== null
                                ? "other"
                                : String(choice.checked[0] ?? "")
                          }
                          onChange={(event) => {
                            const picked = Array.from(
                              event.currentTarget.selectedOptions,
                              (option) => option.value,
                            );
                            change((value) => ({
                              ...value,
                              checked: picked
                                .filter((option) => option !== "" && option !== "other")
                                .map(Number),
                              other: picked.includes("other") ? (value.other ?? "") : null,
                            }));
                          }}
                        >
                          {!field.multi ? <option value="">Select an option</option> : null}
                          {field.options.map((option, index) => (
                            <option key={index} value={index} disabled={option.disabled}>
                              {formSpanText(option.label)}
                            </option>
                          ))}
                          {field.other ? <option value="other">Other</option> : null}
                        </select>
                      ) : (
                        field.options.map((option, index) => (
                          <label
                            key={index}
                            className="flex items-baseline gap-2 has-disabled:text-muted-foreground"
                          >
                            <input
                              type={field.multi ? "checkbox" : "radio"}
                              name={`${id}-${key}`}
                              disabled={option.disabled}
                              checked={choice.checked.includes(index)}
                              onChange={() =>
                                change((value) => changeFormChoice(field, value, index))
                              }
                            />
                            <span>
                              <Spans spans={option.label} />
                            </span>
                          </label>
                        ))
                      )}
                      {field.other && !field.select ? (
                        <label className="flex items-baseline gap-2">
                          <input
                            type={field.multi ? "checkbox" : "radio"}
                            name={`${id}-${key}`}
                            checked={choice.other !== null}
                            onChange={() =>
                              change((value) => changeFormChoice(field, value, "other"))
                            }
                          />{" "}
                          Other
                        </label>
                      ) : null}
                      {choice.other !== null ? (
                        <Input
                          aria-label="Other answer"
                          value={choice.other}
                          onChange={(event) => {
                            const other = event.currentTarget.value;
                            change((value) => ({ ...value, other }));
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.preventDefault();
                          }}
                        />
                      ) : null}
                      {field.options.map((option, index) => {
                        if (option.disabled || !choice.checked.includes(index)) return null;
                        const note = choice.notes?.[index];
                        const label = `Note for ${formSpanText(option.label)}`;
                        return (
                          <details key={index} className="text-xs">
                            <summary className="cursor-pointer text-muted-foreground">
                              {label}
                            </summary>
                            <Textarea
                              aria-label={label}
                              rows={2}
                              value={note?.text ?? ""}
                              onChange={(event) => {
                                const text = event.currentTarget.value;
                                change((value) => ({
                                  ...value,
                                  notes: {
                                    ...value.notes,
                                    [index]: { ...value.notes?.[index], text },
                                  },
                                }));
                              }}
                              onPaste={(event) => {
                                const files = Array.from(event.clipboardData.files).filter((file) =>
                                  /^image\/(?:png|jpeg|gif|webp)$/.test(file.type),
                                );
                                if (!form.acceptImages || !files.length) return;
                                event.preventDefault();
                                void appendImages(index, files);
                              }}
                            />
                            {form.acceptImages ? (
                              <p className="text-muted-foreground">Paste an image to attach it.</p>
                            ) : null}
                            {note?.images?.map((_, imageIndex) => (
                              <Button
                                key={imageIndex}
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() =>
                                  change((value) => {
                                    const editing = value.notes?.[index];
                                    if (!editing) return value;
                                    return {
                                      ...value,
                                      notes: {
                                        ...value.notes,
                                        [index]: {
                                          ...editing,
                                          images:
                                            editing.images?.filter((_, i) => i !== imageIndex) ??
                                            [],
                                        },
                                      },
                                    };
                                  })
                                }
                              >
                                Remove image {imageIndex + 1}
                              </Button>
                            ))}
                          </details>
                        );
                      })}
                      {errorId ? (
                        <p id={errorId} role="alert" className="text-destructive">
                          {errors[key]}
                        </p>
                      ) : null}
                    </fieldset>
                  );
                })}
              </Section>
            );
          })}
        </div>
      </ComposerBanner.Scroll>
      {failure ? (
        <p role="alert" className="mt-2 text-destructive">
          {failure}
        </p>
      ) : null}
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => void send({ type: "extension_ui_response", id: form.id, cancelled: true })}
        >
          Dismiss
        </Button>
        <Button type="button" size="sm" disabled={pending || readingImages} onClick={submit}>
          Submit form
        </Button>
      </div>
    </div>
  );
}
