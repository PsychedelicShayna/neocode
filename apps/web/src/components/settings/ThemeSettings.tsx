import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, NeoPiModelsTarget, NeoPiThemesConfiguration, ProviderInstanceId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useTheme } from "../../hooks/useTheme";
import { setFollowNeoPiTheme, useFollowNeoPiTheme } from "../../neopiThemePreference";
import { useServerConfigs } from "../../state/entities";
import { neopiThemesUpdate, neopiThemesWatch } from "../../state/neopiThemes";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { getThemeDefinition } from "../../themePalette";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";

export function ThemeLibrary() {
  const { targets } = useSettingsScope();
  const configs = useServerConfigs();
  const { theme, appearanceMode, setAppearanceMode, setTheme } = useTheme();
  const saved = useCustomThemes();
  const follow = useFollowNeoPiTheme();
  const [error, setError] = useState<string | null>(null);
  const palette = getThemeDefinition(theme);
  const savedChoices = useMemo(() => {
    const choices = saved.map(item => ({ id: item.id, label: item.label }));
    if (palette && !choices.some(item => item.id === palette.id)) choices.unshift({ id: palette.id, label: palette.label });
    return choices;
  }, [saved, palette]);
  const changeFollow = (next: boolean) => {
    try { setFollowNeoPiTheme(next); setError(null); }
    catch { setError("Could not save this browser's theme preference. Your saved palettes are unchanged."); }
  };
  return <div className="space-y-6">
    <div className="space-y-2">
      <h2 className="text-base font-medium">NeoPi themes</h2>
      <p className="text-sm text-muted-foreground">The same dark and light selections as terminal Settings → Appearance. Changes below are saved by NeoPi, not in a separate graphical catalog.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={follow ? "secondary" : "default"} onClick={() => changeFollow(!follow)}>
          {follow ? "Use saved graphical palette instead" : "Follow NeoPi themes"}
        </Button>
        <span className="text-xs text-muted-foreground">{follow ? "Following native selections on this client" : `Keeping saved graphical palette: ${palette?.label ?? theme}`}</span>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
    {targets.length === 0 ? <p role="status" className="text-sm text-muted-foreground">Connect an environment to read or change its native themes.</p> : targets.map(target => {
      const providers = configs.get(target.environmentId)?.providers.filter(item => item.driver === "neopi" && item.enabled) ?? [];
      return <NativeThemeTarget key={`${target.environmentId}:${target.projectId ?? "global"}`} environmentId={target.environmentId} projectId={target.projectId} label={target.label} providers={providers.map(item => ({ id: item.instanceId, label: item.displayName ?? "NeoPi" }))} />;
    })}
    <div className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">This graphical client</h3>
      <p className="text-xs text-muted-foreground">Appearance mode, fonts, sizes, contrast and layout stay separate from native shared settings. Your named palettes and previous selection remain stored when you follow NeoPi.</p>
      <label className="flex items-center justify-between gap-4 text-sm">
        Appearance mode
        <Select value={appearanceMode} onValueChange={value => { if (value === "light" || value === "dark" || value === "system") setAppearanceMode(value); }}>
          <SelectTrigger aria-label="Appearance mode" size="sm"><SelectValue /></SelectTrigger>
          <SelectPopup><SelectItem value="system">System</SelectItem><SelectItem value="dark">Dark</SelectItem><SelectItem value="light">Light</SelectItem></SelectPopup>
        </Select>
      </label>
      {savedChoices.length > 0 ? <label className="flex items-center justify-between gap-4 text-sm">
        Preserved graphical palettes
        <Select value={theme} onValueChange={value => { if (value && setTheme(value)) changeFollow(false); }}>
          <SelectTrigger aria-label="Preserved graphical palette" size="sm"><SelectValue /></SelectTrigger>
          <SelectPopup>{savedChoices.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectPopup>
        </Select>
      </label> : null}
    </div>
  </div>;
}

function NativeThemeTarget({ environmentId, projectId, label, providers }: {
  environmentId: EnvironmentId;
  projectId: NeoPiModelsTarget["projectId"] | null;
  label: string;
  providers: ReadonlyArray<{ id: ProviderInstanceId; label: string }>;
}) {
  const [chosen, setChosen] = useState<ProviderInstanceId | null>(null);
  const provider = providers.find(item => item.id === chosen) ?? providers[0];
  return <section className="space-y-3 rounded-lg border p-4">
    <h3 className="text-sm font-medium">{label} · {projectId ? "Project scope" : "User scope"}</h3>
    {providers.length > 1 ? <Select value={provider?.id ?? ""} onValueChange={value => setChosen(providers.find(item => item.id === value)?.id ?? null)}>
      <SelectTrigger aria-label="NeoPi runtime profile" size="sm"><SelectValue /></SelectTrigger>
      <SelectPopup>{providers.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectPopup>
    </Select> : null}
    {provider ? <NativeThemeSelections key={provider.id} environmentId={environmentId} target={{ providerInstanceId: provider.id, ...(projectId ? { projectId } : {}) }} /> : <p role="status" className="text-sm text-muted-foreground">No enabled NeoPi runtime. Configure a connection in NeoCore.</p>}
  </section>;
}

function NativeThemeSelections({ environmentId, target }: { environmentId: EnvironmentId; target: NeoPiModelsTarget }) {
  const atom = neopiThemesWatch({ environmentId, input: { target } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const update = useAtomCommand(neopiThemesUpdate, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot: NeoPiThemesConfiguration | null = AsyncResult.isSuccess(result) ? result.value : null;
  const scope = target.projectId ? "project" : "global";
  const save = async (appearance: "dark" | "light", name: string | null) => {
    if (!snapshot || pending) return;
    setPending(true); setError(null);
    try {
      const response = await update({ environmentId, input: { target, appearance, scope, name, expected: snapshot.selection[appearance][scope] } });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this native theme. Refresh before trying again.");
      refresh();
    } finally { setPending(false); }
  };
  return <div className="space-y-3" aria-busy={pending || result.waiting}>
    {AsyncResult.isFailure(result) ? <p role="alert" className="text-sm text-destructive">{formatEnvironmentQueryError(result.cause)}</p> : !snapshot ? <p role="status" className="text-sm text-muted-foreground">Waiting for a connected NeoPi theme snapshot. Theme changes are unavailable while disconnected.</p> : <>
      {(["dark", "light"] as const).map(appearance => {
        const selected = snapshot.selection[appearance];
        return <div key={appearance} className="space-y-1">
          <label className="flex items-center justify-between gap-4 text-sm">
            {appearance === "dark" ? "Dark theme" : "Light theme"}
            <Select disabled={pending} value={JSON.stringify(selected[scope])} onValueChange={value => {
              if (value === "null") { void save(appearance, null); return; }
              const name = snapshot.themes.find(item => JSON.stringify(item) === value);
              if (name !== undefined) void save(appearance, name);
            }}>
              <SelectTrigger aria-label={`${appearance} native theme`} size="sm"><SelectValue /></SelectTrigger>
              <SelectPopup>
                <SelectItem value="null">Inherit</SelectItem>
                {!snapshot.themes.includes(selected[scope] ?? "") && selected[scope] !== null ? <SelectItem value={JSON.stringify(selected[scope])}>{selected[scope]} · unavailable</SelectItem> : null}
                {snapshot.themes.map(name => <SelectItem key={name} value={JSON.stringify(name)}>{name}</SelectItem>)}
              </SelectPopup>
            </Select>
          </label>
          <p className="text-xs text-muted-foreground">Effective: {selected.effective}. User: {selected.global ?? "default"}. Project: {selected.project ?? "inherited"}.</p>
        </div>;
      })}
      <p className="text-xs text-muted-foreground">Project selections override user selections. Inherit removes only this scope. Terminal and connected graphical clients reconcile native setting changes.</p>
    </>}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <Button size="sm" variant="outline" disabled={pending} onClick={() => refresh()}>Refresh native themes</Button>
  </div>;
}
