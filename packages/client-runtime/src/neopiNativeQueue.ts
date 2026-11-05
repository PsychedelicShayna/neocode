import {
  ComposerContextId,
  type AssetResource,
  type FileContextRecord,
  type ImageContextRecord,
  type KnownComposerContextRecord,
} from "@t3tools/contracts";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";
import type { NativeSessionTarget } from "./neopiNativeSessions.ts";

export const NATIVE_ABORT_RESTORE_QUEUE_CAPABILITY = "abort_and_restore_queue";
const Image = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
const QueuedInput = Schema.Struct({
  text: Schema.String,
  images: Schema.optional(Schema.Array(Image)),
});
export type NativeQueuedInput = typeof QueuedInput.Type;
const RemovedInput = Schema.Struct({
  removed: Schema.Boolean,
  images: Schema.optional(Schema.Array(Image)),
  imagesDropped: Schema.optional(Schema.Boolean),
});
const InterruptedInput = Schema.Struct({
  steering: Schema.Array(QueuedInput),
  followUp: Schema.Array(QueuedInput),
  imagesDropped: Schema.optional(Schema.Boolean),
  truncated: Schema.optional(Schema.Boolean),
});
export interface NativeQueueRestoration {
  readonly messages: readonly NativeQueuedInput[];
  readonly imagesDropped?: boolean | undefined;
  readonly truncated?: boolean | undefined;
}
type Request = (command: { type: string; [key: string]: unknown }) => Promise<unknown>;

/** A successful transport does not mean the queued input was still removable. */
export async function takeNativeQueuedInput(
  request: Request,
  queued: { text: string; lane: "steering" | "followUp" },
): Promise<NativeQueueRestoration | null> {
  const result = Schema.decodeUnknownSync(RemovedInput)(
    await request({ type: "remove_queued_message", message: queued.text, queue: queued.lane }),
  );
  return result.removed
    ? {
        messages: [{ text: queued.text, images: result.images }],
        imagesDropped: result.imagesDropped,
      }
    : null;
}

/** Older peers keep their existing abort semantics; never emulate atomic withdrawal with resends. */
export async function interruptNativeQueuedInput(
  request: Request,
  capabilities: readonly string[],
): Promise<NativeQueueRestoration> {
  if (!capabilities.includes(NATIVE_ABORT_RESTORE_QUEUE_CAPABILITY)) {
    await request({ type: "abort" });
    return { messages: [] };
  }
  const result = Schema.decodeUnknownSync(InterruptedInput)(
    await request({ type: "abort_and_restore_queue" }),
  );
  return {
    messages: [...result.steering, ...result.followUp],
    imagesDropped: result.imagesDropped,
    truncated: result.truncated,
  };
}

export interface NativeRestoredMedia {
  readonly record: ImageContextRecord | FileContextRecord;
  readonly image?: typeof Image.Type;
  readonly resource: AssetResource;
}

/** Recover binaries from the response or durable context records, independent of the sending window. */
export function nativeQueuedDraft(
  target: NativeSessionTarget,
  messages: readonly NativeQueuedInput[],
  createId: () => string,
) {
  const parts: string[] = [];
  const records: KnownComposerContextRecord[] = [];
  const media: NativeRestoredMedia[] = [];
  for (const message of messages) {
    // Older servers appended native file paths after the trailing legacy context blocks.
    let queuedText = message.text;
    const suffixes: string[] = [];
    for (;;) {
      const at = queuedText.lastIndexOf('\n\nAttached file "');
      if (at < 0) break;
      const suffix = queuedText.slice(at);
      if (!/^\n\nAttached file "[\s\S]*": "[^"\n]+"$/.test(suffix)) break;
      suffixes.unshift(suffix.slice(2));
      queuedText = queuedText.slice(0, at);
    }
    const context = upgradeLegacyContextMessage(queuedText);
    context.text = [context.text, ...suffixes].filter(Boolean).join("\n\n");
    const known = context.records.filter(
      (record): record is KnownComposerContextRecord => !("payload" in record),
    );
    const ids = new Map(
      known.map((record) => [
        record.contextId,
        ComposerContextId.make(`${record.kind}_${createId()}`),
      ]),
    );
    // Web annotation drafts bind screenshots by the same producer id.
    for (const record of known)
      if (
        record.kind === "preview-annotation" &&
        record.screenshotContextId &&
        ids.has(record.screenshotContextId)
      )
        ids.set(
          record.screenshotContextId,
          ComposerContextId.make(
            `image_${ids.get(record.contextId)!.slice("preview-annotation_".length)}`,
          ),
        );
    const text = replaceComposerContextReferences(context.text, (reference) =>
      formatComposerContextReference({
        ...reference,
        contextId: ids.get(reference.contextId) ?? reference.contextId,
      }),
    );
    if (text) parts.push(text);
    const extraImageCount = Math.max(
      0,
      (message.images?.length ?? 0) - known.filter((record) => record.kind === "image").length,
    );
    let imageIndex = extraImageCount;
    for (const original of known) {
      const contextId = ids.get(original.contextId)!;
      const record = {
        ...original,
        contextId,
        ...(original.kind === "preview-annotation"
          ? {
              annotationId: contextId.slice("preview-annotation_".length),
              ...(original.screenshotContextId
                ? {
                    screenshotContextId:
                      ids.get(original.screenshotContextId) ?? original.screenshotContextId,
                  }
                : {}),
            }
          : {}),
      };
      records.push(record);
      if (record.kind !== "image" && record.kind !== "file") continue;
      const image = record.kind === "image" ? message.images?.[imageIndex++] : undefined;
      // Before durable IDs were written into context, native files travelled as this
      // model-readable suffix. Keep old queued inputs recoverable after their upload expired.
      const prefix = `Attached file "${record.name}": "`;
      const pathStart = record.kind === "file" ? context.text.lastIndexOf(prefix) : -1;
      const path =
        pathStart >= 0 ? context.text.slice(pathStart + prefix.length).split('"')[0] : undefined;
      media.push({
        record,
        ...(image ? { image } : {}),
        resource:
          record.attachmentId.startsWith("pending-") && path
            ? { _tag: "native-media-file", ref: target.ref, path }
            : { _tag: "attachment", attachmentId: record.attachmentId, fileName: record.name },
      });
    }
    const namedFiles = new Set(
      known.flatMap((record) => (record.kind === "file" ? [record.name] : [])),
    );
    for (const match of context.text.matchAll(
      /^Attached file "([\s\S]*?)": "([^"\n]+)"(?=\n|$)/gm,
    )) {
      const name = match[1]!;
      const path = match[2]!;
      if (namedFiles.has(name)) continue;
      const contextId = ComposerContextId.make(`file_${createId()}`);
      const record: FileContextRecord = {
        version: 1,
        kind: "file",
        contextId,
        attachmentId: contextId,
        label: name,
        name,
        mimeType: "application/octet-stream",
        sizeBytes: 0,
      };
      records.push(record);
      media.push({ record, resource: { _tag: "native-media-file", ref: target.ref, path } });
    }
    // Images from older GUIs and the TUI have no serialized attachment record.
    for (const image of (message.images ?? []).slice(0, extraImageCount)) {
      const contextId = ComposerContextId.make(`image_${createId()}`);
      const record: ImageContextRecord = {
        version: 1,
        kind: "image",
        contextId,
        attachmentId: contextId,
        label: "Native image",
        name: `native-image.${image.mimeType.split("/")[1] ?? "png"}`,
        mimeType: image.mimeType,
        sizeBytes: Math.max(
          0,
          Math.floor((image.data.length * 3) / 4) -
            (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0),
        ),
      };
      records.push(record);
      media.push({ record, image, resource: { _tag: "attachment", attachmentId: contextId } });
    }
  }
  let text = parts.join("\n\n");
  const referenced = new Set(collectComposerContextReferences(text).map((ref) => ref.contextId));
  for (const { record } of media)
    if (!referenced.has(record.contextId))
      text += `${text ? "\n\n" : ""}${formatComposerContextReference(record)}`;
  return { text, records, media };
}
