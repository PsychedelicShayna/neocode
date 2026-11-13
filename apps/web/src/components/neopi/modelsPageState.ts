import { EnvironmentId, ProjectId, type NeoPiModelsTarget } from "@t3tools/contracts";
import { makeNeoPiModelsClientState } from "@t3tools/client-runtime/neopi-models";
import { type AnyRouter, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useProjects } from "../../state/entities";
import {
  useEnvironments,
  useEnvironmentProviders,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { nativeSessionAtoms, useNativeSessionSelection } from "../../state/neopiNativeSessions";
import { useEnvironmentQuery } from "../../state/query";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";

export const neopiModels = makeNeoPiModelsClientState(connectionAtomRuntime);
export interface ModelsSearch {
  environment?: string;
  instance?: string;
  project?: string;
  sessionFile?: string;
  section?: string;
}
type ModelsSearchUpdate = { [Key in keyof ModelsSearch]?: string | undefined };
export function validateModelsSearch(raw: Record<string, unknown>): ModelsSearch {
  return Object.fromEntries(
    ["environment", "instance", "project", "sessionFile", "section"].flatMap((key) =>
      typeof raw[key] === "string" && raw[key] !== "" ? [[key, raw[key]]] : [],
    ),
  );
}
export function useModelsPageTarget() {
  const search = useLocation({ select: (location) => validateModelsSearch(location.search) });
  // The page stays mounted while the route leaves it. Its search is gone by then, and a target
  // rebuilt from nothing would start an instance-level watch, a whole NeoPi process, for nothing.
  const onModelsRoute = useLocation({ select: (location) => location.pathname === "/models" });
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const selected = useNativeSessionSelection((state) => state.target);
  const environmentId = search.environment
    ? EnvironmentId.make(search.environment)
    : (selected?.environmentId ?? primary);
  const providersByEnvironment = useEnvironmentProviders();
  const providers = environmentId
    ? (providersByEnvironment
        .get(environmentId)
        ?.filter((provider) => provider.driver === "neopi" && provider.enabled) ?? [])
    : [];
  const selectedInstanceId =
    search.instance ??
    (selected?.environmentId === environmentId ? selected.ref.providerInstanceId : undefined);
  const provider = selectedInstanceId
    ? providers.find((provider) => provider.instanceId === selectedInstanceId)
    : providers[0];
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const matchingSession =
    selected?.environmentId === environmentId &&
    selected.ref.providerInstanceId === provider?.instanceId &&
    selected.ref.sessionFile === search.sessionFile
      ? selected
      : null;
  const nativeCwd = matchingSession
    ? nativeSessionAtoms.cached(matchingSession)?.session?.cwd
    : undefined;
  const projectId = search.project
    ? ProjectId.make(search.project)
    : matchingSession
      ? projects.find((project) => project.workspaceRoot === nativeCwd)?.id
      : undefined;
  const providerInstanceId = provider?.instanceId;
  const target: NeoPiModelsTarget | null =
    providerInstanceId && onModelsRoute
      ? {
          providerInstanceId,
          ...(projectId ? { projectId } : {}),
          ...(search.sessionFile ? { sessionFile: search.sessionFile } : {}),
        }
      : null;
  const inventory = useEnvironmentQuery(
    environmentId && target?.sessionFile
      ? nativeSessionAtoms.list({ environmentId, input: {} })
      : null,
  );
  const connectedOwner =
    inventory.isSuccess &&
    environments.some(
      (environment) =>
        environment.environmentId === environmentId && environment.connection.phase === "connected",
    ) &&
    inventory.data?.sessions.some(
      (session) =>
        session.owner.kind === "neocode" &&
        session.ref.providerInstanceId === target?.providerInstanceId &&
        session.ref.sessionFile === target?.sessionFile,
    ) === true;
  const changeSearch = (patch: ModelsSearchUpdate) =>
    void navigate({
      to: "/models",
      search: validateModelsSearch({
        ...search,
        ...(["environment", "instance", "project"].some((key) => Object.hasOwn(patch, key))
          ? { sessionFile: undefined }
          : {}),
        ...patch,
      }),
      replace: true,
    });
  return {
    search,
    environmentId,
    environments,
    providers,
    selectedInstanceId,
    provider,
    projects,
    projectId,
    target,
    connectedOwner,
    changeSearch,
  };
}
export function openModels(router: AnyRouter) {
  if (router.state.location.pathname === "/models") return;
  const selected = useNativeSessionSelection.getState().target;
  const routeTarget = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const activeEnvironment =
    routeTarget?.kind === "server"
      ? routeTarget.threadRef.environmentId
      : routeTarget?.kind === "draft"
        ? useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)?.environmentId
        : undefined;
  void router.navigate({
    to: "/models",
    search: selected
      ? {
          environment: selected.environmentId,
          instance: selected.ref.providerInstanceId,
          sessionFile: selected.ref.sessionFile,
        }
      : activeEnvironment
        ? { environment: activeEnvironment }
        : {},
  });
}

export function useOpenModels() {
  const router = useRouter();
  return () => openModels(router);
}
