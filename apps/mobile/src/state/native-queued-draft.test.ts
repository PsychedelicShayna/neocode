import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  ComposerContextId,
  EnvironmentId,
  ProviderInstanceId,
  type FileContextRecord,
  type ImageContextRecord,
} from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";

const mocks = vi.hoisted(() => ({
  recovered: vi.fn(),
  importing: vi.fn(),
  flush: vi.fn(),
  execute: vi.fn(),
  download: vi.fn(),
  persist: vi.fn(),
  dispose: vi.fn(),
  sequence: 0,
}));
vi.mock("./use-composer-drafts", () => ({
  flushComposerDrafts: mocks.flush,
  prependRecoveredComposerDraft: mocks.recovered,
  setComposerContextImporting: mocks.importing,
  waitForComposerDraftsLoaded: async () => {},
}));
vi.mock("./atom-registry", () => ({
  appAtomRegistry: {
    get: () => ({ _tag: "Some", value: { httpBaseUrl: "https://source.example" } }),
  },
}));
vi.mock("./session", () => ({ environmentSession: { preparedConnectionValueAtom: vi.fn() } }));
vi.mock("./assets", () => ({ assetEnvironment: { createUrl: (input: unknown) => input } }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.execute,
  squashAtomCommandFailure: () => new Error("offline"),
}));
vi.mock("../lib/attachmentDownload", () => ({ downloadAttachmentForPreview: mocks.download }));
vi.mock("../lib/composerImages", () => ({ persistComposerAttachmentFile: mocks.persist }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => `restored-${++mocks.sequence}` }));
vi.mock("expo-file-system", () => ({
  File: class {
    size = 5;
  },
}));

import { restoreNativeMobileQueuedDraft } from "./native-queued-draft";

const target = {
  environmentId: EnvironmentId.make("remote"),
  ref: { providerInstanceId: ProviderInstanceId.make("native"), sessionFile: "/sessions/a.jsonl" },
};
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sequence = 0;
  mocks.execute.mockResolvedValue({
    _tag: "Success",
    value: { relativeUrl: "/assets/durable-file" },
  });
  mocks.download.mockResolvedValue({ uri: "file:///cached.txt", dispose: mocks.dispose });
  mocks.persist.mockResolvedValue("file:///documents/restored.txt");
  mocks.flush.mockResolvedValue(undefined);
});

it("restores cross-device images and copies durable files into owned mobile storage", async () => {
  const records = [imageRecord, fileRecord];
  const text = serializeLegacyContextMessage({
    text: records.map(formatComposerContextReference).join(" "),
    records,
  });
  expect(
    await restoreNativeMobileQueuedDraft(target, {
      messages: [{ text, images: [{ type: "image", mimeType: "image/png", data: "YWJj" }] }],
    }),
  ).toBeNull();
  const content = mocks.recovered.mock.calls[0]?.[1];
  expect(content.attachments).toEqual([
    expect.objectContaining({
      type: "image",
      id: "image_restored-1",
      dataUrl: "data:image/png;base64,YWJj",
      name: "shot.png",
    }),
    expect.objectContaining({
      type: "file",
      id: "file_restored-2",
      fileUri: "file:///documents/restored.txt",
      name: "notes.txt",
      sizeBytes: 5,
    }),
  ]);
  expect(
    content.context.records.map((record: { attachmentId: string }) => record.attachmentId),
  ).toEqual(["image_restored-1", "file_restored-2"]);
  expect(
    collectComposerContextReferences(content.text).map((reference) => reference.contextId),
  ).toEqual(["image_restored-1", "file_restored-2"]);
  expect(mocks.execute.mock.calls[0]?.[1].input.resource).toEqual({
    _tag: "attachment",
    attachmentId: "durable-file",
    fileName: "notes.txt",
  });
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(mocks.importing.mock.calls.map((call) => call[1])).toEqual([true, false]);
});

it("retains an unavailable attachment reference and reports its name without losing queue text", async () => {
  mocks.download.mockRejectedValue(new Error("Disconnected"));
  const text = serializeLegacyContextMessage({
    text: `queued ${formatComposerContextReference(fileRecord)}`,
    records: [fileRecord],
  });
  const notice = await restoreNativeMobileQueuedDraft(target, { messages: [{ text }] });
  const content = mocks.recovered.mock.calls[0]?.[1];
  expect(notice).toContain("notes.txt");
  expect(content.text).toContain("queued");
  expect(content.context.records[0]).toMatchObject({
    name: "notes.txt",
    attachmentId: "durable-file",
  });
  expect(content.attachments).toEqual([]);
});

it("uses the returned image's actual MIME and byte count when NeoPi transformed its input", async () => {
  const text = serializeLegacyContextMessage({
    text: formatComposerContextReference(imageRecord),
    records: [imageRecord],
  });
  await restoreNativeMobileQueuedDraft(target, {
    messages: [{ text, images: [{ type: "image", mimeType: "image/jpeg", data: "YWJjZGU=" }] }],
  });
  const content = mocks.recovered.mock.calls[0]?.[1];
  expect(content.attachments[0]).toMatchObject({ mimeType: "image/jpeg", sizeBytes: 5 });
  expect(content.context.records[0]).toMatchObject({ mimeType: "image/jpeg", sizeBytes: 5 });
});
