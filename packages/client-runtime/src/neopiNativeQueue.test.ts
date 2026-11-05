import {
  ComposerContextId,
  EnvironmentId,
  ProviderInstanceId,
  type ImageContextRecord,
  type FileContextRecord,
} from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  NATIVE_ABORT_RESTORE_QUEUE_CAPABILITY,
  interruptNativeQueuedInput,
  nativeQueuedDraft,
  takeNativeQueuedInput,
} from "./neopiNativeQueue.ts";

const target = {
  environmentId: EnvironmentId.make("remote"),
  ref: { providerInstanceId: ProviderInstanceId.make("native"), sessionFile: "/sessions/a.jsonl" },
};
const image = { type: "image" as const, data: "YWJj", mimeType: "image/png" };
const imageRecord: ImageContextRecord = {
  version: 1,
  kind: "image",
  contextId: ComposerContextId.make("image_original"),
  label: "Screenshot",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 3,
  attachmentId: "durable-image",
};
const fileRecord: FileContextRecord = {
  version: 1,
  kind: "file",
  contextId: ComposerContextId.make("file_original"),
  label: "Notes",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 3,
  attachmentId: "durable-file",
};
const message = (records: (ImageContextRecord | FileContextRecord)[]) =>
  serializeLegacyContextMessage({
    text: records.map(formatComposerContextReference).join(" "),
    records,
  });

it("does not restore a queue item that dispatched before cancellation", async () => {
  const request = vi.fn(async () => ({ removed: false }));
  expect(
    await takeNativeQueuedInput(request, { text: "already sent", lane: "steering" }),
  ).toBeNull();
  expect(request).toHaveBeenCalledOnce();
});

it("returns native attachment bytes only after a successful removal", async () => {
  const result = await takeNativeQueuedInput(async () => ({ removed: true, images: [image] }), {
    text: "queued",
    lane: "followUp",
  });
  expect(result?.messages).toEqual([{ text: "queued", images: [image] }]);
});

it("atomically withdraws both lanes oldest-first when advertised", async () => {
  const request = vi.fn(async () => ({
    steering: [{ text: "steer one", images: [image] }, { text: "steer two" }],
    followUp: [{ text: "follow up" }],
    imagesDropped: true,
    truncated: true,
  }));
  expect(
    await interruptNativeQueuedInput(request, [NATIVE_ABORT_RESTORE_QUEUE_CAPABILITY]),
  ).toEqual({
    messages: [
      { text: "steer one", images: [image] },
      { text: "steer two" },
      { text: "follow up" },
    ],
    imagesDropped: true,
    truncated: true,
  });
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: "abort_and_restore_queue" });
});

it("preserves old-peer abort behavior without attempting queue emulation", async () => {
  const request = vi.fn(async () => null);
  expect(await interruptNativeQueuedInput(request, [])).toEqual({ messages: [] });
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: "abort" });
});

it("does not replay or abort again after an ambiguous atomic-withdrawal failure", async () => {
  const request = vi.fn(async () => {
    throw new Error("Disconnected after dispatch");
  });
  await expect(
    interruptNativeQueuedInput(request, [NATIVE_ABORT_RESTORE_QUEUE_CAPABILITY]),
  ).rejects.toThrow("Disconnected");
  expect(request).toHaveBeenCalledOnce();
});

describe("nativeQueuedDraft", () => {
  it("recovers remote media independently of local draft memory and remints repeated context identities", () => {
    let next = 0;
    const draft = nativeQueuedDraft(
      target,
      [
        { text: message([imageRecord, fileRecord]), images: [image] },
        { text: message([imageRecord, fileRecord]), images: [image] },
      ],
      () => `restored-${++next}`,
    );
    expect(draft.records).toHaveLength(4);
    expect(new Set(draft.records.map((record) => record.contextId)).size).toBe(4);
    expect(
      collectComposerContextReferences(draft.text).map((reference) => reference.contextId),
    ).toEqual(draft.records.map((record) => record.contextId));
    expect(draft.media.map((media) => media.resource)).toEqual([
      { _tag: "attachment", attachmentId: "durable-image", fileName: "shot.png" },
      { _tag: "attachment", attachmentId: "durable-file", fileName: "notes.txt" },
      { _tag: "attachment", attachmentId: "durable-image", fileName: "shot.png" },
      { _tag: "attachment", attachmentId: "durable-file", fileName: "notes.txt" },
    ]);
    expect(draft.media[0]?.image).toEqual(image);
  });

  it("recovers older queued files through their durable native path after the pending upload is gone", () => {
    const old = { ...fileRecord, attachmentId: "pending-expired" };
    const draft = nativeQueuedDraft(
      target,
      [{ text: `${message([old])}\n\nAttached file "notes.txt": "/uploads/native-durable.txt"` }],
      () => "restored",
    );
    expect(draft.media[0]?.resource).toEqual({
      _tag: "native-media-file",
      ref: target.ref,
      path: "/uploads/native-durable.txt",
    });
  });

  it("recovers files from pre-fix queues that contain no attachment metadata at all", () => {
    let next = 0;
    const draft = nativeQueuedDraft(
      target,
      [
        {
          text: 'Inspect these\n\nAttached file "notes.txt": "/uploads/first.txt"\n\nAttached file "notes.txt": "/uploads/second.txt"',
          images: [image],
        },
      ],
      () => `restored-${++next}`,
    );
    expect(draft.media.map((media) => media.record.kind)).toEqual(["file", "file", "image"]);
    expect(draft.media.slice(0, 2).map((media) => media.resource)).toEqual([
      { _tag: "native-media-file", ref: target.ref, path: "/uploads/first.txt" },
      { _tag: "native-media-file", ref: target.ref, path: "/uploads/second.txt" },
    ]);
    expect(collectComposerContextReferences(draft.text)).toHaveLength(3);
  });

  it("keeps TUI images and correctly associates uploaded images following inline ones", () => {
    const inline = { ...image, data: "eHl6", mimeType: "image/webp" };
    let next = 0;
    const draft = nativeQueuedDraft(
      target,
      [{ text: message([imageRecord]), images: [inline, image] }],
      () => `restored-${++next}`,
    );
    expect(draft.media.map((media) => media.image)).toEqual([image, inline]);
    expect(collectComposerContextReferences(draft.text)).toHaveLength(2);
  });

  it("keeps image-only TUI input visible and recoverable", () => {
    const draft = nativeQueuedDraft(target, [{ text: "", images: [image] }], () => "restored");
    expect(draft.media).toHaveLength(1);
    expect(draft.media[0]?.record.sizeBytes).toBe(3);
    expect(collectComposerContextReferences(draft.text)).toHaveLength(1);
  });
});
