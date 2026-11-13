import type { NeoPiModelsConfiguration } from "@t3tools/contracts";
import { getNeoPiModelsSelectorOptions } from "@t3tools/client-runtime/neopi-models";
import { useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { NativeField, NativeModal } from "./NativeNeoPiControls";

/** Search text never becomes a model assignment. Saved native selectors remain pickable verbatim. */
export function NeoPiModelsSelector({
  configuration,
  label,
  value,
  onChange,
  disabled = false,
}: {
  configuration: NeoPiModelsConfiguration;
  label: string;
  value: string;
  onChange: (selector: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = useMemo(
    () => getNeoPiModelsSelectorOptions(configuration, value),
    [configuration, value],
  );
  const items = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return [...options.keys()].filter((selector) => {
      const option = options.get(selector)!;
      return `${selector} ${option.label} ${option.detail}`.toLocaleLowerCase().includes(search);
    });
  }, [options, query]);
  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground-muted">{label}</Text>
      <Button
        label={options.get(value)?.label ?? "Choose a native model or saved selector…"}
        disabled={disabled}
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
      />
      {value ? (
        <Text selectable className="text-xs text-foreground-muted">
          {value}
        </Text>
      ) : null}
      {open ? (
        <NativeModal title={label} onClose={() => setOpen(false)}>
          <View className="p-4">
            <NativeField
              label="Search models, roles and saved selectors"
              value={query}
              onChange={setQuery}
            />
          </View>
          <FlatList
            data={items}
            keyExtractor={(selector) => selector}
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-3 p-4"
            ListEmptyComponent={
              <Text className="text-foreground-muted">
                No matching native models or saved selectors.
              </Text>
            }
            renderItem={({ item: selector }) => {
              const option = options.get(selector)!;
              return (
                <View className="gap-1">
                  <Button
                    fullWidth
                    label={option.label}
                    tone={selector === value ? "primary" : "secondary"}
                    disabled={disabled}
                    onPress={() => {
                      onChange(selector);
                      setOpen(false);
                    }}
                  />
                  <Text className="text-xs text-foreground-muted">{option.detail}</Text>
                </View>
              );
            }}
          />
        </NativeModal>
      ) : null}
    </View>
  );
}
