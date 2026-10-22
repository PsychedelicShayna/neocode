import { useAtomRefresh, useAtomSet } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, View } from "react-native";
import { AppText as Text } from "../../../../components/AppText";
import { neopiThemesUpdate, useMobileNativeTheme } from "../../../../state/neopiThemes";
import { updateMobilePreferencesAtom } from "../../../../state/preferences";
import { useAtomCommand } from "../../../../state/use-atom-command";

export function NeoPiThemeSettings() {
  const native = useMobileNativeTheme();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const update = useAtomCommand(neopiThemesUpdate, { reportFailure: false });
  const refresh = useAtomRefresh(native.atom);
  const [picker, setPicker] = useState<"target" | "dark" | "light" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => picker === "target"
    ? native.choices.map(choice => ({ key: choice.key, label: choice.label, name: null }))
    : [{ key: "inherit", label: "Inherit", name: null }, ...(native.snapshot?.themes ?? []).map(name => ({ key: JSON.stringify(name), label: name, name }))],
  [picker, native.choices, native.snapshot]);
  const selected = picker === "target" ? native.target?.key : picker && native.snapshot
    ? native.snapshot.selection[picker][native.target?.target.projectId ? "project" : "global"] : null;
  const choose = async (option: { key: string; name: string | null }) => {
    if (picker === "target") { savePreferences({ nativeThemeTarget: option.key }); setPicker(null); return; }
    if (!picker || !native.target || !native.snapshot || pending) return;
    const appearance = picker;
    const scope = native.target.target.projectId ? "project" : "global";
    setPicker(null); setPending(true); setError(null);
    try {
      const response = await update({ environmentId: native.target.environmentId, input: {
        target: native.target.target, appearance, scope, name: option.name,
        expected: native.snapshot.selection[appearance][scope],
      } });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the native theme. Refresh before trying again.");
      refresh();
    } finally { setPending(false); }
  };
  return <View className="gap-3">
    <Text className="text-base font-t3-medium">NeoPi themes</Text>
    <Text className="text-sm text-foreground-muted">Shared with terminal Settings. User and project selections stay in NeoPi; fonts and layout stay on this device.</Text>
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: native.follow }} className="rounded-xl border border-border bg-card p-3" onPress={() => savePreferences({ nativeThemeFollow: !native.follow })}>
      <Text>{native.follow ? "Following NeoPi themes" : "Use NeoPi themes"}</Text>
      <Text className="text-xs text-foreground-muted">{native.follow ? "Tap to restore the saved graphical palette" : "Your saved graphical palette will remain stored"}</Text>
    </Pressable>
    <Pressable accessibilityRole="button" className="rounded-xl border border-border bg-card p-3" onPress={() => setPicker("target")}>
      <Text>{native.target?.label ?? "Choose a connected NeoPi runtime and scope"}</Text>
    </Pressable>
    {AsyncResult.isFailure(native.result) ? <Text accessibilityRole="alert" className="text-danger-foreground">Native themes unavailable. Check the NeoPi connection and update its executable if shared themes are unsupported.</Text> : !native.snapshot ? <Text className="text-sm text-foreground-muted">Native theme changes are unavailable while disconnected. Connect an environment, then refresh.</Text> : (["dark", "light"] as const).map(appearance => {
      const selection = native.snapshot!.selection[appearance];
      return <Pressable key={appearance} accessibilityRole="button" disabled={pending} className="rounded-xl border border-border bg-card p-3" onPress={() => setPicker(appearance)}>
        <Text>{appearance === "dark" ? "Dark theme" : "Light theme"}: {selection.effective}</Text>
        <Text className="text-xs text-foreground-muted">User: {selection.global ?? "default"}. Project: {selection.project ?? "inherited"}.</Text>
      </Pressable>;
    })}
    {error ? <Text accessibilityRole="alert" className="text-danger-foreground">{error}</Text> : null}
    <Pressable accessibilityRole="button" disabled={pending} onPress={refresh} className="self-start rounded-xl border border-border px-3 py-2"><Text>Refresh native themes</Text></Pressable>
    <Modal visible={picker !== null} animationType="none" onRequestClose={() => setPicker(null)} presentationStyle="pageSheet">
      <View className="flex-1 bg-screen px-4 pb-4 pt-12">
        <View className="mb-4 flex-row items-center justify-between">
          <Text className="text-lg font-t3-medium">{picker === "target" ? "Native runtime and scope" : `${picker === "dark" ? "Dark" : "Light"} native theme`}</Text>
          <Pressable accessibilityRole="button" onPress={() => setPicker(null)} className="p-3"><Text>Close</Text></Pressable>
        </View>
        <FlatList data={options} keyExtractor={option => option.key} renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityState={{ selected: picker === "target" ? selected === item.key : selected === item.name }} className="border-b border-border py-4" onPress={() => { void choose(item); }}><Text>{item.label}</Text></Pressable>} ListEmptyComponent={<Text>No connected native runtimes. Add a connection in Settings.</Text>} />
      </View>
    </Modal>
  </View>;
}
