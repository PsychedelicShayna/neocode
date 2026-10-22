import { useAtomValue } from "@effect/atom-react";
import { createNeoPiThemesState } from "@t3tools/client-runtime/state/neopiThemes";
import type { EnvironmentId, NeoPiModelsTarget, NeoPiThemesConfiguration } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { shouldFollowMobileNeoPiTheme } from "../lib/mobileTheme";
import { useEnvironments } from "./environments";
import { useProjects } from "./entities";
import { mobilePreferencesAtom } from "./preferences";

const state = createNeoPiThemesState(connectionAtomRuntime);
export const neopiThemesUpdate = state.update;
const empty = Atom.make(AsyncResult.success(null as NeoPiThemesConfiguration | null));
export interface MobileNativeThemeTarget { key: string; label: string; environmentId: EnvironmentId; target: NeoPiModelsTarget }
export function useMobileNativeTheme() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const stored = AsyncResult.isSuccess(preferences) ? preferences.value : null;
  const { environments } = useEnvironments();
  const projects = useProjects();
  const choices = useMemo(() => environments.flatMap(environment =>
    (environment.serverConfig?.providers ?? []).filter(provider => provider.driver === "neopi" && provider.enabled).flatMap(provider => {
      const make = (project: typeof projects[number] | null): MobileNativeThemeTarget => ({
        key: JSON.stringify([environment.environmentId, provider.instanceId, project?.id ?? null]),
        label: `${environment.label} / ${provider.displayName ?? "NeoPi"} / ${project?.title ?? "User scope"}`,
        environmentId: environment.environmentId,
        target: { providerInstanceId: provider.instanceId, ...(project ? { projectId: project.id } : {}) },
      });
      return [make(null), ...projects.filter(project => project.environmentId === environment.environmentId).map(make)];
    }),
  ), [environments, projects]);
  const target = stored?.nativeThemeTarget ? choices.find(choice => choice.key === stored.nativeThemeTarget) ?? null : choices[0] ?? null;
  const atom = target && stored ? state.watch({ environmentId: target.environmentId, input: { target: target.target } }) : empty;
  const result = useAtomValue(atom);
  const snapshot = AsyncResult.isSuccess(result) ? result.value : null;
  const follow = shouldFollowMobileNeoPiTheme(stored);
  return { choices, target, result, snapshot, follow, atom };
}
