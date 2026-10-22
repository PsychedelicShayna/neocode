import type { ScopedThreadRef } from "@t3tools/contracts";

const rendererId = crypto.randomUUID();

/**
 * The server only guarantees preview tab ids are unique within one process.
 * Each renderer owns its webviews, even when windows share the same environment
 * and thread. A reload gets a new identity rather than adopting dead guests.
 */
export function previewRuntimeTabId(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
): string {
  return JSON.stringify([rendererId, threadRef.environmentId, threadRef.threadId, serverEpoch, tabId]);
}

export function isCurrentPreviewRuntimeTab(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
  runtimeTabId: string,
): boolean {
  return previewRuntimeTabId(threadRef, serverEpoch, tabId) === runtimeTabId;
}
