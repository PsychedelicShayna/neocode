import { RegistryContext, useAtomRefresh, useAtomSet } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, View } from "react-native";
import { AppText as Text } from "../../../../components/ui/AppText";
import { neoPiMobileThemeVariables, resolveMobileNeoPiTheme } from "../../../../lib/mobileTheme";
import { neopiThemesPalette, useMobileNeoPiThemeCatalog } from "../../../../state/neopiThemes";
import {
  mobileThemeSelectionRevisionAtom,
  updateMobilePreferencesAtom,
} from "../../../../state/preferences";
import { useAtomCommand } from "../../../../state/use-atom-command";

export function NeoPiThemeSettings() {
  const native = useMobileNeoPiThemeCatalog();
  const registry = useContext(RegistryContext);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const readPalette = useAtomCommand(neopiThemesPalette, { reportFailure: false });
  const refresh = useAtomRefresh(native.atom);
  const [picker, setPicker] = useState<"target" | "dark" | "light" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates outstanding palette reads when this settings screen unmounts
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestVersion.current += 1;
    };
  }, []);
  const options = useMemo<Array<{ key: string; label: string; name: string | null }>>(
    () =>
      picker === "target"
        ? native.choices.map((choice) => ({ key: choice.key, label: choice.label, name: null }))
        : [
            { key: "graphical", label: "Use saved graphical palette", name: null },
            ...(native.catalog?.themes ?? []).map((name) => ({
              key: JSON.stringify(name),
              label: name,
              name,
            })),
          ],
    [picker, native.choices, native.catalog],
  );
  const selected =
    picker === "target"
      ? native.target?.key
      : picker
        ? (resolveMobileNeoPiTheme(native.stored, picker)?.name ?? null)
        : null;
  const choose = async (option: { key: string; name: string | null }) => {
    if (picker === "target") {
      requestVersion.current += 1;
      setPending(false);
      setError(null);
      savePreferences({ nativeThemeTarget: option.key });
      setPicker(null);
      return;
    }
    if (!picker || !native.enabled || pending) return;
    const appearance = picker;
    const preference = appearance === "dark" ? "nativeDarkTheme" : "nativeLightTheme";
    setPicker(null);
    setError(null);
    if (option.name === null) {
      savePreferences({ [preference]: null });
      return;
    }
    if (!native.target) return;
    const selectionRevision = registry.get(mobileThemeSelectionRevisionAtom);
    const version = ++requestVersion.current;
    setPending(true);
    try {
      const response = await readPalette({
        environmentId: native.target.environmentId,
        input: { target: native.target.target, name: option.name },
      });
      if (
        !mounted.current ||
        version !== requestVersion.current ||
        selectionRevision !== registry.get(mobileThemeSelectionRevisionAtom)
      )
        return;
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      const theme = {
        name: response.value.name,
        variables: neoPiMobileThemeVariables(appearance, response.value.colors),
      };
      savePreferences({ [preference]: theme });
    } catch (cause) {
      if (
        mounted.current &&
        version === requestVersion.current &&
        selectionRevision === registry.get(mobileThemeSelectionRevisionAtom)
      ) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not read the NeoPi palette. Your local theme has not changed.",
        );
      }
    } finally {
      if (mounted.current && version === requestVersion.current) setPending(false);
    }
  };
  return (
    <View className="gap-3">
      <Text className="text-base font-t3-medium">NeoPi themes</Text>
      <Text className="text-sm text-foreground-muted">
        Make NeoPi palettes available to choose on this device. Choices are saved locally and never
        change terminal settings.
      </Text>
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: native.enabled }}
        className="rounded-xl border border-border bg-card p-3"
        onPress={() => {
          requestVersion.current += 1;
          setPending(false);
          setError(null);
          setPicker(null);
          savePreferences({ nativeThemeCatalogEnabled: !native.enabled });
        }}
      >
        <Text>{native.enabled ? "Show NeoPi themes: on" : "Show NeoPi themes: off"}</Text>
        <Text className="text-xs text-foreground-muted">
          {native.enabled
            ? "Hide the catalog without changing your chosen local palettes"
            : "Off by default. Showing the catalog does not select the terminal's active theme"}
        </Text>
      </Pressable>
      {!native.enabled && (native.stored?.nativeDarkTheme || native.stored?.nativeLightTheme) ? (
        <Text className="text-sm text-foreground-muted">
          Local palettes: Dark: {native.stored.nativeDarkTheme?.name ?? "Saved graphical palette"};
          Light: {native.stored.nativeLightTheme?.name ?? "Saved graphical palette"}. Select a
          graphical palette below to replace either choice.
        </Text>
      ) : null}
      {native.enabled ? (
        <>
          <Pressable
            accessibilityRole="button"
            className="rounded-xl border border-border bg-card p-3"
            onPress={() => setPicker("target")}
          >
            <Text>{native.target?.label ?? "Choose a connected NeoPi catalog source"}</Text>
          </Pressable>
          {(["dark", "light"] as const).map((appearance) => (
            <Pressable
              key={appearance}
              accessibilityRole="button"
              disabled={pending}
              className="rounded-xl border border-border bg-card p-3"
              onPress={() => setPicker(appearance)}
            >
              <Text>
                {appearance === "dark" ? "Dark" : "Light"} local palette:{" "}
                {resolveMobileNeoPiTheme(native.stored, appearance)?.name ??
                  "Saved graphical palette"}
              </Text>
            </Pressable>
          ))}
          {AsyncResult.isFailure(native.result) ? (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              NeoPi catalog unavailable. Check the connection and NeoPi version. Saved local
              palettes remain available.
            </Text>
          ) : !native.catalog ? (
            <Text className="text-sm text-foreground-muted">
              Connect a NeoPi environment to load its palette catalog. Saved local palettes work
              offline.
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={refresh}
            className="self-start rounded-xl border border-border px-3 py-2"
          >
            <Text>Refresh palette catalog</Text>
          </Pressable>
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Modal
        visible={picker !== null}
        animationType="none"
        onRequestClose={() => setPicker(null)}
        presentationStyle="pageSheet"
      >
        <View className="flex-1 bg-screen px-4 pb-4 pt-12">
          <View className="mb-4 flex-row items-center justify-between">
            <Text className="text-lg font-t3-medium">
              {picker === "target"
                ? "NeoPi catalog source"
                : `${picker === "dark" ? "Dark" : "Light"} local palette`}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => setPicker(null)} className="p-3">
              <Text>Close</Text>
            </Pressable>
          </View>
          <FlatList
            data={options}
            keyExtractor={(option) => option.key}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{
                  selected: picker === "target" ? selected === item.key : selected === item.name,
                }}
                className="border-b border-border py-4"
                onPress={() => {
                  void choose(item);
                }}
              >
                <Text>{item.label}</Text>
              </Pressable>
            )}
            ListEmptyComponent={
              <Text>No connected NeoPi runtimes. Add a connection in Settings.</Text>
            }
          />
        </View>
      </Modal>
    </View>
  );
}
