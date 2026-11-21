/* eslint-disable react/no-array-index-key -- NeoPi addresses immutable form content in document order. */
import {
  changeFormChoice,
  defaultFormChoice,
  formSpanText,
  nativeFormImageSource,
  submitNativeForm,
  type FormBlock,
  type FormSpan,
  type NativeForm,
  type NativeFormChoice,
  type NativeFormDraft,
  type NativeFormErrors,
  type NativeFormResponse,
} from "@t3tools/client-runtime/neopi-native-form";
import { launchImageLibraryAsync } from "expo-image-picker";
import { Image } from "expo-image";
import { useRef, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { NativeError } from "./NativeNeoPiControls";

function Spans({ spans }: { spans: readonly FormSpan[] }) {
  return spans.map(({ text, style }, index) => (
    <Text
      key={index}
      className={
        style === "strong"
          ? "font-t3-medium"
          : style === "em"
            ? "italic"
            : style === "code"
              ? "font-mono"
              : undefined
      }
    >
      {text}
    </Text>
  ));
}

function Content({ block }: { block: Exclude<FormBlock, { kind: "field" }> }) {
  switch (block.kind) {
    case "text":
      return (
        <Text className={block.heading ? "font-t3-medium text-foreground" : "text-foreground"}>
          <Spans spans={block.spans} />
        </Text>
      );
    case "list":
      return (
        <View className="gap-1 pl-2">
          {block.items.map((item, index) => (
            <Text key={index} className="text-foreground">
              {block.ordered ? `${index + 1}. ` : "• "}
              <Spans spans={item} />
            </Text>
          ))}
        </View>
      );
    case "pre":
      return (
        <ScrollView horizontal>
          <Text selectable className="font-mono text-xs text-foreground-muted">
            {block.text}
          </Text>
        </ScrollView>
      );
    case "table":
      return (
        <ScrollView horizontal>
          <View>
            {block.rows.map((row, rowIndex) => (
              <View key={rowIndex} className="flex-row border-b border-border">
                {row.map((cell, index) => (
                  <Text
                    key={index}
                    className={`w-36 px-2 py-1 text-sm text-foreground ${rowIndex < block.headerRows ? "font-t3-medium" : ""}`}
                  >
                    <Spans spans={cell} />
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case "image":
    case "svg": {
      const uri = nativeFormImageSource(block);
      return uri ? (
        <Image
          source={{ uri }}
          accessibilityLabel={block.alt}
          contentFit="contain"
          style={{ height: 144, width: "100%" }}
        />
      ) : (
        <Text className="text-foreground-muted">{block.alt || "Image unavailable"}</Text>
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
  const [draft, setDraft] = useState<NativeFormDraft>({});
  const [errors, setErrors] = useState<NativeFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const picking = useRef(false);
  const [pickingImage, setPickingImage] = useState(false);
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
    if (picking.current) return;
    const result = submitNativeForm(form, draft);
    setErrors(result.errors ?? {});
    if (result.response) void send(result.response);
  };
  return (
    <View className="grow-0 border-t border-border bg-card" style={{ maxHeight: "40%" }}>
      <Text accessibilityRole="header" className="px-4 pt-2 font-t3-medium text-foreground">
        NeoPi form
      </Text>
      <ScrollView
        className="grow-0"
        contentContainerClassName="gap-3 px-4 py-2"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {form.sections.map((section, sectionIndex) => (
          <View
            key={sectionIndex}
            className={section.fieldset ? "gap-2 rounded-xl border border-border p-2" : "gap-2"}
          >
            {section.title.length ? (
              <Text accessibilityRole="header" className="font-t3-medium text-foreground">
                <Spans spans={section.title} />
              </Text>
            ) : null}
            {section.blocks.map((block, blockIndex) => {
              const key = `${sectionIndex}:${blockIndex}`;
              if (block.kind !== "field") return <Content key={key} block={block} />;
              const field = block.field;
              if (!field.name) return null;
              const input = draft[key];
              const label = `${formSpanText(field.label) || field.name}${field.required ? " (required)" : ""}`;
              if (field.kind === "text")
                return (
                  <View key={key} className="gap-1">
                    <Text className="text-sm text-foreground">{label}</Text>
                    <TextInput
                      accessibilityLabel={label}
                      value={typeof input === "string" ? input : field.value}
                      placeholder={field.placeholder}
                      editable={!pending}
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry={field.type === "password"}
                      multiline={field.multiline}
                      numberOfLines={field.rows}
                      keyboardType={
                        field.type === "number" || field.type === "range"
                          ? "numbers-and-punctuation"
                          : field.type === "email"
                            ? "email-address"
                            : field.type === "url"
                              ? "url"
                              : field.type === "tel"
                                ? "phone-pad"
                                : "default"
                      }
                      className="min-h-12 rounded-xl border border-border px-3 py-2 text-foreground"
                      onChangeText={(text) => setDraft((current) => ({ ...current, [key]: text }))}
                    />
                    <NativeError message={errors[key]} />
                  </View>
                );
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
              const pickImage = async (index: number) => {
                if (!form.acceptImages || picking.current || inFlight.current) return;
                picking.current = true;
                setPickingImage(true);
                setFailure(null);
                const endHandoff = beginForegroundHandoff();
                try {
                  const selection = await launchImageLibraryAsync({
                    mediaTypes: ["images"],
                    base64: true,
                  });
                  const asset = selection.assets?.[0];
                  if (selection.canceled) return;
                  if (!asset?.base64) throw new Error("Could not read the selected photo.");
                  const image = {
                    type: "image" as const,
                    mimeType: "image/jpeg",
                    data: asset.base64,
                  };
                  change((value) => {
                    const note = value.notes?.[index];
                    return {
                      ...value,
                      notes: {
                        ...value.notes,
                        [index]: {
                          text: note?.text ?? "",
                          images: [...(note?.images ?? []), image],
                        },
                      },
                    };
                  });
                } catch (cause) {
                  setFailure(String(cause));
                } finally {
                  endHandoff();
                  picking.current = false;
                  setPickingImage(false);
                }
              };
              const options = (
                <>
                  {field.options.map((option, index) => {
                    const selected = choice.checked.includes(index);
                    return (
                      <MaterialButton
                        key={index}
                        label={`${selected ? "✓ " : ""}${formSpanText(option.label)}`}
                        tone={selected ? "primary" : "secondary"}
                        disabled={pending || option.disabled}
                        onPress={() => change((value) => changeFormChoice(field, value, index))}
                      />
                    );
                  })}
                  {field.other ? (
                    <MaterialButton
                      label={choice.other === null ? "Other" : "✓ Other"}
                      tone={choice.other === null ? "secondary" : "primary"}
                      disabled={pending}
                      onPress={() => change((value) => changeFormChoice(field, value, "other"))}
                    />
                  ) : null}
                </>
              );
              return (
                <View key={key} className="gap-1">
                  <Text className="text-sm text-foreground">{label}</Text>
                  {field.select ? (
                    <ScrollView
                      horizontal
                      contentContainerClassName="gap-2"
                      keyboardShouldPersistTaps="handled"
                    >
                      {options}
                    </ScrollView>
                  ) : (
                    <View className="gap-1">{options}</View>
                  )}
                  {choice.other !== null ? (
                    <TextInput
                      accessibilityLabel="Other answer"
                      value={choice.other}
                      editable={!pending}
                      className="min-h-12 rounded-xl border border-border px-3 py-2 text-foreground"
                      onChangeText={(other) => change((value) => ({ ...value, other }))}
                    />
                  ) : null}
                  {field.options.map((option, index) => {
                    if (option.disabled || !choice.checked.includes(index)) return null;
                    const note = choice.notes?.[index];
                    const noteLabel = `Note for ${formSpanText(option.label)}`;
                    return (
                      <View key={index} className="gap-1">
                        <TextInput
                          accessibilityLabel={noteLabel}
                          placeholder={noteLabel}
                          value={note?.text ?? ""}
                          multiline
                          editable={!pending}
                          className="min-h-12 rounded-xl border border-border px-3 py-2 text-foreground"
                          onChangeText={(text) =>
                            change((value) => ({
                              ...value,
                              notes: { ...value.notes, [index]: { ...value.notes?.[index], text } },
                            }))
                          }
                        />
                        {form.acceptImages ? (
                          <MaterialButton
                            label="Add photo to note"
                            tone="text"
                            disabled={pending || pickingImage}
                            onPress={() => void pickImage(index)}
                          />
                        ) : null}
                        {note?.images?.map((_, imageIndex) => (
                          <MaterialButton
                            key={imageIndex}
                            label={`Remove image ${imageIndex + 1}`}
                            tone="text"
                            disabled={pending}
                            onPress={() =>
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
                                        editing.images?.filter((_, i) => i !== imageIndex) ?? [],
                                    },
                                  },
                                };
                              })
                            }
                          />
                        ))}
                      </View>
                    );
                  })}
                  <NativeError message={errors[key]} />
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>
      <View className="gap-1 px-4 pb-2">
        <NativeError message={failure} />
        <View className="flex-row flex-wrap items-center gap-2">
          <MaterialButton
            label="Dismiss"
            tone="text"
            disabled={pending}
            onPress={() =>
              void send({ type: "extension_ui_response", id: form.id, cancelled: true })
            }
          />
          <MaterialButton label="Submit form" disabled={pending || pickingImage} onPress={submit} />
        </View>
      </View>
    </View>
  );
}
