import { workspaceKey } from "@t3tools/client-runtime/environment";
import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import { useComposerDraftStore, type ComposerThreadDraftState } from "../composerDraftStore";
import { useRightPanelStore, type ThreadRightPanelState } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { useAgentViewStore } from "../components/neopi/agents/agentViewStore";
import { useBrowserHistoryStore } from "../browserHistoryStore";
import {
  beginPreviewSessionClose,
  readThreadPreviewState,
  rememberPreviewUrl,
} from "../previewStateStore";
import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";

function moveEntry<T>(
  entries: Readonly<Record<string, T>>,
  from: string,
  to: string,
  merge?: (source: T, destination: T) => T,
): Record<string, T> {
  const source = entries[from];
  if (from === to || source === undefined) return entries;
  const { [from]: _source, ...next } = entries;
  const destination = entries[to];
  next[to] = destination !== undefined && merge ? merge(source, destination) : source;
  return next;
}

function mergeById<T extends { readonly id: string }>(
  source: readonly T[],
  destination: readonly T[],
) {
  return [...new Map([...destination, ...source].map((entry) => [entry.id, entry])).values()];
}

export function mergeRelocatedComposerDraft(
  source: ComposerThreadDraftState,
  destination: ComposerThreadDraftState,
): ComposerThreadDraftState {
  return {
    ...destination,
    ...source,
    prompt:
      source.prompt === destination.prompt
        ? source.prompt
        : [source.prompt, destination.prompt].filter(Boolean).join("\n\n"),
    images: mergeById(source.images, destination.images),
    files: mergeById(source.files, destination.files),
    nonPersistedImageIds: [
      ...new Set([...source.nonPersistedImageIds, ...destination.nonPersistedImageIds]),
    ],
    persistedAttachments: mergeById(source.persistedAttachments, destination.persistedAttachments),
    terminalContexts: mergeById(source.terminalContexts, destination.terminalContexts),
    previewAnnotations: mergeById(source.previewAnnotations, destination.previewAnnotations),
    reviewComments: mergeById(source.reviewComments, destination.reviewComments),
    modelSelectionByProvider: {
      ...destination.modelSelectionByProvider,
      ...source.modelSelectionByProvider,
    },
  };
}

function mergePanels(
  source: ThreadRightPanelState,
  destination: ThreadRightPanelState,
): ThreadRightPanelState {
  return { ...source, surfaces: mergeById(source.surfaces, destination.surfaces) };
}

/** Move presentation metadata before publishing the new canonical session target. */
export function relocateNativeWorkspace(from: NativeSessionTarget, to: NativeSessionTarget): void {
  const fromKey = workspaceKey(from);
  const toKey = workspaceKey(to);
  if (fromKey === toKey) return;
  // Browser guests are tied to the old workspace namespace. Retain their URLs,
  // not a hidden old-worktree webview or floating player.
  const preview = readThreadPreviewState(from);
  for (const url of preview.recentlySeenUrls) rememberPreviewUrl(to, url);
  for (const snapshot of Object.values(preview.sessions)) {
    if (snapshot.navStatus.kind !== "Idle") rememberPreviewUrl(to, snapshot.navStatus.url);
    beginPreviewSessionClose(from, snapshot.tabId);
  }
  usePreviewMiniPlayerStore.getState().removeThread(from);
  useComposerDraftStore.setState((state) => ({
    draftsByThreadKey: moveEntry(
      state.draftsByThreadKey,
      fromKey,
      toKey,
      mergeRelocatedComposerDraft,
    ),
  }));
  useRightPanelStore.setState((state) => ({
    byThreadKey: moveEntry(state.byThreadKey, fromKey, toKey, mergePanels),
    userActionRevisionByThreadKey: moveEntry(state.userActionRevisionByThreadKey, fromKey, toKey),
  }));
  useTerminalUiStateStore.setState((state) => ({
    terminalUiStateByThreadKey: moveEntry(state.terminalUiStateByThreadKey, fromKey, toKey),
    suppressedTerminalIdsByThreadKey: moveEntry(
      state.suppressedTerminalIdsByThreadKey,
      fromKey,
      toKey,
    ),
  }));
  useDiffPanelStore.setState((state) => ({
    byThreadKey: moveEntry(state.byThreadKey, fromKey, toKey),
    branchBaseRefByThreadKey: moveEntry(state.branchBaseRefByThreadKey, fromKey, toKey),
  }));
  useAgentViewStore.setState((state) => ({ byKey: moveEntry(state.byKey, fromKey, toKey) }));
  useBrowserHistoryStore.setState((state) => ({
    byProjectKey: moveEntry(state.byProjectKey, fromKey, toKey, (source, destination) =>
      [
        ...new Map([...destination, ...source].map((entry) => [entry.url, entry])).values(),
      ].toSorted((a, b) => b.lastVisitedAt - a.lastVisitedAt),
    ),
    projectKeyByThreadKey: moveEntry(state.projectKeyByThreadKey, fromKey, toKey),
    pendingVisitsByThreadKey: moveEntry(state.pendingVisitsByThreadKey, fromKey, toKey),
    pendingTitlesByThreadKey: moveEntry(state.pendingTitlesByThreadKey, fromKey, toKey),
  }));
}
