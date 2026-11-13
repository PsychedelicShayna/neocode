import { workspaceResourceId, type WorkspaceRef } from "@t3tools/client-runtime/environment";
import { randomUUID } from "../lib/utils";

const rendererId = randomUUID();

/** IDs isolate renderers, workspaces and server restarts; server tab ids are process-local. */
export function previewRuntimeTabId(
  threadRef: WorkspaceRef,
  serverEpoch: string | null,
  tabId: string,
): string {
  return JSON.stringify([
    rendererId,
    threadRef.environmentId,
    workspaceResourceId(threadRef),
    serverEpoch,
    tabId,
  ]);
}
