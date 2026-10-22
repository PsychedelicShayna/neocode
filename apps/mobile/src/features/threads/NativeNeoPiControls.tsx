import { useState, type ReactNode } from "react";
import { Modal, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";

export function NativeChoice<T extends string>({ label, value, options, onChange, disabled = false }: {
  label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (value: T) => void; disabled?: boolean;
}) {
  return <View className="gap-2"><Text className="text-sm text-foreground-muted">{label}</Text><ScrollView horizontal contentContainerClassName="gap-2" showsHorizontalScrollIndicator={false}>{options.map(option => <MaterialButton key={option.value} label={option.label} tone={option.value === value ? "primary" : "secondary"} disabled={disabled} onPress={() => onChange(option.value)} />)}</ScrollView></View>;
}

export function NativeField({ label, value, onChange, secret = false, multiline = false, disabled = false, placeholder }: {
  label: string; value: string; onChange: (value: string) => void; secret?: boolean; multiline?: boolean; disabled?: boolean; placeholder?: string;
}) {
  return <View className="gap-1"><Text className="text-sm text-foreground-muted">{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChange} editable={!disabled} secureTextEntry={secret} multiline={multiline} autoCapitalize="none" autoCorrect={false} autoComplete="off" placeholder={placeholder} className="min-h-12 rounded-xl bg-card px-3 py-2 text-foreground" /></View>;
}

export function NativeError({ message }: { message: string | null | undefined }) {
  return message ? <Text accessibilityRole="alert" selectable className="text-sm text-danger-foreground">{message}</Text> : null;
}

export function NativeJson({ value, label = "Canonical JSON" }: { value: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  return <View className="gap-2"><MaterialButton label={open ? `Hide ${label}` : label} tone="text" onPress={() => setOpen(value => !value)} />{open ? <Text selectable className="font-mono text-xs text-foreground-muted">{JSON.stringify(value, null, 2)}</Text> : null}</View>;
}

export function NativeModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <Modal visible animationType="slide" onRequestClose={onClose}><View className="flex-1 bg-screen" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}><View className="flex-row items-center justify-between gap-2 px-4 py-2"><Text accessibilityRole="header" className="flex-1 text-lg font-t3-medium text-foreground">{title}</Text><MaterialButton label="Close" tone="text" onPress={onClose} /></View>{children}</View></Modal>;
}
