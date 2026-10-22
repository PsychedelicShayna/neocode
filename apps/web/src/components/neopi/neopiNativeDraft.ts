import type { NeoPiNavigateTreeResult, ScopedThreadRef } from "@t3tools/contracts";
import { nativeIdentityKey, type NativeIdentity } from "@t3tools/client-runtime/neopi-conversation";
import { useEffect } from "react";
import * as Schema from "effect/Schema";
import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { randomUUID } from "../../lib/utils";

const bindingKey = (threadRef: ScopedThreadRef) =>
  `neocode:native-draft-binding:${composerTargetKey(threadRef)}`;
const draftKey = (threadRef: ScopedThreadRef, identity: NativeIdentity) =>
  `native:${JSON.stringify([threadRef.environmentId, nativeIdentityKey(identity)])}`;

export function switchNativeDraftIdentity(threadRef: ScopedThreadRef, identity: NativeIdentity) {
  const key = draftKey(threadRef, identity);
  const alias = composerTargetKey(threadRef);
  const previousKey = getLocalStorageItem(bindingKey(threadRef), Schema.String);
  useComposerDraftStore.setState((state) => {
    const aliasDraft = state.draftsByThreadKey[alias];
    const saved = state.draftsByThreadKey[key];
    const next = { ...state.draftsByThreadKey };
    if (previousKey && previousKey !== key && aliasDraft) next[previousKey] = aliasDraft;
    if (previousKey !== key && saved) next[alias] = saved;
    else if (previousKey && previousKey !== key) delete next[alias];
    else if (aliasDraft) next[key] = aliasDraft;
    else if (saved) next[alias] = saved;
    return { draftsByThreadKey: next };
  });
  setLocalStorageItem(bindingKey(threadRef), key, Schema.String);
}

/** Keep composer storage in its existing store, with a canonical-file key behind the thread alias. */
export function useNativeDraftIdentity(
  threadRef: ScopedThreadRef,
  identity: NativeIdentity | null,
) {
  const key = identity ? draftKey(threadRef, identity) : null;
  const alias = composerTargetKey(threadRef);
  useEffect(() => {
    if (!key || !identity) return;
    switchNativeDraftIdentity(threadRef, identity);
    return useComposerDraftStore.subscribe((state) => {
      const draft = state.draftsByThreadKey[alias];
      if (draft === state.draftsByThreadKey[key]) return;
      const next = { ...state.draftsByThreadKey };
      if (draft) next[key] = draft;
      else delete next[key];
      useComposerDraftStore.setState({ draftsByThreadKey: next });
    });
  }, [alias, key, threadRef.environmentId, threadRef.threadId]);
}

export function nativeDraftImages(
  result: Pick<NeoPiNavigateTreeResult, "editorImages">,
): ComposerImageAttachment[] {
  return (result.editorImages ?? []).map((image, index) => {
    const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
    const name = `native-draft-${index + 1}.${image.mimeType.split("/")[1] ?? "image"}`;
    const file = new File([bytes], name, { type: image.mimeType });
    return {
      type: "image",
      id: randomUUID(),
      name,
      mimeType: image.mimeType,
      sizeBytes: file.size,
      file,
      previewUrl: `data:${image.mimeType};base64,${image.data}`,
    };
  });
}

export function restoreNativeDraft(threadRef: ScopedThreadRef, result: NeoPiNavigateTreeResult) {
  if (result.editorText === undefined && result.editorImages === undefined) return;
  // Decode before replacing anything. A malformed native attachment must not erase a local draft.
  const images = nativeDraftImages(result);
  const store = useComposerDraftStore.getState();
  store.clearComposerContent(threadRef);
  store.setPrompt(threadRef, result.editorText ?? "");
  store.addImages(threadRef, images, { allowDuplicates: true });
  // addImages enforces the send cap. Native restored drafts may exceed it, so preserve
  // their complete ordered images in the store rather than silently dropping extras.
  const alias = composerTargetKey(threadRef);
  useComposerDraftStore.setState((state) => {
    const draft = state.draftsByThreadKey[alias];
    if (!draft) return state;
    return { draftsByThreadKey: { ...state.draftsByThreadKey, [alias]: { ...draft, images } } };
  });
}
