import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  ComposerContextId,
  EnvironmentId,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type FileContextRecord,
  type ImageContextRecord,
  type PreviewAnnotationContextRecord,
  type TerminalContextRecord,
} from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { composerTargetKey, useComposerDraftStore } from "../../composerDraftStore";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { pendingDraftWork } from "../chat/pendingDraftWork";
import { restoreNativeQueuedDraft } from "./neopiNativeQueueDraft";
import type * as AttachmentUploads from "../../lib/attachmentUploadQueue";
import type * as ChatViewLogic from "../ChatView.logic";

vi.mock("../../lib/attachmentUploadQueue", async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentUploads>()),
  startAttachmentUpload: vi.fn(),
}));
vi.mock("../ChatView.logic", async (importOriginal) => ({
  ...(await importOriginal<typeof ChatViewLogic>()),
  readFileAsDataUrl: async (file: File) => {
    const bytes = await file.arrayBuffer();
    return `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
  },
}));

const target = {
  environmentId: EnvironmentId.make("remote"),
  ref: { providerInstanceId: ProviderInstanceId.make("native"), sessionFile: "/sessions/a.jsonl" },
};
const key = composerTargetKey(target);
const initial = useComposerDraftStore.getState();
afterEach(() => useComposerDraftStore.setState(initial, true));
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
  sizeBytes: 5,
  attachmentId: "durable-file",
};
const queuedText = serializeLegacyContextMessage({
  text: `Inspect ${formatComposerContextReference(imageRecord)} ${formatComposerContextReference(fileRecord)}`,
  records: [imageRecord, fileRecord],
});

it("restores queued images and files from another window while keeping newer draft edits", async () => {
  useComposerDraftStore.getState().setPrompt(target, "newer draft");
  const notice = await restoreNativeQueuedDraft(
    target,
    {
      messages: [
        { text: queuedText, images: [{ type: "image", mimeType: "image/png", data: "YWJj" }] },
      ],
    },
    async (_target, media) => {
      expect(media.resource).toEqual({
        _tag: "attachment",
        attachmentId: "durable-file",
        fileName: "notes.txt",
      });
      expect(pendingDraftWork.has(key)).toBe(true);
      useComposerDraftStore.getState().setPrompt(target, "newer draft, typed while downloading");
      return new Blob(["notes"], { type: "text/plain" });
    },
  );
  const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
  expect(notice).toBeNull();
  expect(draft.prompt).toContain("Inspect");
  expect(draft.prompt.endsWith("\n\nnewer draft, typed while downloading")).toBe(true);
  expect(draft.images).toHaveLength(1);
  expect(draft.images[0]?.name).toBe("shot.png");
  expect(await draft.images[0]!.file.text()).toBe("abc");
  expect(draft.files).toHaveLength(1);
  expect(await draft.files[0]!.file!.text()).toBe("notes");
  expect(
    collectComposerContextReferences(draft.prompt).map((reference) => reference.contextId),
  ).toEqual([`image_${draft.images[0]!.id}`, `file_${draft.files[0]!.id}`]);
  expect(pendingDraftWork.has(key)).toBe(false);
});

it("retains every withdrawn image above the normal attachment cap without losing the existing draft", async () => {
  useComposerDraftStore.getState().setPrompt(target, "keep this");
  const images = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 2 }, () => ({
    type: "image" as const,
    mimeType: "image/png",
    data: "YWJj",
  }));
  await restoreNativeQueuedDraft(target, { messages: [{ text: "", images }] });
  const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
  expect(draft.images).toHaveLength(images.length);
  expect(draft.prompt.endsWith("\n\nkeep this")).toBe(true);
  expect(new Set(draft.images.map((image) => image.id)).size).toBe(images.length);
});

it("preserves terminal context and the annotation screenshot association when the restored draft is sent again", async () => {
  const annotation: PreviewAnnotationContextRecord = {
    version: 1,
    kind: "preview-annotation",
    contextId: ComposerContextId.make("preview-annotation_original"),
    annotationId: "original",
    label: "Selection",
    pageUrl: "https://example.com",
    pageTitle: null,
    comment: "Fix this",
    targetSummary: "",
    styleChanges: [],
    screenshotContextId: imageRecord.contextId,
  };
  const terminal: TerminalContextRecord = {
    version: 1,
    kind: "terminal",
    contextId: ComposerContextId.make("terminal_original"),
    label: "Build",
    terminalId: "main",
    terminalLabel: "Terminal",
    lineStart: 1,
    lineEnd: 1,
    text: "build failed",
  };
  const records = [annotation, terminal, imageRecord];
  const text = serializeLegacyContextMessage({
    text: records.map(formatComposerContextReference).join(" "),
    records,
  });
  await restoreNativeQueuedDraft(target, {
    messages: [{ text, images: [{ type: "image", data: "YWJj", mimeType: "image/png" }] }],
  });
  const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
  expect(draft.terminalContexts[0]?.text).toBe("build failed");
  expect(draft.previewAnnotations[0]?.id).toBe(draft.images[0]?.id);
  const context = buildMessageContext({
    terminalContexts: draft.terminalContexts,
    previewAnnotations: draft.previewAnnotations,
    reviewComments: draft.reviewComments,
    attachments: draft.images.map((attachment) => ({ attachment, attachmentId: "new-upload" })),
  });
  const rebuiltAnnotation = context?.records.find((record) => record.kind === "preview-annotation");
  const rebuiltImage = context?.records.find((record) => record.kind === "image");
  expect(rebuiltAnnotation).toHaveProperty("screenshotContextId", rebuiltImage?.contextId);
});

it("retains an explicit reattach marker and reports missing bytes rather than silently dropping a file", async () => {
  const text = serializeLegacyContextMessage({
    text: formatComposerContextReference(fileRecord),
    records: [fileRecord],
  });
  const notice = await restoreNativeQueuedDraft(target, { messages: [{ text }] }, async () => {
    throw new Error("Unavailable");
  });
  const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
  expect(notice).toContain("notes.txt");
  expect(draft.files[0]).toMatchObject({ name: "notes.txt", file: null });
  expect(collectComposerContextReferences(draft.prompt)[0]?.contextId).toBe(
    `file_${draft.files[0]!.id}`,
  );
});

it("restores a signed-asset image when the native response omits oversized inline bytes", async () => {
  const text = serializeLegacyContextMessage({
    text: formatComposerContextReference(imageRecord),
    records: [imageRecord],
  });
  await restoreNativeQueuedDraft(
    target,
    { messages: [{ text }], imagesDropped: true },
    async () => new Blob(["remote"], { type: "image/png" }),
  );
  const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
  const preview = draft.images[0]!.previewUrl;
  expect(draft.images[0]?.sizeBytes).toBe(6);
  expect(preview).toBe("data:image/png;base64,cmVtb3Rl");
  useComposerDraftStore.getState().removeImage(target, draft.images[0]!.id);
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.images).toEqual([]);
});
