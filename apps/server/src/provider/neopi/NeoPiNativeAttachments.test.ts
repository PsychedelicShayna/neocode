// @effect-diagnostics nodeBuiltinImport:off -- Private filesystem fixtures verify durable attachment delivery.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  ComposerContextId,
  ProviderInstanceId,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type NeoPiNativeSessionsRequestInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  createPendingAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "../../attachmentStore.ts";
import { prepareNeoPiNativePrompt } from "./NeoPiNativeAttachments.ts";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";

const ref = {
  providerInstanceId: ProviderInstanceId.make("native"),
  sessionFile: "/sessions/a.jsonl",
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = NodePath.join(NodeOS.tmpdir(), "neocode-native-attachments");
  yield* fs.makeDirectory(root, { recursive: true });
  const directory = yield* fs.makeTempDirectoryScoped({ directory: root });
  const upload = Effect.fnUntraced(function* (type: "file" | "image", contents: string) {
    const attachment: ChatFileAttachment | ChatImageAttachment = {
      type,
      id: createPendingAttachmentId(type === "image" ? ".png" : ".txt"),
      name: type === "image" ? "image.png" : "notes.txt",
      mimeType: type === "image" ? "image/png" : "text/plain",
      sizeBytes: new TextEncoder().encode(contents).length,
    };
    const path = resolveAttachmentPath({ attachmentsDir: directory, attachment });
    if (!path) throw new Error("Fixture attachment path is invalid");
    yield* fs.writeFileString(path, contents);
    return { attachment, path };
  });
  const prepare = (
    attachments: NonNullable<NeoPiNativeSessionsRequestInput["attachments"]>,
    message = "",
  ) =>
    prepareNeoPiNativePrompt({ ref, command: { type: "prompt", message }, attachments }, directory);
  return { fs, directory, upload, prepare };
});
const preparedImages = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
  ),
);

// File paths are native prompt payloads, not SQL attachment records.
const filePathFromPrompt = (message: unknown): string => {
  if (typeof message !== "string") throw new Error("Missing native prompt text");
  const match = message.match(/Attached file "notes.txt": "([^"]+)"/);
  if (!match?.[1]) throw new Error("Missing durable file path");
  return match[1];
};

describe("native prompt attachments", () => {
  it.effect(
    "delivers image bytes and durable file copies while leaving pending uploads retryable",
    () =>
      Effect.gen(function* () {
        const { fs, upload, prepare } = yield* fixture;
        const image = yield* upload("image", "image-bytes");
        const file = yield* upload("file", "original notes");
        const command = yield* prepare([image.attachment, file.attachment], "Inspect these");
        expect(preparedImages(command.images)).toEqual([
          { type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" },
        ]);
        expect(command.message).toContain("Inspect these\n\nAttached file");
        const delivered = filePathFromPrompt(command.message);
        expect(delivered).not.toBe(file.path);
        expect(yield* fs.readFileString(delivered)).toBe("original notes");
        yield* fs.writeFileString(delivered, "agent edit");
        expect(yield* fs.readFileString(file.path)).toBe("original notes");
        const retry = yield* prepare([image.attachment, file.attachment]);
        expect(preparedImages(retry.images)).toEqual(preparedImages(command.images));
        const retriedPath = filePathFromPrompt(retry.message);
        expect(retriedPath).not.toBe(delivered);
        yield* fs.remove(file.path);
        yield* fs.remove(image.path);
        expect(yield* fs.readFileString(retriedPath)).toBe("original notes");
        expect(yield* fs.readFileString(delivered)).toBe("agent edit");
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect(
    "writes durable attachment IDs into queued context so another client can restore after upload cleanup",
    () =>
      Effect.gen(function* () {
        const { fs, directory, upload, prepare } = yield* fixture;
        const image = yield* upload("image", "image-bytes");
        const file = yield* upload("file", "notes");
        const message = serializeLegacyContextMessage({
          text: "Inspect the queued attachments",
          records: [
            {
              version: 1,
              kind: "image",
              contextId: ComposerContextId.make("image_draft"),
              label: "Image",
              attachmentId: image.attachment.id,
              name: image.attachment.name,
              mimeType: image.attachment.mimeType,
              sizeBytes: image.attachment.sizeBytes,
            },
            {
              version: 1,
              kind: "file",
              contextId: ComposerContextId.make("file_draft"),
              label: "Notes",
              attachmentId: file.attachment.id,
              name: file.attachment.name,
              mimeType: file.attachment.mimeType,
              sizeBytes: file.attachment.sizeBytes,
            },
          ],
        });
        const command = yield* prepare([image.attachment, file.attachment], message);
        if (typeof command.message !== "string") throw new Error("Missing native prompt");
        const restored = upgradeLegacyContextMessage(command.message);
        const ids = restored.records.flatMap((record) =>
          "attachmentId" in record && typeof record.attachmentId === "string"
            ? [record.attachmentId]
            : [],
        );
        expect(ids).toHaveLength(2);
        expect(ids).not.toContain(image.attachment.id);
        expect(ids).not.toContain(file.attachment.id);
        yield* fs.remove(image.path);
        yield* fs.remove(file.path);
        for (const id of ids) {
          const path = resolveAttachmentPathById({ attachmentsDir: directory, attachmentId: id });
          if (!path) throw new Error("Promoted attachment is not addressable");
          expect(yield* fs.exists(path)).toBe(true);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("preserves canonical inline images when appending uploaded images", () =>
    Effect.gen(function* () {
      const { directory, upload } = yield* fixture;
      const image = yield* upload("image", "uploaded");
      const inline = { type: "image", data: "aW5saW5l", mimeType: "image/webp" };
      const command = yield* prepareNeoPiNativePrompt(
        {
          ref,
          command: { type: "prompt", message: "", images: [inline] },
          attachments: [image.attachment],
        },
        directory,
      );
      expect(preparedImages(command.images)).toEqual([
        inline,
        { type: "image", data: "dXBsb2FkZWQ=", mimeType: "image/png" },
      ]);
      expect(command.message).toBe("");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("rejects undiscriminated prompt images before promoting any uploads", () =>
    Effect.gen(function* () {
      const { fs, directory, upload } = yield* fixture;
      const image = yield* upload("image", "uploaded");
      const before = yield* fs.readDirectory(directory);
      const result = yield* prepareNeoPiNativePrompt(
        {
          ref,
          command: {
            type: "prompt",
            message: "",
            images: [{ data: "aW5saW5l", mimeType: "image/webp" }],
          },
          attachments: [image.attachment],
        },
        directory,
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("invalid_attachment");
      expect(yield* fs.readDirectory(directory)).toEqual(before);
      expect(yield* fs.readFileString(image.path)).toBe("uploaded");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("removes partial promotions on validation failure without consuming any upload", () =>
    Effect.gen(function* () {
      const { fs, directory, upload, prepare } = yield* fixture;
      const first = yield* upload("file", "first");
      const second = yield* upload("file", "second");
      const before = (yield* fs.readDirectory(directory)).sort();
      const result = yield* prepare([
        first.attachment,
        { ...second.attachment, sizeBytes: second.attachment.sizeBytes + 1 },
      ]).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toContain("stored size does not match");
      expect((yield* fs.readDirectory(directory)).sort()).toEqual(before);
      expect(yield* fs.readFileString(first.path)).toBe("first");
      expect(yield* fs.readFileString(second.path)).toBe("second");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect(
    "rejects duplicate, already-claimed, and type-mismatched uploads without creating files",
    () =>
      Effect.gen(function* () {
        const { fs, directory, upload, prepare } = yield* fixture;
        const file = yield* upload("file", "notes");
        const before = yield* fs.readDirectory(directory);
        for (const attachments of [
          [file.attachment, file.attachment],
          [{ ...file.attachment, id: file.attachment.id.replace("pending-", "another-session-") }],
          [{ ...file.attachment, name: "changed.pdf" }],
        ]) {
          const result = yield* prepare(attachments).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.code).toBe("invalid_attachment");
          expect(yield* fs.readDirectory(directory)).toEqual(before);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("rejects attachments on non-prompt commands rather than silently dropping them", () =>
    Effect.gen(function* () {
      const { fs, directory, upload } = yield* fixture;
      const file = yield* upload("file", "notes");
      const before = yield* fs.readDirectory(directory);
      const result = yield* prepareNeoPiNativePrompt(
        {
          ref,
          command: { type: "abort" },
          attachments: [file.attachment],
        },
        directory,
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toBe("Attachments require a native prompt message.");
      expect(yield* fs.readDirectory(directory)).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
