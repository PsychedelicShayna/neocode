import { describe, expect, it, vi } from "vite-plus/test";
import { ComposerContextId, EnvironmentId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import {
  persistComposerDraftSnapshot,
  type ComposerThreadDraftState,
} from "../../composerDraftStore";
import { terminalContextReference } from "../../lib/composerContextRecords";
import {
  captureNativeComposerFocus,
  remainingNativeDraft,
  remainingNativePersistedDraft,
} from "./neopiNativeComposer";

describe("native send focus ownership", () => {
  it("refocuses the initiating editor while it is still current", () => {
    const composer = { focusAtEnd: vi.fn() };
    const refocus = captureNativeComposerFocus({ current: composer });
    refocus();
    expect(composer.focusAtEnd).toHaveBeenCalledOnce();
  });

  it("does not focus a replacement editor after a delayed send", async () => {
    const previous = { focusAtEnd: vi.fn() };
    const next = { focusAtEnd: vi.fn() };
    const ref = { current: previous };
    const refocus = captureNativeComposerFocus(ref);
    const completion = Promise.resolve().then(refocus);
    ref.current = next;
    await completion;
    expect(previous.focusAtEnd).not.toHaveBeenCalled();
    expect(next.focusAtEnd).not.toHaveBeenCalled();
  });

  it("does nothing after the editor unmounts", () => {
    const composer = { focusAtEnd: vi.fn() };
    const ref: { current: typeof composer | null } = { current: composer };
    const refocus = captureNativeComposerFocus(ref);
    ref.current = null;
    refocus();
    expect(composer.focusAtEnd).not.toHaveBeenCalled();
  });
});

const draft = (changes: Partial<ComposerThreadDraftState> = {}): ComposerThreadDraftState => ({
  prompt: "Explain the output",
  images: [],
  files: [],
  nonPersistedImageIds: [],
  persistedAttachments: [],
  terminalContexts: [],
  previewAnnotations: [],
  reviewComments: [],
  modelSelectionByProvider: {},
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
  ...changes,
});
const selection = {
  id: "selected-lines",
  threadId: "native:resource",
  terminalId: "default",
  terminalLabel: "Terminal",
  lineStart: 1,
  lineEnd: 2,
  text: "original output",
  createdAt: "2026-10-29T00:00:00.000Z",
};
const terminalReference = terminalContextReference(selection);
const reference = formatComposerContextReference({
  ...terminalReference,
  contextId: ComposerContextId.make(terminalReference.contextId),
});
const imageFile = new File(["image"], "capture.png", { type: "image/png" });
const image = {
  type: "image" as const,
  id: "capture",
  name: imageFile.name,
  mimeType: imageFile.type,
  sizeBytes: imageFile.size,
  file: imageFile,
  previewUrl: "data:image/png;base64,aW1hZ2U=",
};
const file = new File(["notes"], "notes.txt", { type: "text/plain" });
const attachment = {
  type: "file" as const,
  id: "notes",
  name: file.name,
  mimeType: file.type,
  sizeBytes: file.size,
  file,
};

describe("accepted native composer snapshots", () => {
  it("consumes the accepted prefix and uploaded file while retaining appended text and new media", () => {
    const submitted = draft({
      files: [attachment],
      terminalContexts: [selection],
      prompt: `Explain ${reference}`,
    });
    const uploadedFile = {
      ...attachment,
      uploadedAttachmentId: "pending-upload",
      uploadEnvironmentId: EnvironmentId.make("remote"),
    };
    const current = {
      ...submitted,
      prompt: submitted.prompt + "\nNext question",
      files: [uploadedFile],
      images: [image],
      nonPersistedImageIds: [image.id],
    };
    const remaining = remainingNativeDraft(current, submitted);
    expect(remaining.prompt).toBe("\nNext question");
    expect(remaining.files).toEqual([]);
    expect(remaining.terminalContexts).toEqual([]);
    expect(remaining.images).toEqual([image]);
    expect(remaining.nonPersistedImageIds).toEqual([image.id]);
  });

  it("retains the whole revised draft when accepted text was edited during the send", () => {
    const submitted = draft({
      images: [image],
      files: [attachment],
      terminalContexts: [selection],
      prompt: `Explain ${reference}`,
    });
    const current = { ...submitted, prompt: `Actually compare ${reference}` };
    expect(remainingNativeDraft(current, submitted)).toEqual(current);
  });

  it("retains the prompt when a captured context record was revised without changing its reference", () => {
    const submitted = draft({ terminalContexts: [selection], prompt: `Explain ${reference}` });
    const current = {
      ...submitted,
      terminalContexts: [{ ...selection, text: "revised selection" }],
    };
    expect(remainingNativeDraft(current, submitted)).toEqual(current);
  });

  it("retains an accepted context explicitly referenced again in newly appended text", () => {
    const submitted = draft({ terminalContexts: [selection], prompt: `Explain ${reference}` });
    const current = { ...submitted, prompt: `${submitted.prompt}\nNow compare ${reference}` };
    const remaining = remainingNativeDraft(current, submitted);
    expect(remaining.prompt).toBe(`\nNow compare ${reference}`);
    expect(remaining.terminalContexts).toEqual([selection]);
  });

  it("consumes unchanged records after persistence changes their object identity and property order", () => {
    const submitted = draft({ terminalContexts: [selection], prompt: `Explain ${reference}` });
    const persisted = JSON.parse(JSON.stringify(persistComposerDraftSnapshot(submitted)));
    const restoredSelection = persisted.terminalContexts[0];
    const current = draft({
      prompt: `${submitted.prompt}\nNext question`,
      terminalContexts: [{ ...restoredSelection }],
    });
    const remaining = remainingNativePersistedDraft(current, persisted);
    expect(remaining.prompt).toBe("\nNext question");
    expect(remaining.terminalContexts).toEqual([]);
  });

  it("keeps a same-ID terminal record revision when a different window accepts its old version", () => {
    const submitted = draft({ terminalContexts: [selection], prompt: `Explain ${reference}` });
    const persisted = persistComposerDraftSnapshot(submitted)!;
    const current = {
      ...submitted,
      terminalContexts: [{ ...selection, text: "new selection captured during send" }],
    };
    expect(remainingNativePersistedDraft(current, persisted)).toBe(current);
  });

  it("does not consume a same-ID local file replacement during send", () => {
    const submitted = draft({ files: [attachment] });
    const current = {
      ...submitted,
      files: [{ ...attachment, file: new File(["revised"], file.name, { type: file.type }) }],
    };
    expect(remainingNativeDraft(current, submitted)).toBe(current);
  });

  it("consumes durable accepted media across windows but retains new media and suffix references", () => {
    const environmentId = EnvironmentId.make("remote");
    const acceptedFile = {
      ...attachment,
      uploadedAttachmentId: "accepted-file",
      uploadEnvironmentId: environmentId,
    };
    const persistedImage = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: image.previewUrl,
    };
    const submitted = draft({
      images: [image],
      files: [acceptedFile],
      persistedAttachments: [persistedImage],
      terminalContexts: [selection],
      prompt: `Explain ${reference}`,
    });
    const current = {
      ...submitted,
      prompt: `${submitted.prompt}\nReuse ${reference}`,
      images: [
        { ...image, file: new File(["image"], image.name, { type: image.mimeType }) },
        { ...image, id: "new-image" },
      ],
      files: [
        { ...acceptedFile, file: null },
        { ...acceptedFile, id: "new-file", uploadedAttachmentId: "new-upload" },
      ],
    };
    const remaining = remainingNativePersistedDraft(
      current,
      JSON.parse(JSON.stringify(persistComposerDraftSnapshot(submitted))),
      new Map([[current.images[0]!.file, image.previewUrl]]),
    );
    expect(remaining.prompt).toBe(`\nReuse ${reference}`);
    expect(remaining.images.map((entry) => entry.id)).toEqual(["new-image"]);
    expect(remaining.files.map((entry) => entry.id)).toEqual(["new-file"]);
    expect(remaining.terminalContexts).toEqual([selection]);
    expect(remaining.persistedAttachments).toEqual([]);
  });

  it("preserves durable same-ID media replacements in the observing window", () => {
    const environmentId = EnvironmentId.make("remote");
    const submitted = draft({
      images: [image],
      persistedAttachments: [
        {
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: image.previewUrl,
        },
      ],
      files: [
        {
          ...attachment,
          uploadedAttachmentId: "accepted-file",
          uploadEnvironmentId: environmentId,
        },
      ],
    });
    const current = {
      ...submitted,
      images: [{ ...image, file: new File(["changed"], image.name, { type: image.mimeType }) }],
      persistedAttachments: [
        {
          ...submitted.persistedAttachments[0]!,
          dataUrl: "data:image/png;base64,Y2hhbmdlZA==",
        },
      ],
      files: [
        {
          ...submitted.files[0]!,
          uploadedAttachmentId: "replacement-file",
        },
      ],
    };
    const remaining = remainingNativePersistedDraft(
      current,
      persistComposerDraftSnapshot(submitted)!,
      new Map([[current.images[0]!.file, "data:image/png;base64,Y2hhbmdlZA=="]]),
    );
    expect(remaining.prompt).toBe("");
    expect(remaining.images).toEqual(current.images);
    expect(remaining.files).toEqual(current.files);
    expect(remaining.persistedAttachments).toEqual(current.persistedAttachments);
  });
});
