import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";
import { flushSync } from "react-dom";
import {
  composerTargetKey,
  persistComposerDraftSnapshot,
  readComposerDraftSnapshot,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { toKindScopedComposerContextId } from "../../lib/composerContextReferences";
import {
  buildMessageContext,
  previewAnnotationContextId,
  reviewCommentContextId,
  terminalContextReference,
} from "../../lib/composerContextRecords";
import { readFileAsDataUrl } from "../ChatView.logic";

/** Capture the initiating editor; an old send must never focus a replacement session's editor. */
export function captureNativeComposerFocus(ref: {
  readonly current: { focusAtEnd(): void } | null;
}): () => void {
  const composer = ref.current;
  return () => {
    if (composer !== null && ref.current === composer) composer.focusAtEnd();
  };
}
const NativeDraftConsumption = Schema.Struct({
  key: Schema.String,
  snapshot: Schema.Unknown,
  images: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      mimeType: Schema.String,
      sizeBytes: Schema.Number,
      file: Schema.instanceOf(File),
    }),
  ),
});
const isNativeDraftConsumption = Schema.is(NativeDraftConsumption);

// Records pass through persistence and terminal normalization. Referential identity
// distinguishes neither an unchanged hydrated record nor an actual same-ID edit.
function sameRecord(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  // JSON persistence omits optional properties whose value is undefined.
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return (
    keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameRecord(a[key], b[key]))
  );
}

/** Upload the submitted snapshot, not whatever draft happens to be visible after the await. */
export async function prepareNativePrompt(
  target: NativeSessionTarget,
  snapshot: ComposerThreadDraftState,
) {
  const media = [...snapshot.images, ...snapshot.files];
  for (const attachment of media) {
    startAttachmentUpload({
      environmentId: target.environmentId,
      image: attachment,
      draftTarget: target,
    });
  }
  await awaitAttachmentUploads(media.map((attachment) => attachment.id));
  const attachments = getUploadedAttachments({
    environmentId: target.environmentId,
    images: media,
  });
  if (!attachments) {
    const missing = media.find((attachment) => {
      const upload = readAttachmentUpload(attachment.id);
      return upload?.status !== "ready" || upload.environmentId !== target.environmentId;
    });
    const upload = missing ? readAttachmentUpload(missing.id) : undefined;
    throw new Error(
      upload?.status === "failed"
        ? upload.reason
        : `Attachment '${missing?.name ?? "file"}' did not finish uploading.`,
    );
  }
  const context = buildMessageContext({
    terminalContexts: snapshot.terminalContexts,
    reviewComments: snapshot.reviewComments,
    previewAnnotations: snapshot.previewAnnotations,
    attachments: media.map((attachment, index) => ({
      attachment,
      attachmentId: attachments[index]!.id,
    })),
  });
  return {
    message: serializeLegacyContextMessage({
      text: snapshot.prompt,
      records: context?.records ?? [],
    }),
    attachments,
  };
}

function hasRevisedRecord<T extends { id: string }>(
  submitted: readonly T[],
  current: readonly T[],
) {
  return submitted.some((sent) =>
    current.some((record) => record.id === sent.id && !sameRecord(record, sent)),
  );
}

/** Remove only accepted content; edits and newly added records/media survive an in-flight send. */
export function remainingNativeDraft(
  current: ComposerThreadDraftState,
  submitted: ComposerThreadDraftState,
): ComposerThreadDraftState {
  if (
    !current.prompt.startsWith(submitted.prompt) ||
    hasRevisedRecord(submitted.terminalContexts, current.terminalContexts) ||
    hasRevisedRecord(submitted.previewAnnotations, current.previewAnnotations) ||
    hasRevisedRecord(submitted.reviewComments, current.reviewComments) ||
    submitted.images.some((sent) =>
      current.images.some((image) => image.id === sent.id && image.file !== sent.file),
    ) ||
    submitted.files.some((sent) =>
      current.files.some((file) => file.id === sent.id && file.file !== sent.file),
    )
  )
    return current;
  const prompt = current.prompt.slice(submitted.prompt.length);
  const referenced = new Set<string>(
    collectComposerContextReferences(prompt).map((reference) => reference.contextId),
  );
  const images = current.images.filter(
    (image) =>
      !submitted.images.some((sent) => sent.id === image.id && sent.file === image.file) ||
      referenced.has(toKindScopedComposerContextId("image", image.id)),
  );
  const files = current.files.filter(
    (file) =>
      !submitted.files.some((sent) => sent.id === file.id && sent.file === file.file) ||
      referenced.has(toKindScopedComposerContextId("file", file.id)),
  );
  const terminalContexts = current.terminalContexts.filter(
    (context) =>
      !submitted.terminalContexts.some((sent) => sameRecord(sent, context)) ||
      referenced.has(terminalContextReference(context).contextId),
  );
  const previewAnnotations = current.previewAnnotations.filter(
    (annotation) =>
      !submitted.previewAnnotations.some((sent) => sameRecord(sent, annotation)) ||
      referenced.has(previewAnnotationContextId(annotation.id)),
  );
  const reviewComments = current.reviewComments.filter(
    (comment) =>
      !submitted.reviewComments.some((sent) => sameRecord(sent, comment)) ||
      referenced.has(reviewCommentContextId(comment.id)),
  );
  const imageIds = new Set(images.map((image) => image.id));
  return {
    ...current,
    prompt,
    images,
    files,
    terminalContexts,
    previewAnnotations,
    reviewComments,
    persistedAttachments: current.persistedAttachments.filter((image) => imageIds.has(image.id)),
    nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => imageIds.has(id)),
  };
}

function consumeDraftSnapshot(
  key: string,
  consume: (current: ComposerThreadDraftState) => ComposerThreadDraftState,
) {
  const consumed: (
    | ComposerThreadDraftState["images"][number]
    | ComposerThreadDraftState["files"][number]
  )[] = [];
  // The caller restores imperative editor focus immediately after acceptance.
  // Commit the controlled value first: moving an old mid-text caret to the end
  // otherwise reports the old editor snapshot and resurrects the accepted text.
  flushSync(() => {
    useComposerDraftStore.setState((state) => {
      const current = state.draftsByThreadKey[key];
      if (!current) return state;
      const remaining = consume(current);
      if (remaining === current) return state;
      consumed.push(
        ...current.images.filter((image) => !remaining.images.includes(image)),
        ...current.files.filter((file) => !remaining.files.includes(file)),
      );
      return { draftsByThreadKey: { ...state.draftsByThreadKey, [key]: remaining } };
    });
  });
  // Native prompt acceptance guarantees durable model-readable copies before these draft uploads leave.
  releaseDraftAttachments(consumed);
  for (const attachment of consumed) {
    if (attachment.type === "image" && attachment.previewUrl.startsWith("blob:"))
      URL.revokeObjectURL(attachment.previewUrl);
  }
}

/** Match durable media identities without hydrating another copy of accepted files. */
export function remainingNativePersistedDraft(
  current: ComposerThreadDraftState,
  submitted: NonNullable<ReturnType<typeof readComposerDraftSnapshot>>,
  imageDataUrls?: ReadonlyMap<File, string>,
) {
  const images = current.images.filter((image) =>
    submitted.attachments.some(
      (sent) =>
        sent.id === image.id &&
        sent.name === image.name &&
        sent.mimeType === image.mimeType &&
        sent.sizeBytes === image.sizeBytes &&
        imageDataUrls?.get(image.file) === sent.dataUrl,
    ),
  );
  const files = current.files.filter((file) =>
    submitted.files?.some(
      (sent) =>
        sent.id === file.id &&
        sent.attachmentId !== undefined &&
        sent.attachmentId === file.uploadedAttachmentId &&
        sent.environmentId === file.uploadEnvironmentId,
    ),
  );
  return remainingNativeDraft(current, {
    ...current,
    prompt: submitted.prompt,
    images,
    files,
    terminalContexts: (submitted.terminalContexts ?? []).map((context) => ({
      ...context,
      text: context.text ?? "",
    })),
    previewAnnotations: [...(submitted.previewAnnotations ?? [])],
    reviewComments: [...(submitted.reviewComments ?? [])],
  });
}

/** Apply just accepted native content, never a remote window's entire draft store. */
export async function consumeNativeDraftNotification(value: unknown) {
  if (!isNativeDraftConsumption(value)) return;
  const submitted = readComposerDraftSnapshot(value.snapshot);
  const current = useComposerDraftStore.getState().draftsByThreadKey[value.key];
  if (!submitted || !current) return;
  const acceptedImages: PersistedComposerImageAttachment[] = [];
  const imageDataUrls = new Map<File, string>();
  await Promise.all([
    ...value.images.map(async (image) => {
      if (!current.images.some((local) => local.id === image.id)) return;
      try {
        acceptedImages.push({
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: await readFileAsDataUrl(image.file),
        });
      } catch {
        // Missing byte evidence must not consume an observer's local image.
      }
    }),
    ...current.images.map(async (image) => {
      if (!value.images.some((sent) => sent.id === image.id)) return;
      try {
        imageDataUrls.set(image.file, await readFileAsDataUrl(image.file));
      } catch {
        // A replacement introduced during this read has a different File identity.
      }
    }),
  ]);
  consumeDraftSnapshot(value.key, (draft) =>
    remainingNativePersistedDraft(
      draft,
      { ...submitted, attachments: acceptedImages },
      imageDataUrls,
    ),
  );
}

export function consumeNativeDraft(
  target: NativeSessionTarget,
  submitted: ComposerThreadDraftState,
  attachments: NonNullable<ReturnType<typeof getUploadedAttachments>>,
) {
  const key = composerTargetKey(target);
  consumeDraftSnapshot(key, (draft) => remainingNativeDraft(draft, submitted));
  const files = submitted.files.map((file, index) => {
    const uploaded = attachments[submitted.images.length + index];
    return {
      ...file,
      ...(uploaded
        ? { uploadedAttachmentId: uploaded.id, uploadEnvironmentId: target.environmentId }
        : {}),
    };
  });
  // Broadcast immutable Files rather than base64 strings: acceptance must not
  // wait for image reads or retain another copy in quota-limited localStorage.
  try {
    nativeDraftChannel?.postMessage({
      key,
      snapshot: persistComposerDraftSnapshot({
        ...submitted,
        persistedAttachments: [],
        files,
      }) ?? { prompt: submitted.prompt, attachments: [] },
      images: submitted.images.map(({ id, name, mimeType, sizeBytes, file }) => ({
        id,
        name,
        mimeType,
        sizeBytes,
        file,
      })),
    });
  } catch (cause) {
    // Native acceptance is durable even if another window cannot be notified.
    console.error("Could not notify other windows of accepted native draft content.", cause);
  }
}

const nativeDraftChannel =
  typeof window !== "undefined" && typeof window.BroadcastChannel === "function"
    ? new window.BroadcastChannel("neocode:native-draft-consumed")
    : null;
nativeDraftChannel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  void consumeNativeDraftNotification(event.data).catch((cause) => {
    console.error("Could not consume accepted native draft content in this window.", cause);
  });
});
import.meta.hot?.dispose(() => nativeDraftChannel?.close());
