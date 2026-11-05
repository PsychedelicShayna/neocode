import { workspaceKey } from "@t3tools/client-runtime/environment";
import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import {
  nativeQueuedDraft,
  type NativeQueueRestoration,
  type NativeRestoredMedia,
} from "@t3tools/client-runtime/neopi-native-queue";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import * as Option from "effect/Option";
import { downloadAttachmentForPreview } from "../lib/attachmentDownload";
import { estimateBase64ByteSize } from "../lib/base64";
import { persistComposerAttachmentFile, type DraftComposerAttachment } from "../lib/composerImages";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { assetEnvironment } from "./assets";
import { environmentSession } from "./session";
import {
  flushComposerDrafts,
  prependRecoveredComposerDraft,
  setComposerContextImporting,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";

const pendingRestores = new Map<string, number>();

async function loadNativeQueuedMedia(
  target: NativeSessionTarget,
  media: NativeRestoredMedia,
): Promise<DraftComposerAttachment> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId: target.environmentId,
      input: { resource: media.resource },
    }),
    { refresh: true, reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(target.environmentId),
  );
  const url = Option.isSome(connection)
    ? resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl)
    : null;
  if (!url) throw new Error("Reconnect to restore this attachment.");
  const temporary = await downloadAttachmentForPreview({
    attachment: media.record,
    url,
    signal: new AbortController().signal,
  });
  if (!temporary) throw new Error("Attachment restoration was cancelled.");
  try {
    const fileUri = await persistComposerAttachmentFile(temporary.uri, media.record.name);
    const { File } = await import("expo-file-system");
    const common = {
      id: media.record.contextId,
      fileUri,
      name: media.record.name,
      mimeType: media.record.mimeType,
      sizeBytes: new File(fileUri).size,
    };
    return media.record.kind === "image"
      ? { ...common, type: "image", previewUri: fileUri }
      : { ...common, type: "file" };
  } finally {
    temporary.dispose();
  }
}

/** Both Stop and Cancel restore into the current durable draft without replacing newer input. */
export async function restoreNativeMobileQueuedDraft(
  target: NativeSessionTarget,
  restoration: NativeQueueRestoration,
  loadMedia: (
    target: NativeSessionTarget,
    media: NativeRestoredMedia,
  ) => Promise<DraftComposerAttachment> = loadNativeQueuedMedia,
): Promise<string | null> {
  if (!restoration.messages.length)
    return restoration.truncated ? "NeoPi could not return every queued message." : null;
  const key = workspaceKey(target);
  const restored = nativeQueuedDraft(target, restoration.messages, uuidv4);
  const attachments: DraftComposerAttachment[] = [];
  const failures: string[] = [];
  const pending = pendingRestores.get(key) ?? 0;
  pendingRestores.set(key, pending + 1);
  if (pending === 0) setComposerContextImporting(key, true);
  try {
    await waitForComposerDraftsLoaded();
    for (const media of restored.media) {
      try {
        if (media.image) {
          const dataUrl = `data:${media.image.mimeType};base64,${media.image.data}`;
          attachments.push({
            type: "image",
            id: media.record.contextId,
            name: media.record.name,
            mimeType: media.image.mimeType,
            sizeBytes: estimateBase64ByteSize(media.image.data),
            previewUri: dataUrl,
            dataUrl,
          });
        } else attachments.push(await loadMedia(target, media));
      } catch {
        failures.push(media.record.name);
      }
    }
    const attached = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    prependRecoveredComposerDraft(key, {
      text: restored.text,
      context: {
        version: 1,
        records: restored.records.map((record) => {
          const attachment = attached.get(record.contextId);
          return (record.kind === "image" || record.kind === "file") && attachment
            ? {
                ...record,
                attachmentId: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
              }
            : record;
        }),
      },
      attachments,
    });
    await flushComposerDrafts();
  } finally {
    const remaining = (pendingRestores.get(key) ?? 1) - 1;
    if (remaining > 0) pendingRestores.set(key, remaining);
    else {
      pendingRestores.delete(key);
      setComposerContextImporting(key, false);
    }
  }
  return (
    [
      failures.length ? `Reattach these unavailable files: ${failures.join(", ")}.` : null,
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
