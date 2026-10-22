import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, type NeoPiModelsTarget } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { makeNeoPiModelsClientState } from "@t3tools/client-runtime/neopi-models";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useActiveEnvironmentId, useProjects, useServerConfigs, useThreadShell } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { resolveThreadRouteRef } from "../../threadRoutes";

export const neopiModels = makeNeoPiModelsClientState(connectionAtomRuntime);
export interface ModelsSearch { environment?: string; instance?: string; project?: string; thread?: string; section?: string }
export function validateModelsSearch(raw: Record<string, unknown>): ModelsSearch {
  return Object.fromEntries(["environment", "instance", "project", "thread", "section"].flatMap(key => typeof raw[key] === "string" && raw[key] !== "" ? [[key, raw[key]]] : []));
}
export function useModelsPageTarget() {
  const search = useLocation({ select: location => validateModelsSearch(location.search) });
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const environmentId = search.environment ? EnvironmentId.make(search.environment) : primary;
  const configs = useServerConfigs();
  const providers = environmentId ? configs.get(environmentId)?.providers.filter(provider => provider.driver === "neopi" && provider.enabled) ?? [] : [];
  const threadRef = environmentId && search.thread ? scopeThreadRef(environmentId, ThreadId.make(search.thread)) : null;
  const thread = useThreadShell(threadRef);
  const selectedInstanceId = search.instance ?? thread?.session?.providerInstanceId ?? thread?.modelSelection.instanceId;
  const provider = selectedInstanceId ? providers.find(provider => provider.instanceId === selectedInstanceId) : providers[0];
  const projects = useProjects().filter(project => project.environmentId === environmentId);
  const projectId = search.project ? ProjectId.make(search.project) : thread?.projectId;
  const target: NeoPiModelsTarget | null = provider ? {
    providerInstanceId: ProviderInstanceId.make(provider.instanceId), ...(projectId ? { projectId } : {}), ...(search.thread ? { threadId: ThreadId.make(search.thread) } : {}),
  } : null;
  const changeSearch = (patch: ModelsSearch) => void navigate({ to: "/models", search: { ...search, ...patch }, replace: true });
  return { search, environmentId, environments, providers, provider, projects, projectId, target, changeSearch };
}
export function useOpenModels() {
  const navigate = useNavigate();
  const ref = useParams({ strict: false, select: params => resolveThreadRouteRef(params) });
  const thread = useThreadShell(ref);
  const activeEnvironment = useActiveEnvironmentId();
  const isOpen = useLocation({ select: location => location.pathname === "/models" });
  return useCallback(() => {
    if (isOpen) return;
    void navigate({ to: "/models", search: ref ? {
      environment: ref.environmentId, thread: ref.threadId, project: thread?.projectId,
      instance: thread?.session?.providerInstanceId ?? thread?.modelSelection.instanceId,
    } : { ...(activeEnvironment ? { environment: activeEnvironment } : {}) } });
  }, [navigate, ref, thread, activeEnvironment, isOpen]);
}
