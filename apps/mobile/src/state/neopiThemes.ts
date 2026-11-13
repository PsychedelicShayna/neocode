import { useAtomValue } from "@effect/atom-react";
import { createNeoPiThemesState } from "@t3tools/client-runtime/state/neopiThemes";
import type {
  EnvironmentId,
  NeoPiModelsTarget,
  NeoPiThemesConfiguration,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { useProjects, useServerConfigs } from "./entities";
import { mobilePreferencesAtom } from "./preferences";

const state = createNeoPiThemesState(connectionAtomRuntime);
export const neopiThemesPalette = state.palette;
const empty = Atom.make(AsyncResult.success(null as NeoPiThemesConfiguration | null));

export interface MobileNeoPiThemeTarget {
  readonly key: string;
  readonly label: string;
  readonly environmentId: EnvironmentId;
  readonly target: NeoPiModelsTarget;
}

/** The opt-in catalog is read once; terminal theme selections never drive this device. */
export function useMobileNeoPiThemeCatalog() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const stored = AsyncResult.isSuccess(preferences) ? preferences.value : null;
  const enabled = stored?.nativeThemeCatalogEnabled === true;
  const { environments } = useEnvironments();
  const projects = useProjects();
  const configs = useServerConfigs();
  const choices = useMemo(
    () =>
      environments.flatMap((environment) =>
        (configs.get(environment.environmentId)?.providers ?? [])
          .filter((provider) => provider.driver === "neopi" && provider.enabled)
          .flatMap((provider) => {
            const make = (project: (typeof projects)[number] | null): MobileNeoPiThemeTarget => ({
              key: JSON.stringify([
                environment.environmentId,
                provider.instanceId,
                project?.id ?? null,
              ]),
              label: `${environment.label} / ${provider.displayName ?? "NeoPi"} / ${project?.title ?? "User scope"}`,
              environmentId: environment.environmentId,
              target: {
                providerInstanceId: provider.instanceId,
                ...(project ? { projectId: project.id } : {}),
              },
            });
            return [
              make(null),
              ...projects
                .filter((project) => project.environmentId === environment.environmentId)
                .map(make),
            ];
          }),
      ),
    [environments, projects, configs],
  );
  const target = stored?.nativeThemeTarget
    ? (choices.find((choice) => choice.key === stored.nativeThemeTarget) ?? null)
    : (choices[0] ?? null);
  const atom: Atom.Atom<Atom.Type<ReturnType<typeof state.read>> | Atom.Type<typeof empty>> =
    enabled && target
      ? state.read({ environmentId: target.environmentId, input: { target: target.target } })
      : empty;
  const result = useAtomValue(atom);
  const catalog = AsyncResult.isSuccess(result) ? result.value : null;
  return { choices, target, result, catalog, enabled, atom, stored };
}
