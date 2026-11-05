import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import {
  nativeQueuedDraft,
  type NativeQueueRestoration,
  type NativeRestoredMedia,
} from "@t3tools/client-runtime/neopi-native-queue";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { nativeWorkspaceResourceId } from "@t3tools/shared/neopiWorkspace";
import {
  replaceComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import {
  previewAnnotationFromRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
} from "../../lib/composerContextRecords";
import {
  producerIdFromComposerContextId,
  toKindScopedComposerContextId,
} from "../../lib/composerContextReferences";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { readPreparedConnection } from "../../state/session";
import { pendingDraftWork } from "../chat/pendingDraftWork";
import { readFileAsDataUrl } from "../ChatView.logic";
import { startAttachmentUpload } from "../../lib/attachmentUploadQueue";

async function loadNativeQueuedMedia(target: NativeSessionTarget, media: NativeRestoredMedia) {
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId: target.environmentId,
      input: { resource: media.resource },
    }),
    { refresh: true, reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const connection = readPreparedConnection(target.environmentId);
  const url = connection ? resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl) : null;
  if (!url) throw new Error("Reconnect to restore this attachment.");
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Attachment download failed (HTTP ${response.status}).`);
  return response.blob();
}

/** Queue withdrawal merges into the latest draft, including edits made while media downloads. */
export async function restoreNativeQueuedDraft(
  target: NativeSessionTarget,
  restoration: NativeQueueRestoration,
  loadMedia: (
    target: NativeSessionTarget,
    media: NativeRestoredMedia,
  ) => Promise<Blob> = loadNativeQueuedMedia,
): Promise<string | null> {
  if (!restoration.messages.length)
    return restoration.truncated ? "NeoPi could not return every queued message." : null;
  const restored = nativeQueuedDraft(target, restoration.messages, randomUUID);
  const images: ComposerImageAttachment[] = [];
  const files: ComposerFileAttachment[] = [];
  const persisted: PersistedComposerImageAttachment[] = [];
  const failed = new Map<
    string,
    { name: string; contextId: ReturnType<typeof toKindScopedComposerContextId> }
  >();
  const key = composerTargetKey(target);
  pendingDraftWork.begin(key);
  try {
    for (const media of restored.media) {
      const record = media.record;
      const id = producerIdFromComposerContextId(record.kind, record.contextId);
      try {
        const blob = media.image
          ? new Blob(
              [Uint8Array.from(atob(media.image.data), (character) => character.charCodeAt(0))],
              { type: media.image.mimeType },
            )
          : await loadMedia(target, media);
        const file = new File([blob], record.name, {
          type: media.image?.mimeType ?? (record.mimeType || blob.type),
        });
        if (record.kind === "image") {
          const dataUrl = media.image
            ? `data:${media.image.mimeType};base64,${media.image.data}`
            : await readFileAsDataUrl(file);
          images.push({
            type: "image",
            id,
            name: record.name,
            mimeType: file.type,
            sizeBytes: file.size,
            file,
            previewUrl: dataUrl,
          });
          persisted.push({
            id,
            name: record.name,
            mimeType: file.type,
            sizeBytes: file.size,
            dataUrl,
          });
        } else
          files.push({
            type: "file",
            id,
            name: record.name,
            mimeType: file.type,
            sizeBytes: file.size,
            file,
          });
      } catch {
        // Keep an explicit reattach marker rather than silently discarding unavailable bytes.
        const contextId = toKindScopedComposerContextId("file", id);
        failed.set(record.contextId, { name: record.name, contextId });
        files.push({
          type: "file",
          id,
          name: record.name,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          file: null,
        });
      }
    }
    const text = replaceComposerContextReferences(restored.text, (reference) => {
      const missing = failed.get(reference.contextId);
      return formatComposerContextReference(
        missing ? { kind: "file", contextId: missing.contextId, label: missing.name } : reference,
      );
    });
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(target)?.prompt ?? "";
    store.setPrompt(target, text && current ? `${text}\n\n${current}` : text || current);
    // This is recovery, not a fresh attach action: preserve all media above the send cap.
    // The composer then asks the user to split the draft instead of losing queued input.
    useComposerDraftStore.setState((state) => {
      const draft = state.draftsByThreadKey[key];
      if (!draft) return state;
      return {
        draftsByThreadKey: {
          ...state.draftsByThreadKey,
          [key]: {
            ...draft,
            images: [...draft.images, ...images],
            files: [...draft.files, ...files],
            terminalContexts: [
              ...draft.terminalContexts,
              ...restored.records.flatMap((record) =>
                record.kind === "terminal"
                  ? [terminalContextDraftFromRecord(record, nativeWorkspaceResourceId(target.ref))]
                  : [],
              ),
            ],
            previewAnnotations: [
              ...draft.previewAnnotations,
              ...restored.records.flatMap((record) =>
                record.kind === "preview-annotation" ? [previewAnnotationFromRecord(record)] : [],
              ),
            ],
            reviewComments: [
              ...draft.reviewComments,
              ...restored.records.flatMap((record) =>
                record.kind === "review-comment" ? [reviewCommentFromRecord(record)] : [],
              ),
            ],
          },
        },
      };
    });
    if (persisted.length)
      await useComposerDraftStore
        .getState()
        .syncPersistedAttachments(target, [
          ...(useComposerDraftStore.getState().getComposerDraft(target)?.persistedAttachments ??
            []),
          ...persisted,
        ]);
    // The upload queue keeps running when this workspace unmounts and persists the
    // new pending IDs on this exact draft, so restored files survive a session switch.
    for (const file of files)
      if (file.file)
        startAttachmentUpload({
          environmentId: target.environmentId,
          image: file,
          draftTarget: target,
        });
  } finally {
    pendingDraftWork.end(key);
  }
  return (
    [
      failed.size
        ? `Reattach these unavailable files: ${[...failed.values()].map((file) => file.name).join(", ")}.`
        : null,
      restoration.imagesDropped
        ? "NeoPi omitted oversized image data from its queue response."
        : null,
      restoration.truncated
        ? "NeoPi could not return every queued message because its response limit was exceeded."
        : null,
    ]
      .filter(Boolean)
      .join(" ") || null
  );
}
