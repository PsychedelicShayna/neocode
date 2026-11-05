import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  NeoPiModelsTarget,
  NeoPiThemesConfiguration,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useTheme } from "../../hooks/useTheme";
import {
  beginNeoPiThemeSelection,
  neoPiClientThemeSourceName,
  saveNeoPiClientTheme,
} from "../../neopiLocalTheme";
import { setShowNeoPiThemes, useShowNeoPiThemes } from "../../neopiThemeCatalogPreference";
import { useServerConfigs } from "../../state/entities";
import { neopiThemesPalette, neopiThemesRead } from "../../state/neopiThemes";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getThemeDefinition,
  getStandardThemeColors,
  neoPiThemeColors,
  resolveThemeHalf,
} from "../../themePalette";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";

export function ThemeLibrary() {
  const { targets } = useSettingsScope();
  const configs = useServerConfigs();
  const { theme, themeHalves, appearanceMode, setAppearanceMode, setTheme } = useTheme();
  const saved = useCustomThemes();
  const showCatalog = useShowNeoPiThemes();
  const [error, setError] = useState<string | null>(null);
  const palette = getThemeDefinition(theme);
  const savedChoices = useMemo(() => {
    const choices = saved.map((item) => ({ id: item.id, label: item.label }));
    if (palette && !choices.some((item) => item.id === palette.id))
      choices.unshift({ id: palette.id, label: palette.label });
    return choices;
  }, [saved, palette]);
  const changeCatalog = (next: boolean) => {
    try {
      setShowNeoPiThemes(next);
      setError(null);
    } catch {
      setError("Could not save this browser's catalog preference. Your palettes are unchanged.");
    }
  };
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-base font-medium">NeoPi themes</h2>
        <p className="text-sm text-muted-foreground">
          Optionally browse the connected NeoPi runtime's themes and choose a local palette. This is
          off by default. NeoCode never changes NeoPi's theme or follows its active selection.
        </p>
        <Button
          variant={showCatalog ? "secondary" : "default"}
          aria-pressed={showCatalog}
          onClick={() => changeCatalog(!showCatalog)}
        >
          Show NeoPi themes
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      {showCatalog ? (
        targets.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Connect an environment to browse its themes.
          </p>
        ) : (
          targets.map((target) => {
            const providers =
              configs
                .get(target.environmentId)
                ?.providers.filter((item) => item.driver === "neopi" && item.enabled) ?? [];
            return (
              <NativeThemeTarget
                key={`${target.environmentId}:${target.projectId ?? "global"}`}
                environmentId={target.environmentId}
                projectId={target.projectId}
                label={target.label}
                providers={providers.map((item) => ({
                  id: item.instanceId,
                  label: item.displayName ?? "NeoPi",
                }))}
              />
            );
          })
        )
      ) : null}
      <div className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-medium">This graphical client</h3>
        <p className="text-xs text-muted-foreground">
          Appearance mode, palettes, fonts, sizes, contrast and layout stay local. Hiding the NeoPi
          catalog leaves your chosen palette unchanged.
        </p>
        <label className="flex items-center justify-between gap-4 text-sm">
          Appearance mode
          <Select
            value={appearanceMode}
            onValueChange={(value) => {
              if (value === "light" || value === "dark" || value === "system")
                setAppearanceMode(value);
            }}
          >
            <SelectTrigger aria-label="Appearance mode" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="light">Light</SelectItem>
            </SelectPopup>
          </Select>
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">
          Graphical palette
          <Select
            value={themeHalves ? "mixed" : (palette?.id ?? "system")}
            onValueChange={(value) => {
              if (value && value !== "mixed") setTheme(value);
            }}
          >
            <SelectTrigger aria-label="Graphical palette" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="system">Neo default</SelectItem>
              {themeHalves ? (
                <SelectItem value="mixed" disabled>
                  Per-appearance choices
                </SelectItem>
              ) : null}
              {savedChoices.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
      </div>
    </div>
  );
}

function NativeThemeTarget({
  environmentId,
  projectId,
  label,
  providers,
}: {
  environmentId: EnvironmentId;
  projectId: NeoPiModelsTarget["projectId"] | null;
  label: string;
  providers: ReadonlyArray<{ id: ProviderInstanceId; label: string }>;
}) {
  const [chosen, setChosen] = useState<ProviderInstanceId | null>(null);
  const provider = providers.find((item) => item.id === chosen) ?? providers[0];
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium">
        {label} · {projectId ? "Project catalog" : "User catalog"}
      </h3>
      {providers.length > 1 ? (
        <Select
          value={provider?.id ?? ""}
          onValueChange={(value) =>
            setChosen(providers.find((item) => item.id === value)?.id ?? null)
          }
        >
          <SelectTrigger aria-label="NeoPi runtime profile" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {providers.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      {provider ? (
        <NativeThemeSelections
          key={provider.id}
          environmentId={environmentId}
          target={{ providerInstanceId: provider.id, ...(projectId ? { projectId } : {}) }}
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          No enabled NeoPi runtime. Configure a connection in NeoCore.
        </p>
      )}
    </section>
  );
}

function NativeThemeSelections({
  environmentId,
  target,
}: {
  environmentId: EnvironmentId;
  target: NeoPiModelsTarget;
}) {
  const atom = neopiThemesRead({ environmentId, input: { target } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const readPalette = useAtomCommand(neopiThemesPalette, { reportFailure: false });
  const { theme, themeHalves, setThemeHalf, refreshTheme } = useTheme();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot: NeoPiThemesConfiguration | null = AsyncResult.isSuccess(result)
    ? result.value
    : null;
  const currentRequest = useRef<ReturnType<typeof beginNeoPiThemeSelection> | null>(null);
  useLayoutEffect(
    () => () => {
      currentRequest.current?.cancel();
      currentRequest.current = null;
    },
    [],
  );
  const select = async (appearance: "dark" | "light", name: string | null) => {
    if (currentRequest.current) return;
    const request = beginNeoPiThemeSelection();
    currentRequest.current = request;
    const canApply = () => currentRequest.current === request && request.isCurrent();
    setPending(true);
    setError(null);
    try {
      let colors = getStandardThemeColors(appearance);
      if (name !== null) {
        const response = await readPalette({ environmentId, input: { target, name } });
        if (!canApply()) return;
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
        colors = neoPiThemeColors(appearance, response.value.colors);
      }
      if (!canApply()) return;
      const selected = saveNeoPiClientTheme(appearance, name, colors);
      const replacesCurrent = resolveThemeHalf(theme, themeHalves, appearance) === selected.id;
      if (!setThemeHalf(appearance, selected.id))
        throw new Error("Could not save this client's palette selection.");
      if (replacesCurrent) refreshTheme();
    } catch (cause) {
      if (canApply()) {
        setError(
          cause instanceof Error ? cause.message : "Could not read or save this local palette.",
        );
      }
    } finally {
      request.cancel();
      if (currentRequest.current === request) {
        currentRequest.current = null;
        setPending(false);
      }
    }
  };
  return (
    <div className="space-y-3" aria-busy={pending || result.waiting}>
      {AsyncResult.isFailure(result) ? (
        <p role="alert" className="text-sm text-destructive">
          {formatEnvironmentQueryError(result.cause)}
        </p>
      ) : !snapshot ? (
        <p role="status" className="text-sm text-muted-foreground">
          Waiting for a connected NeoPi theme catalog.
        </p>
      ) : (
        <>
          {(["dark", "light"] as const).map((appearance) => {
            const current = getThemeDefinition(resolveThemeHalf(theme, themeHalves, appearance));
            const selected = neoPiClientThemeSourceName(current);
            const selectedValue = selected === undefined ? "saved-local" : JSON.stringify(selected);
            return (
              <div key={appearance} className="space-y-1">
                <label className="flex items-center justify-between gap-4 text-sm">
                  {appearance === "dark" ? "Dark palette" : "Light palette"}
                  <Select
                    disabled={pending}
                    value={selectedValue}
                    onValueChange={(value) => {
                      if (value === "null") {
                        void select(appearance, null);
                        return;
                      }
                      const next = snapshot.themes.find((item) => JSON.stringify(item) === value);
                      if (next !== undefined) void select(appearance, next);
                    }}
                  >
                    <SelectTrigger aria-label={`${appearance} local NeoPi palette`} size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="null">Neo default</SelectItem>
                      {selected !== null &&
                      (selected === undefined || !snapshot.themes.includes(selected)) ? (
                        <SelectItem value={selectedValue} disabled>
                          {selected ?? current?.label ?? "Current palette"} · saved locally
                        </SelectItem>
                      ) : null}
                      {snapshot.themes.map((item) => (
                        <SelectItem key={item} value={JSON.stringify(item)}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Selections are saved only in this client and remain available offline. Native theme
            changes do not replace them.
          </p>
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => refresh()}>
        Refresh NeoPi catalog
      </Button>
    </div>
  );
}
