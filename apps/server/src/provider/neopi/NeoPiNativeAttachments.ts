import {
  getProviderAttachmentLimitError,
  NeoPiNativeSessionsError,
  type NeoPiNativeSessionCommand,
  type NeoPiNativeSessionsRequestInput,
} from "@t3tools/contracts";
import { nativeWorkspaceResourceId } from "@t3tools/shared/neopiWorkspace";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { planAttachmentClaim, resolveAttachmentPath } from "../../attachmentStore.ts";

const Prompt = Schema.Struct({
  type: Schema.Literal("prompt"),
  message: Schema.String,
  images: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal("image"),
        data: Schema.String,
        mimeType: Schema.String,
      }),
    ),
  ),
});
const decodePrompt = Schema.decodeUnknownEffect(Prompt);
const isNativeError = Schema.is(NeoPiNativeSessionsError);
const attachmentError = (message: string) =>
  new NeoPiNativeSessionsError({ message, code: "invalid_attachment" });

/** Promote uploads into durable workspace files without creating a SQL conversation. */
export const prepareNeoPiNativePrompt = Effect.fn("NeoPiNativeSessions.preparePrompt")(function* (
  input: NeoPiNativeSessionsRequestInput,
  attachmentsDir: string,
): Effect.fn.Return<NeoPiNativeSessionCommand, NeoPiNativeSessionsError, FileSystem.FileSystem> {
  const attachments = input.attachments;
  if (!attachments?.length) return input.command;
  const prompt = yield* decodePrompt(input.command).pipe(
    Effect.mapError(() => attachmentError("Attachments require a native prompt message.")),
  );
  const limitError = getProviderAttachmentLimitError(attachments);
  if (limitError) return yield* attachmentError(limitError);
  const ids = new Set<string>();
  for (const attachment of attachments) {
    if (ids.has(attachment.id))
      return yield* attachmentError(`Attachment '${attachment.name}' has a duplicate upload id.`);
    ids.add(attachment.id);
  }

  const fs = yield* FileSystem.FileSystem;
  const claimedPaths: string[] = [];
  return yield* Effect.gen(function* () {
    const images = [...(prompt.images ?? [])];
    const text = [prompt.message];
    const promotedIds = new Map<string, string>();
    const namespace = nativeWorkspaceResourceId(input.ref);
    for (const attachment of attachments) {
      const claim = planAttachmentClaim({
        attachmentsDir,
        threadId: namespace,
        attachmentId: attachment.id,
      });
      if (!claim.ok)
        return yield* attachmentError(
          `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
        );
      const info = yield* fs.stat(claim.currentPath);
      if (Number(info.size) !== attachment.sizeBytes)
        return yield* attachmentError(
          `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
        );
      const mimeType = attachment.mimeType.toLowerCase();
      if (
        resolveAttachmentPath({
          attachmentsDir,
          attachment: { ...attachment, id: claim.finalId, mimeType },
        }) !== claim.finalPath
      )
        return yield* attachmentError(
          `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
        );

      // Keep the pending upload retryable and isolated from edits to the delivered file.
      claimedPaths.push(claim.finalPath);
      yield* fs.copyFile(claim.currentPath, claim.finalPath);
      promotedIds.set(attachment.id, claim.finalId);
      if (attachment.type === "image") {
        const bytes = yield* fs.readFile(claim.finalPath);
        images.push({ type: "image", data: Encoding.encodeBase64(bytes), mimeType });
      } else {
        text.push(`Attached file "${attachment.name}": "${claim.finalPath}"`);
      }
    }
    const context = upgradeLegacyContextMessage(prompt.message);
    const message =
      context.records.length > 0
        ? serializeLegacyContextMessage({
            text: [context.text, ...text.slice(1)].filter(Boolean).join("\n\n"),
            records: context.records.map((record) =>
              "attachmentId" in record &&
              typeof record.attachmentId === "string" &&
              promotedIds.has(record.attachmentId)
                ? { ...record, attachmentId: promotedIds.get(record.attachmentId)! }
                : record,
            ),
          })
        : text.filter(Boolean).join("\n\n");
    return {
      ...input.command,
      message,
      ...(images.length ? { images } : {}),
    };
  }).pipe(
    Effect.mapError((cause) =>
      isNativeError(cause)
        ? cause
        : attachmentError(`Unable to prepare native attachments: ${cause.message}`),
    ),
    // Once dispatched, a transport failure may still mean admission: retain durable copies.
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.forEach(claimedPaths, (path) =>
            fs.remove(path, { force: true }).pipe(Effect.ignore),
          ).pipe(Effect.asVoid)
        : Effect.void,
    ),
  );
});
